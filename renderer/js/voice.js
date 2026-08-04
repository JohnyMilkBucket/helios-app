// renderer/js/voice.js
// WebRTC voice mesh, signaled over Firebase Realtime Database.
//
// Design:
// - Shares the host page's already-initialized Realtime Database instance
//   (via setRtdb) instead of creating a second, conflicting Firebase app.
// - The caller supplies the local mic MediaStream (acquired once, reused
//   across every channel/net you join) — this module never calls
//   getUserMedia itself, so mute/PTT/device-selection stay single-sourced
//   in the host page instead of drifting out of sync with a second stream.
// - Only the JOINING peer ever sends an offer; everyone already present just
//   answers. That avoids glare (both sides offering at once) without needing
//   perfect-negotiation logic.
// - Presence removal (onChildRemoved) triggers immediate peer cleanup on the
//   remote side, instead of waiting ~20-30s for ICE to notice a dead link.
// - onDisconnect() registers server-side cleanup for presence, so a crash or
//   force-quit doesn't leave a ghost "still in the channel" entry behind.

import {
  ref, set, push, remove, onValue, onChildAdded, onChildRemoved, onDisconnect,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js'

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    // Self-hosted coturn — relay fallback for when a direct P2P path can't
    // be established (strict NATs, restrictive firewalls, etc.)
    {
      urls: [
        'turn:64.227.93.16:3478',
        'turn:64.227.93.16:3478?transport=tcp',
      ],
      username: 'heliosuser',
      credential: 'Ieatsand2019',
    },
  ]
}

let localUid = null
let rtdb = null

// chanId -> { peers: Map<peerId, RTCPeerConnection>, unsubs: [fn], myPresenceRef, onPeerStream, onPeerLeave }
const activeChannels = new Map()

export function initVoice(uid) { localUid = uid }
export function setRtdb(instance) { rtdb = instance }

// Logs which actual network path a connection settled on — direct
// peer-to-peer (host/srflx, i.e. no server involved), or relayed through our
// TURN server, and over UDP or TCP. "Connected" alone doesn't tell you this;
// a relay-over-TCP path is far more likely to be the one that later drops,
// so this is the difference between "it's flaky in general" and "it's
// specifically the TCP TURN fallback that's unreliable".
async function logActiveCandidatePair(pc, peerId) {
  try {
    const stats = await pc.getStats()
    let pair = null
    stats.forEach(r => { if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) pair = r })
    if (!pair) return
    const local = stats.get(pair.localCandidateId)
    const remote = stats.get(pair.remoteCandidateId)
    console.log(
      `[voice] ${peerId} active path: local=${local?.candidateType}/${local?.protocol} ` +
      `remote=${remote?.candidateType}/${remote?.protocol}` +
      (local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? ' (via TURN relay)' : ' (direct P2P)')
    )
  } catch (e) {}
}

function basePath(cardId, chanId) { return `rtc/${cardId}/${chanId}` }

// ── JOIN ──────────────────────────────────────────────────────────────────
// callbacks: { onPeerStream(peerId, mediaStream), onPeerLeave(peerId) }
export async function joinChannel(cardId, chanId, callbacks = {}, stream) {
  if (activeChannels.has(chanId)) return
  if (!rtdb) throw new Error('voice: setRtdb() was never called')
  if (!stream) throw new Error('voice: joinChannel requires a local mic stream')

  const { onPeerStream, onPeerLeave } = callbacks
  const base = basePath(cardId, chanId)
  // peerId -> { pc, isInitiator, retries }
  const peers = new Map()
  const MAX_RETRIES = 3

  function closePeer(peerId) {
    const rec = peers.get(peerId)
    if (rec) {
      try { rec.pc.close() } catch (e) {}
      peers.delete(peerId)
    }
    lastStatsByPeer.delete(`${chanId}:${peerId}`)
    onPeerLeave?.(peerId)
  }

  // A connection that reaches "connected" then later drops (NAT rebinding,
  // wifi hiccup, etc.) is common and usually recoverable — only the side
  // that originally initiated the connection retries, so both sides don't
  // race to reconnect and end up with duplicate connections.
  function scheduleRetry(peerId, rec) {
    if (!rec.isInitiator) return
    if (rec.retries >= MAX_RETRIES) {
      console.log(`[voice] ${peerId}: giving up after ${MAX_RETRIES} reconnect attempts`)
      closePeer(peerId)
      return
    }
    const attempt = rec.retries + 1
    console.log(`[voice] ${peerId}: connection dropped, retrying (${attempt}/${MAX_RETRIES})`)
    peers.delete(peerId)
    try { rec.pc.close() } catch (e) {}
    onPeerLeave?.(peerId) // drop their audio node while we reconnect
    setTimeout(() => { offerTo(peerId, attempt) }, 1000 * attempt)
  }

  async function sendSignal(targetId, data) {
    await push(ref(rtdb, `${base}/signals/${targetId}`), data).catch(() => {})
  }

  function createPeerConnection(peerId, isInitiator, retries = 0) {
    const pc = new RTCPeerConnection(ICE_SERVERS)
    const rec = { pc, isInitiator, retries }
    peers.set(peerId, rec)

    stream.getTracks().forEach(t => pc.addTrack(t, stream))

    pc.ontrack = e => onPeerStream?.(peerId, e.streams[0])

    pc.onicecandidate = e => {
      if (e.candidate) sendSignal(peerId, { type: 'ice', from: localUid, candidate: e.candidate.toJSON() })
    }

    pc.onconnectionstatechange = () => {
      console.log(`[voice] ${peerId} connectionState -> ${pc.connectionState}`)
      if (pc.connectionState === 'connected') {
        rec.retries = 0 // fully recovered — reset the counter
        logActiveCandidatePair(pc, peerId) // which path is this actually using?
      } else if (pc.connectionState === 'failed') {
        scheduleRetry(peerId, rec)
      } else if (pc.connectionState === 'closed') {
        closePeer(peerId)
      } else if (pc.connectionState === 'disconnected') {
        // Transient — WebRTC recovers from this on its own constantly (brief
        // network blips, wifi hiccups). Give it a real grace period before
        // deciding it's actually dead and worth retrying.
        setTimeout(() => {
          if (peers.get(peerId) === rec && pc.connectionState === 'disconnected') scheduleRetry(peerId, rec)
        }, 6000)
      }
    }

    pc.oniceconnectionstatechange = () => {
      console.log(`[voice] ${peerId} iceConnectionState -> ${pc.iceConnectionState}`)
    }

    return pc
  }

  async function offerTo(peerId, retries = 0) {
    if (peers.has(peerId)) return
    const pc = createPeerConnection(peerId, true, retries)
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await sendSignal(peerId, { type: 'offer', from: localUid, sdp: offer.sdp })
  }

  async function handleOffer(peerId, signal) {
    // If we still have a (now-dead) connection from this peer's previous
    // attempt, drop it before building the replacement.
    if (peers.has(peerId)) {
      try { peers.get(peerId).pc.close() } catch (e) {}
      peers.delete(peerId)
    }
    const pc = createPeerConnection(peerId, false)
    await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp })
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    await sendSignal(peerId, { type: 'answer', from: localUid, sdp: answer.sdp })
  }

  // Announce presence, and make sure it's cleared server-side even if we
  // crash / lose network / force-quit without a clean leaveChannel() call.
  const myPresenceRef = ref(rtdb, `${base}/peers/${localUid}`)
  onDisconnect(myPresenceRef).remove()
  await set(myPresenceRef, { uid: localUid, joined: Date.now() })

  // Deterministic initiator selection: whichever of a pair has the
  // lexicographically smaller uid always offers, the other always answers.
  // Deciding this from "who joined first" (a live get() race) let two people
  // joining at nearly the same instant both end up offering to each other
  // at once (glare) — both sides would tear down their own offer connection
  // to answer the other's, leaving neither with a connection actually
  // waiting for the answer, so the pair never stabilizes. Comparing fixed
  // uids removes the race: any two peers reasoning about the same pair
  // always agree on who initiates, no matter the join timing.
  // onChildAdded fires once for every peer already present the instant this
  // listener attaches, then again for each new arrival — so this alone
  // covers both "peers already in the channel" and "peers who join later".
  const presenceAddedUnsub = onChildAdded(ref(rtdb, `${base}/peers`), snap => {
    const peerId = snap.key
    if (peerId === localUid || peers.has(peerId)) return
    if (localUid < peerId) offerTo(peerId)
    // else: their uid is smaller, so THEY offer to us — handled by the
    // signal listener below when their 'offer' arrives.
  })

  // A peer's presence disappearing means they left (or dropped) — clean up
  // immediately rather than waiting on WebRTC's own timeout.
  const presenceGoneUnsub = onChildRemoved(ref(rtdb, `${base}/peers`), snap => {
    if (snap.key !== localUid) closePeer(snap.key)
  })

  // Signals addressed to us
  const signalUnsub = onChildAdded(ref(rtdb, `${base}/signals/${localUid}`), async snap => {
    const signal = snap.val()
    const senderId = signal?.from
    try {
      if (signal.type === 'offer') {
        await handleOffer(senderId, signal)
      } else if (signal.type === 'answer') {
        const rec = peers.get(senderId)
        // Only valid if we're actually mid-negotiation as the offerer — a
        // stray/late-arriving answer (e.g. from a connection that already
        // got replaced) would otherwise throw "wrong state: stable" as an
        // uncaught rejection instead of just being ignored.
        if (rec && rec.pc.signalingState === 'have-local-offer') {
          await rec.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp })
        }
      } else if (signal.type === 'ice') {
        const rec = peers.get(senderId)
        if (rec && signal.candidate) await rec.pc.addIceCandidate(signal.candidate).catch(() => {})
      }
    } finally {
      remove(snap.ref).catch(() => {})
    }
  })

  activeChannels.set(chanId, {
    peers, myPresenceRef,
    unsubs: [presenceAddedUnsub, presenceGoneUnsub, signalUnsub],
  })
}

// ── LEAVE ─────────────────────────────────────────────────────────────────
export async function leaveChannel(cardId, chanId) {
  const ch = activeChannels.get(chanId)
  if (!ch) return

  ch.unsubs.forEach(unsub => { try { unsub() } catch (e) {} })
  ch.peers.forEach(pc => { try { pc.close() } catch (e) {} })

  await Promise.all([
    remove(ch.myPresenceRef).catch(() => {}),
    remove(ref(rtdb, `${basePath(cardId, chanId)}/signals/${localUid}`)).catch(() => {}),
  ])

  activeChannels.delete(chanId)
}

export async function leaveAllChannels(cardId) {
  for (const chanId of [...activeChannels.keys()]) {
    await leaveChannel(cardId, chanId)
  }
}

export function getActiveChannels() {
  return [...activeChannels.keys()]
}

// ── LIVE AUDIO DIAGNOSTICS ──────────────────────────────────────────────────
// "Connected" (ICE state) only proves a data path exists — it says nothing
// about whether actual voice packets are moving. This reads the real WebRTC
// stats for every peer in a channel so the UI can show, per peer, whether
// audio bytes are actively flowing right now in each direction:
//   tx: bytes we're sending them is increasing        (our mic -> them)
//   rx: bytes/audio energy we're receiving is present  (them -> our speakers)
// Call once per "tick" (e.g. every ~1s) from the host page; deltas are
// computed against the previous call, so the first call after joining will
// always report inactive until a second sample comes in.
const lastStatsByPeer = new Map() // `${chanId}:${peerId}` -> { bytesSent, bytesReceived }

export async function getChannelAudioStats(chanId) {
  const ch = activeChannels.get(chanId)
  if (!ch) return []

  const results = []
  for (const [peerId, rec] of ch.peers) {
    const key = `${chanId}:${peerId}`
    const prev = lastStatsByPeer.get(key) || { bytesSent: 0, bytesReceived: 0 }
    let bytesSent = prev.bytesSent, bytesReceived = prev.bytesReceived, rxAudioLevel = 0

    try {
      const stats = await rec.pc.getStats()
      stats.forEach(report => {
        if (report.type === 'outbound-rtp' && report.kind === 'audio') {
          bytesSent = report.bytesSent ?? bytesSent
        } else if (report.type === 'inbound-rtp' && report.kind === 'audio') {
          bytesReceived = report.bytesReceived ?? bytesReceived
          rxAudioLevel = report.audioLevel ?? 0
        }
      })
    } catch (e) { /* connection may have just closed — skip this tick */ }

    results.push({
      peerId,
      connectionState: rec.pc.connectionState,
      txActive: bytesSent > prev.bytesSent,
      rxActive: bytesReceived > prev.bytesReceived && rxAudioLevel > 0.01,
    })
    lastStatsByPeer.set(key, { bytesSent, bytesReceived })
  }
  return results
}

// ── PRESENCE (optional — who else is actually connected to this net) ──────
export function listenChannelPresence(cardId, chanId, callback) {
  const presRef = ref(rtdb, `${basePath(cardId, chanId)}/peers`)
  return onValue(presRef, snap => {
    callback(snap.exists() ? Object.keys(snap.val()) : [])
  })
}
