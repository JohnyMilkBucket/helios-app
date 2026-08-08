// renderer/js/comms.js
// Radio/voice: channel join/leave, PTT, ear routing, mic device + test,
// live audio diagnostics. Wraps renderer/js/voice.js (the actual WebRTC
// mesh) with the UI-facing state and actions index.html used to own inline.
//
// Unlike medical.js/roles.js/orbat.js, none of this state is synced through
// Firestore — channel *definitions* are (rarely-edited, no incremental-field
// races), but live join/PTT/presence state here is pure client-local
// WebRTC/audio state. There's nothing for a listener to race against, so
// this module doesn't need the single-writer-per-Firestore-field discipline
// the others do (see ARCHITECTURE.md's "What does not need this treatment"
// section) — it's extracted purely for the same file-per-feature
// organization the other systems already have.

import {
  joinChannel as voiceJoin, leaveChannel as voiceLeave, listenChannelPresence, getChannelAudioStats,
} from './voice.js'

export const MAX_CHANNELS = 2

// ── MODULE STATE ──────────────────────────────────────────────────────────
// Plain objects/Sets that index.html grabs a reference to ONCE (getX()) and
// keeps forever — this module mutates them in place (add/delete/assign),
// never reassigns them, so index.html's reference never goes stale. Exactly
// the same reference-sharing trick medical.js uses for S.self.
const C = {
  activeChanIds: new Set(),
  radioSlots: {}, // chanId -> { ear, peerNodes, txStream, transmitting, presentUids, presenceUnsub, audioStats }
  localStream: null,
  muted: false,
  micDeviceId: null,
  spkDeviceId: null,
  radioVolume: 100,
  radioPTTKeys: { left: 'BracketLeft', right: 'BracketRight' },
  // Human-readable labels for the keys above — kept in sync alongside
  // radioPTTKeys (see listenRadioPTTKey/unbindRadioPTTKey) so the "HOLD X TO
  // TRANSMIT" hint on the active-radio-slots panel reflects whatever the
  // player actually rebound, instead of always showing the [ / ] defaults.
  radioPTTKeyLabels: { left: '[', right: ']' },
  earTestKeys: { left: null, right: null },
}
const radioPTTHeld = { left: false, right: false }
let radioPTTListening = null
let earKeyListening = null

let cardId = null
let hooks = {}
let audioCtx = null
function getAudioCtx() {
  if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AudioContext()
  return audioCtx
}

export function getActiveChanIds() { return C.activeChanIds }
export function getRadioSlots() { return C.radioSlots }
export function getMuted() { return C.muted }
export function getRadioPTTKeys() { return C.radioPTTKeys }
export function getRadioPTTKeyLabels() { return C.radioPTTKeyLabels }
export function getEarTestKeys() { return C.earTestKeys }

// hooks: { onChange(), isIncapacitated(), sfx(name), callout(text),
//          openInlineModal(id, html), noiseSuppressionEnabled() }
export function initComms(cardIdArg, hooksArg) {
  cardId = cardIdArg
  hooks = hooksArg

  // Polls real getStats() byte counters for every active net once a second
  // and stashes the result on each radio slot so the members list can show
  // a live TX/RX badge next to each connected person.
  setInterval(async () => {
    if (!C.activeChanIds.size) return
    let changed = false
    for (const chanId of C.activeChanIds) {
      const slot = C.radioSlots[chanId]
      if (!slot) continue
      try {
        const stats = await getChannelAudioStats(chanId)
        slot.audioStats = Object.fromEntries(stats.map(s => [s.peerId, s]))
        changed = true
      } catch (e) {}
    }
    // Deliberately a separate hook from onChange: this fires every second
    // just to refresh TX/RX badges in the members list. onChange also
    // re-renders the active-radio-slots panel from scratch, which would
    // wipe out the transmitting-state glow that setRadioTransmitting sets
    // directly on that element via onTransmitChange — the two used to be
    // rendered on completely independent triggers before this module
    // existed, and need to stay that way.
    if (changed) hooks.onStatsChange?.()
  }, 1000)

  document.addEventListener('keydown', e => {
    if (radioPTTListening) return
    const tag = document.activeElement?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    for (const side of ['left', 'right']) {
      if (e.code === C.radioPTTKeys[side] && !radioPTTHeld[side]) {
        radioPTTHeld[side] = true
        const chanId = findRadioOnEar(side)
        if (chanId) { hooks.sfx?.('ptt-open'); setRadioTransmitting(chanId, true) }
      }
    }
  }, true)

  document.addEventListener('keyup', e => {
    for (const side of ['left', 'right']) {
      if (e.code === C.radioPTTKeys[side]) {
        radioPTTHeld[side] = false
        const chanId = findRadioOnEar(side)
        if (chanId) { hooks.sfx?.('ptt-close'); setRadioTransmitting(chanId, false) }
      }
    }
  }, true)

  document.addEventListener('keydown', e => {
    if (earKeyListening) return // currently capturing a rebind — don't also fire a test
    const tag = document.activeElement?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return // don't hijack normal typing
    if (e.code === C.earTestKeys.left) { e.preventDefault(); testEar('left') }
    else if (e.code === C.earTestKeys.right) { e.preventDefault(); testEar('right') }
  }, true)
}

// ── DEVICES ───────────────────────────────────────────────────────────────
export async function populateDevices(micSelectEl, spkSelectEl) {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const mics = devices.filter(d => d.kind === 'audioinput')
    const spks = devices.filter(d => d.kind === 'audiooutput')
    if (micSelectEl) { micSelectEl.innerHTML=''; mics.forEach(d=>{ const o=document.createElement('option'); o.value=d.deviceId; o.textContent=d.label||'Mic '+d.deviceId.slice(0,6); micSelectEl.appendChild(o) }) }
    if (spkSelectEl) { spkSelectEl.innerHTML=''; spks.forEach(d=>{ const o=document.createElement('option'); o.value=d.deviceId; o.textContent=d.label||'Speaker '+d.deviceId.slice(0,6); spkSelectEl.appendChild(o) }) }
  } catch (e) { console.log('Device enum failed:', e.message) }
}

export function applyMicDevice(deviceId) {
  C.micDeviceId = deviceId
  if (C.localStream) { C.localStream.getTracks().forEach(t=>t.stop()); C.localStream = null }
}
export function applySpeakerDevice(deviceId) { C.spkDeviceId = deviceId }

// Radio volume — applies live to every currently-connected peer across
// every joined net, and is remembered for peers who connect afterward too.
export function applyRadioVolume(v) {
  C.radioVolume = parseInt(v)
  for (const slot of Object.values(C.radioSlots)) {
    for (const nodes of slot.peerNodes.values()) {
      nodes.gain.gain.value = C.radioVolume/100
    }
  }
}

export function toggleMute() {
  C.muted = !C.muted
  if (C.localStream) C.localStream.getAudioTracks().forEach(t=>{t.enabled=!C.muted})
  // Mute is a master override: force every radio silent regardless of PTT
  // state, or (on unmute) restore each radio to match whichever PTT keys
  // are actually still held down right now.
  for (const [chanId, slot] of Object.entries(C.radioSlots)) {
    const side = (slot.ear||'left')
    const wantsToTransmit = !!radioPTTHeld[side] && findRadioOnEar(side)===chanId
    setRadioTransmitting(chanId, wantsToTransmit) // setRadioTransmitting itself re-checks C.muted
  }
  return C.muted
}

// ── MIC TEST — Discord-style live level meter, no round trip needed ───────
let micTestStream=null, micTestCtx=null, micTestAnalyser=null, micTestRAF=null

export async function toggleMicTest(barEl, onDenied) {
  if (micTestStream) { stopMicTest(barEl); return }
  try {
    micTestStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: C.micDeviceId ? {exact:C.micDeviceId} : undefined,
        noiseSuppression: hooks.noiseSuppressionEnabled?.() !== false,
        echoCancellation: true,
      }
    })
  } catch (e) {
    onDenied?.()
    return
  }

  micTestCtx = new AudioContext()
  if (micTestCtx.state==='suspended') micTestCtx.resume().catch(()=>{})
  const source = micTestCtx.createMediaStreamSource(micTestStream)
  micTestAnalyser = micTestCtx.createAnalyser()
  micTestAnalyser.fftSize = 512
  micTestAnalyser.smoothingTimeConstant = 0.6
  source.connect(micTestAnalyser)

  const data = new Uint8Array(micTestAnalyser.frequencyBinCount)
  const tick = () => {
    micTestAnalyser.getByteTimeDomainData(data)
    let sumSq = 0
    for(let i=0;i<data.length;i++) { const v=(data[i]-128)/128; sumSq += v*v }
    const rms = Math.sqrt(sumSq/data.length)
    const pct = Math.min(100, Math.round(rms*350)) // scaled so normal speech reads mid-high
    if (barEl) {
      barEl.style.width = pct+'%'
      barEl.style.background = pct>85?'#dc2626':pct>55?'#fbbf24':'#4ade80'
    }
    micTestRAF = requestAnimationFrame(tick)
  }
  tick()
  return true
}

export function stopMicTest(barEl) {
  if (micTestRAF) cancelAnimationFrame(micTestRAF)
  micTestRAF = null
  if (micTestStream) { micTestStream.getTracks().forEach(t=>t.stop()); micTestStream=null }
  if (micTestCtx) { micTestCtx.close().catch(()=>{}); micTestCtx=null }
  micTestAnalyser = null
  if (barEl) { barEl.style.width='0%'; barEl.style.background='#4ade80' }
}
export function isMicTestRunning() { return !!micTestStream }

// ── LIVE AUDIO DIAGNOSTICS ──────────────────────────────────────────────────
// A mic-input meter proves the mic itself is picking up sound (see the
// per-peer TX/RX badges in index.html's renderChanMembers for proof packets
// are actively moving on a live connection, driven by the getStats polling
// above).
let micMeterRAF=null, micMeterSource=null, micMeterAnalyser=null
function startMicMeter(stream, rowEl, barEl) {
  stopMicMeter(rowEl, barEl)
  const ctx = getAudioCtx()
  micMeterAnalyser = ctx.createAnalyser()
  micMeterAnalyser.fftSize = 512
  micMeterSource = ctx.createMediaStreamSource(stream)
  micMeterSource.connect(micMeterAnalyser)
  const data = new Uint8Array(micMeterAnalyser.frequencyBinCount)
  if (rowEl) rowEl.style.display = 'block'
  const tick = () => {
    micMeterAnalyser.getByteTimeDomainData(data)
    let peak = 0
    for(let i=0;i<data.length;i++) peak = Math.max(peak, Math.abs(data[i]-128))
    const pct = Math.min(100, (peak/128)*220) // scaled so normal speech reads mid-bar
    if (barEl) { barEl.style.width = pct+'%'; barEl.style.background = pct>85?'var(--red)':pct>8?'var(--green)':'var(--accent)' }
    micMeterRAF = requestAnimationFrame(tick)
  }
  tick()
}
function stopMicMeter(rowEl, barEl) {
  if (micMeterRAF) cancelAnimationFrame(micMeterRAF)
  micMeterRAF = null
  try { micMeterSource?.disconnect() } catch(e){}
  micMeterSource = null; micMeterAnalyser = null
  if (rowEl) rowEl.style.display = 'none'
  if (barEl) barEl.style.width = '0%'
}

// ── RADIO PUSH-TO-TALK — one key per ear, transmitting only on whichever
// radio is currently assigned to that ear. Each joined radio gets its own
// cloned mic track (see joinChannel) specifically so the two keys can
// transmit independently — holding both at once talks on both radios.
export function listenRadioPTTKey(side, onBound) {
  if (radioPTTListening) return
  radioPTTListening = side
  const handler = (e) => {
    e.preventDefault()
    C.radioPTTKeys[side] = e.code
    C.radioPTTKeyLabels[side] = e.key.toUpperCase()
    document.removeEventListener('keydown', handler, true)
    radioPTTListening = null
    onBound?.(e.key.toUpperCase())
  }
  document.addEventListener('keydown', handler, true)
}

export function unbindRadioPTTKey(side) {
  if (radioPTTListening===side) return
  C.radioPTTKeys[side] = null
  C.radioPTTKeyLabels[side] = null
  radioPTTHeld[side] = false
}

// Finds the currently-joined radio (if any) assigned to a given ear.
function findRadioOnEar(side) {
  for (const chanId of C.activeChanIds) {
    if ((C.radioSlots[chanId]?.ear||'left')===side) return chanId
  }
  return null
}

function setRadioTransmitting(chanId, on) {
  const slot = C.radioSlots[chanId]
  if (!slot?.txStream) return
  // Dead or unconscious operators can't key up, no matter what PTT/mute
  // state says — gated here so every transmit path (PTT keydown, the
  // periodic re-check loop, mute toggling) honors it uniformly.
  const incapacitated = hooks.isIncapacitated?.() || false
  const shouldTransmit = on && !C.muted && !incapacitated
  slot.txStream.getAudioTracks().forEach(t=>{ t.enabled = shouldTransmit })
  slot.transmitting = shouldTransmit
  hooks.onTransmitChange?.(chanId, shouldTransmit)
}

// Cuts any radio currently mid-transmission — used when a player becomes
// incapacitated (uncon/dead) so an already-held PTT key doesn't keep
// broadcasting until the next keyup/keydown cycle.
export function silenceAllRadios() {
  for (const chanId of Object.keys(C.radioSlots)) setRadioTransmitting(chanId, false)
}

// ── EAR TEST — plays a tone through the exact same AudioContext/
// StereoPanner pipeline attachPeerAudio() uses for real net audio, so a
// working ear test is a genuine guarantee the left/right channel routing
// itself is functional.
export function testEar(side, onFired) {
  const ctx = getAudioCtx()
  if (ctx.state==='suspended') ctx.resume().catch(()=>{})

  const osc  = ctx.createOscillator()
  const gain = ctx.createGain()
  const pan  = ctx.createStereoPanner()
  osc.type = 'sine'
  osc.frequency.value = 440
  pan.pan.value = side==='left' ? -1 : 1

  // Fade in/out so it doesn't click.
  const now = ctx.currentTime
  gain.gain.setValueAtTime(0, now)
  gain.gain.linearRampToValueAtTime(0.35, now+0.04)
  gain.gain.linearRampToValueAtTime(0, now+0.5)

  osc.connect(gain).connect(pan).connect(ctx.destination)
  osc.start(now)
  osc.stop(now+0.55)
  onFired?.()
}

export function listenEarKey(side, onBound) {
  if (earKeyListening) return
  earKeyListening = side
  const handler = (e) => {
    e.preventDefault()
    C.earTestKeys[side] = e.code
    document.removeEventListener('keydown', handler, true)
    earKeyListening = null
    onBound?.(e.key.toUpperCase())
  }
  document.addEventListener('keydown', handler, true)
}

export function unbindEarKey(side) {
  if (earKeyListening===side) return
  C.earTestKeys[side] = null
}

// ── RADIO / CHANNEL SYSTEM ────────────────────────────────────────────────
// Called when the user clicks a net card — handles join/leave/ear-select.
// canMulti/showEarSelector are passed in since they're UI/permission
// concerns index.html already owns.
export async function handleNetClick(chanId, canMulti, showEarSelector) {
  if (C.activeChanIds.has(chanId)) { leaveChannel(chanId); return }
  if (C.activeChanIds.size >= MAX_CHANNELS) return // at limit — caller's UI already shows LOCKED
  if (!canMulti && C.activeChanIds.size >= 1) {
    // Single-channel role — auto-leave current before joining.
    for (const cid of [...C.activeChanIds]) leaveChannel(cid)
  }
  if (canMulti && C.activeChanIds.size === 1) {
    showEarSelector(chanId)
  } else {
    await joinChannel(chanId, 'left')
  }
}

export async function joinChannel(chanId, ear='left') {
  if (C.activeChanIds.has(chanId)) return
  if (C.activeChanIds.size >= MAX_CHANNELS) return

  // Chrome/Electron suspend a freshly-created AudioContext until it's
  // resumed from inside a real user gesture. Create + resume it HERE, at
  // the top of the click handler, rather than waiting until a peer's audio
  // actually arrives (which happens async, off a network event, and would
  // get silently blocked — peers connect fine but nobody hears anything).
  const ctx = getAudioCtx()
  if (ctx.state === 'suspended') { try { await ctx.resume() } catch(e){} }

  // Get mic stream.
  if (!C.localStream) {
    const constraints = {
      audio: {
        deviceId: C.micDeviceId ? {exact:C.micDeviceId} : undefined,
        noiseSuppression: hooks.noiseSuppressionEnabled?.() !== false,
        echoCancellation: true,
      }
    }
    try {
      C.localStream = await navigator.mediaDevices.getUserMedia(constraints)
    } catch (e) {
      hooks.onMicError?.(e.message)
      return
    }
    if (C.muted) C.localStream.getAudioTracks().forEach(t=>{ t.enabled=false })
    startMicMeter(C.localStream, hooks.micMeterRowEl?.(), hooks.micMeterBarEl?.())
  }

  hooks.sfx?.('radio-on')
  C.activeChanIds.add(chanId)

  // Each radio gets its OWN cloned copy of the mic track (same source,
  // independently enable-able) so the left/right PTT keys can transmit on
  // one radio without also keying up the other. Starts silent — radios
  // only transmit while their assigned PTT key is held.
  const txStream = new MediaStream(C.localStream.getAudioTracks().map(t => t.clone()))
  txStream.getAudioTracks().forEach(t => { t.enabled = false })

  C.radioSlots[chanId] = { ear, peerNodes:new Map(), txStream, transmitting:false, presentUids:[], presenceUnsub:null }
  hooks.onChange?.()

  try {
    await voiceJoin(cardId, chanId, {
      onPeerStream: (peerId, remoteStream) => attachPeerAudio(chanId, peerId, remoteStream),
      onPeerLeave:  (peerId) => detachPeerAudio(chanId, peerId),
    }, txStream)

    // Real per-net roster — who is actually voice-connected to THIS radio
    // right now, not just "online in the card" (that's a different, much
    // broader list shown elsewhere).
    C.radioSlots[chanId].presenceUnsub = listenChannelPresence(cardId, chanId, uids => {
      if (C.radioSlots[chanId]) C.radioSlots[chanId].presentUids = uids
      // Only the members list depends on presentUids — same reasoning as
      // the getStats poll above, this must not re-render the active-slots
      // panel and stomp an in-progress transmit glow.
      hooks.onStatsChange?.()
    })
  } catch (e) {
    console.error('Voice join failed:', e)
    // Roll back — don't leave the UI showing "joined" when the underlying
    // connection never actually happened.
    C.activeChanIds.delete(chanId)
    txStream.getTracks().forEach(t=>t.stop())
    delete C.radioSlots[chanId]
    // Same "no channels left, stop the mic" cleanup leaveChannel does below —
    // a failed FIRST join used to skip this entirely, leaving the mic
    // actively captured (and the meter running) with zero joined channels.
    if (C.activeChanIds.size === 0 && C.localStream) {
      C.localStream.getTracks().forEach(t=>t.stop())
      C.localStream = null
      stopMicMeter(hooks.micMeterRowEl?.(), hooks.micMeterBarEl?.())
    }
    hooks.onChange?.()
    hooks.onVoiceJoinFailed?.()
  }
}

// Route one peer's incoming audio through a per-peer gain/pan node so ear
// (left/right) routing works even with multiple people on the same net.
function attachPeerAudio(chanId, peerId, remoteStream) {
  const slot = C.radioSlots[chanId]
  if (!slot) return
  // Defense in depth against voice.js's onPeerLeave/ontrack ordering ever
  // producing two attaches for the same peer without a detach in between —
  // a plain Map.set here would silently orphan the previous source/gain/pan
  // graph (still wired to ctx.destination) instead of replacing it.
  if (slot.peerNodes.has(peerId)) detachPeerAudio(chanId, peerId)
  const ctx = getAudioCtx()
  if (ctx.state === 'suspended') ctx.resume().catch(()=>{}) // belt-and-suspenders vs. autoplay blocking
  const source = ctx.createMediaStreamSource(remoteStream)
  const gain   = ctx.createGain()
  const pan    = ctx.createStereoPanner()
  gain.gain.value = (C.radioVolume??100)/100
  pan.pan.value = slot.ear === 'left' ? -1 : 1
  source.connect(gain).connect(pan).connect(ctx.destination)
  slot.peerNodes.set(peerId, { source, gain, pan, stream:remoteStream })
}

// Called the instant a peer's presence disappears (they left, crashed, or
// dropped) — cleans up just that one peer's audio without tearing down the
// whole channel.
function detachPeerAudio(chanId, peerId) {
  const slot = C.radioSlots[chanId]
  const nodes = slot?.peerNodes.get(peerId)
  if (!nodes) return
  try { nodes.source.disconnect() } catch(e){}
  try { nodes.gain.disconnect() } catch(e){}
  try { nodes.pan.disconnect() } catch(e){}
  slot.peerNodes.delete(peerId)
}

function detachChannelAudio(chanId) {
  const slot = C.radioSlots[chanId]
  if (!slot) return
  for (const { source, gain, pan } of slot.peerNodes.values()) {
    try { source.disconnect() } catch(e){}
    try { gain.disconnect() } catch(e){}
    try { pan.disconnect() } catch(e){}
  }
  slot.peerNodes.clear()
}

export function leaveChannel(chanId) {
  hooks.sfx?.('radio-off')
  C.activeChanIds.delete(chanId)
  if (C.radioSlots[chanId]) {
    detachChannelAudio(chanId)
    try { C.radioSlots[chanId].presenceUnsub?.() } catch(e){}
    C.radioSlots[chanId].txStream?.getTracks().forEach(t=>t.stop())
    delete C.radioSlots[chanId]
  }
  voiceLeave(cardId, chanId).catch(e => console.error('Voice leave failed:', e))
  // If no channels left, stop the mic stream entirely.
  if (C.activeChanIds.size === 0 && C.localStream) {
    C.localStream.getTracks().forEach(t=>t.stop())
    C.localStream = null
    stopMicMeter(hooks.micMeterRowEl?.(), hooks.micMeterBarEl?.())
  }
  hooks.onChange?.()
}

export function switchEar(chanId, newEar) {
  if (!C.radioSlots[chanId]) return
  C.radioSlots[chanId].ear = newEar
  hooks.onChange?.()
  for (const { pan } of C.radioSlots[chanId].peerNodes.values()) {
    pan.pan.value = newEar === 'left' ? -1 : 1
  }
}
