// hosting/js/medical.js
// SYNCED COPY of renderer/js/medical.js for the mobile web companion
// (Firebase Hosting has no build step, so this file must physically live
// inside the "hosting" public directory). No logic differs from the
// desktop copy — if you change treatment/injury logic there, copy it here
// too, or the two clients will disagree about game rules.
//
// Casualty/treatment system: injury rolling, bandage/tourniquet/stim/
// depressant/blood logic, the two Firestore listeners (own record + all
// patients), and the two background tickers (tourniquet clock, blood drain).
//
// History: this used to be inline in index.html. It was extracted into its
// own module once before and had to be reverted — not because splitting it
// out was wrong, but because every write in here used
// `setDoc(ref, {'zones.torso': value}, {merge:true})` — a FLAT dotted string
// key. setDoc+merge does NOT parse a flat dotted key as a nested field path
// the way updateDoc() does; it creates a literal top-level field named
// "zones.torso" (dots included) and never touches the real nested field at
// all. Every bandage/tourniquet/stim application was silently writing to a
// junk field the whole time. That bug predates this file's existence — it
// was in the original inline code too — and would have broken this module
// exactly the same way it broke the inline version, which is exactly what
// happened.
//
// Every dot-path write below uses updateDoc(). That's the actual fix. This
// file otherwise mirrors the original inline logic field-for-field on
// purpose — this is a relocation, not a redesign, to avoid trading one
// regression for another.
//
// Local state (`M.self`/`M.patients`) is mutated directly by this module's
// own action functions (applyTreatment, markDown, revive, the tickers) for
// instant local feedback, same as the original inline code — and ALSO by
// the onSnapshot listeners below, which is the "two writers" shape
// ARCHITECTURE.md warns about in general. It's safe here specifically
// because the writes now actually persist what was just computed locally,
// so the listener's eventual echo always converges to the same value — see
// ARCHITECTURE.md for the general rule and why this file is a deliberate,
// documented exception to it, not a violation of it.

import {
  doc, setDoc, updateDoc, deleteDoc, getDocs, addDoc, collection, onSnapshot, serverTimestamp, runTransaction,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'

// tier: severity 1 (minor) - 3 (severe). bleedRate: %blood lost/sec while
// actively bleeding (unTQ'd) — higher tier bleeds faster.
export const INJ = {
  BLEED_LOW:  { name:'Low Velocity Wound',    color:'#f87171', tier:1, bleedRate:1/1.5 },
  BLEED:      { name:'Medium Velocity Wound', color:'#dc2626', tier:2, bleedRate:1 },
  BLEED_HIGH: { name:'High Velocity Wound',   color:'#991b1b', tier:3, bleedRate:2 },
}
export const BANDAGES_NEEDED = {1:1, 2:2, 3:3}
export const FRAG_INFO = { name:'Fragmentation', color:'#f97316' }
export const APPLY_MS = {
  bandage_bleed:5000, bandage_frag:15000, unpack_bandage:4000,
  tourniquet:3000, stim:3000, depressant:3000, blood:10000, remove_tourniquet:2000,
  splint:6000, remove_splint:2000,
  chest_seal:4000, remove_chest_seal:2000,
  remove_frag:4000, // find_frag's duration is randomized per-attempt, see randFindFragMs()
}
export const ZONES = ['head','torso','l_arm','r_arm','l_leg','r_leg']
// Tourniquets only make sense on limbs — never head or torso.
export const LIMBS = ['l_arm','r_arm','l_leg','r_leg']
// A TQ doesn't numb the limb the instant it goes on — circulation loss takes
// a few minutes to actually cost you the use of it, and a few more past that
// to cost you the limb outright. TQ_WARN_MS is also the numbness cutoff
// (limb becomes unusable), TQ_LOSS_MS is the permanent-loss cutoff.
export const TQ_WARN_MS = 4*60*1000
export const TQ_LOSS_MS = 6*60*1000
// Chest seals follow the exact same clock as a limb tourniquet (same
// constants) — see renderer/js/medical.js for the full reasoning.
export const FIND_FRAG_MIN_MS = 15000
export const FIND_FRAG_MAX_MS = 20000
export function randFindFragMs() {
  return FIND_FRAG_MIN_MS + Math.random()*(FIND_FRAG_MAX_MS-FIND_FRAG_MIN_MS)
}

// Stim overdose — one dose kicks HR up to OD_START_HR and it climbs
// OD_CLIMB_RATE bpm/sec from there (checked once per second by the ramp
// ticker in startMedicalTickers) until it crosses OD_ARREST_HR, which is
// cardiac arrest. At the base rate that's OD_START_HR to OD_ARREST_HR in
// ~27s. Each additional dose taken while already overdosing doesn't restart
// the ramp from OD_START_HR — it stacks onto odStacks, which multiplies the
// climb rate (OD_STACK_MULT extra per stack beyond the first), so stacking
// doses makes arrest arrive faster, not just "sooner started."
export const OD_START_HR = 200
export const OD_ARREST_HR = 280
export const OD_CLIMB_RATE = 3
export const OD_STACK_MULT = 0.5

// ── PURE TRANSITION FUNCTIONS ────────────────────────────────────────────
// These mutate the zone/target object passed in (matching the original
// inline behavior exactly) rather than returning a new one — callers always
// pass a zone object that's about to be written wholesale to Firestore
// anyway, so there's no separate "old" copy anything else could observe.

export function freshZone() {
  return {
    inj:null, frag:false, fragFound:false, bleeding:false, pain:false,
    tq:false, tqAppliedAt:null, tqNumb:false, limbLost:false,
    chestSeal:false, chestSealAppliedAt:null, chestSealFailing:false,
    bandaged:false, bandagesApplied:0,
    fracture:false, splinted:false,
  }
}

// A wound needs as many bandage applications as its severity tier calls for
// (BANDAGES_NEEDED) before it's actually packed — never surfaced directly
// as a number of "how many more," the player just keeps bandaging until it
// stops (though bandagesApplied itself IS shown, see renderer status text).
// Packing "counts" even under a live TQ/chest seal, so hitting the full
// count while one's on still marks it safe to pull.
export function applyBandageToZone(zs) {
  if(!zs) return
  zs.bandagesApplied = (zs.bandagesApplied||0)+1
  const need = BANDAGES_NEEDED[INJ[zs.inj]?.tier] || 1
  if(zs.bandagesApplied>=need) { zs.bleeding=false; zs.bandaged=true }
}

// The reverse of applyBandageToZone — see renderer/js/medical.js.
export function unpackBandageFromZone(zs) {
  if(!zs || !(zs.bandagesApplied>0)) return
  zs.bandagesApplied = Math.max(0, (zs.bandagesApplied||0)-1)
  const need = BANDAGES_NEEDED[INJ[zs.inj]?.tier] || 1
  zs.bandaged = zs.bandagesApplied >= need
  if(zs.inj && !zs.bandaged && !zs.tq && !zs.chestSeal) zs.bleeding = true
}

// Fresh TQ — circulation loss hasn't set in yet, so the limb stays usable
// until the numbness clock (TQ_WARN_MS, tracked separately as tqNumb)
// catches up to it.
export function applyTourniquetToZone(zs) {
  zs.tq=true; zs.bleeding=false; zs.tqAppliedAt=Date.now(); zs.tqNumb=false
}

// No inventory cost — pulling a TQ only resumes bleeding if the wound was
// never packed with a bandage while it was on. Feeling comes back to the
// limb the moment the TQ is off.
export function removeTourniquetFromZone(zs) {
  zs.tq=false; zs.tqAppliedAt=null; zs.tqNumb=false
  zs.bleeding = zs.bandaged ? false : !!zs.inj
}

// Chest seal — torso-only equivalent of a tourniquet. See renderer/js/medical.js.
export function applyChestSealToZone(zs) {
  zs.chestSeal=true; zs.bleeding=false; zs.chestSealAppliedAt=Date.now(); zs.chestSealFailing=false
}
export function removeChestSealFromZone(zs) {
  zs.chestSeal=false; zs.chestSealAppliedAt=null; zs.chestSealFailing=false
  zs.bleeding = zs.bandaged ? false : !!zs.inj
}

// Unconscious -> stim wakes them up clean, no risk. Conscious -> stim starts
// (or stacks onto) an overdose: HR jumps to OD_START_HR on the first dose,
// then climbs every second via the ramp ticker in startMedicalTickers until
// it crosses OD_ARREST_HR — cardiac arrest, not an instant roll. A second
// dose taken while already overdosing doesn't re-jump HR back down to
// OD_START_HR (it's already above that) — it just adds to odStacks, which
// the ticker uses to climb faster.
export function applyStimTo(obj) {
  if(obj.uncon) {
    obj.uncon=false; obj.overdosing=false; obj.odStacks=0; obj.hr=95
  } else {
    obj.odStacks=(obj.odStacks||0)+1
    if(!obj.overdosing) obj.hr=OD_START_HR
    obj.overdosing=true
  }
}

// Clears an active overdose outright (that's the point of countering a stim
// with a depressant) — otherwise it's just a normal HR-lowering aid.
export function applyDepressantTo(obj) {
  if(obj.overdosing) { obj.hr=78; obj.overdosing=false; obj.odStacks=0 }
  else obj.hr=55
}

// A tourniquet doesn't numb the limb the instant it's on — it takes a few
// minutes of cut circulation (TQ_WARN_MS, tracked as tqNumb) before it's
// actually unusable, same as a fracture from then on. Before that point the
// TQ has stopped the bleeding but the limb still works fine.
export function getCapabilityRestrictions(zones, dead, uncon) {
  if(dead) return ['Deceased — cannot act or speak on radio']
  const out = []
  if(uncon) out.push('Unconscious — cannot act or speak on radio')
  const impaired = z => { const s=zones?.[z]; return !!(s && (s.fracture || s.tqNumb || s.limbLost)) }
  const armsDown = ['l_arm','r_arm'].filter(impaired).length
  const legsDown = ['l_leg','r_leg'].filter(impaired).length
  if(armsDown>=2) out.push('Cannot use arms — no weapon usable')
  else if(armsDown===1) out.push('Rifle unusable — pistol only')
  if(legsDown>=1) out.push('Cannot walk')
  return out
}

// Each hit zone rolls an overall wound tier — 60% tier 1, 30% tier 2, 10%
// tier 3 — which composes its own bleed severity / fragmentation / fracture
// odds. A head hit skips all of this — it's always instantly fatal, so it's
// rolled separately at a low flat chance instead of being just another one
// of the 6 zones (that made most casualties instant deaths).
function rollInjuries() {
  const HEAD_HIT_CHANCE = 0.08
  const headHit = Math.random() < HEAD_HIT_CHANCE
  const bodyPool = ZONES.filter(z=>z!=='head')
  const shuffled = [...bodyPool].sort(()=>Math.random()-.5)
  const count = 1+Math.floor(Math.random()*4)
  const zones = {}
  const hitZones = headHit ? ['head', ...shuffled.slice(0,Math.max(0,count-1))] : shuffled.slice(0,count)
  hitZones.forEach(z=>{
    const wr = Math.random()
    const wtier = wr<.6 ? 1 : wr<.9 ? 2 : 3
    let bleedTier, frag, fracture
    if(wtier===1)      { bleedTier = Math.random()<.5?1:2; frag = Math.random()<.20; fracture = false }
    else if(wtier===2) { bleedTier = Math.random()<.25?3:2; frag = true;             fracture = Math.random()<.30 }
    else               { bleedTier = 3;                     frag = true;             fracture = true }
    const injType = bleedTier===1?'BLEED_LOW':bleedTier===2?'BLEED':'BLEED_HIGH'
    zones[z] = { ...freshZone(), inj:injType, frag, bleeding:true, fracture, pain:true }
  })
  // Only a severe (tier 3) bleed knocks someone out immediately — lesser
  // wounds leave you down-but-conscious, and only tip into unconsciousness
  // later if blood loss actually drags you under the 25% threshold.
  const maxTier = Math.max(0, ...Object.values(zones).map(s=>INJ[s.inj]?.tier||0))
  const startUncon = headHit || maxTier>=3
  return { zones, headHit, startUncon }
}

// ── MODULE STATE ──────────────────────────────────────────────────────────
// Single shared object, never reassigned — index.html grabs this reference
// once (getSelf()) and every existing `S.self.xxx` read/write in index.html
// keeps working unchanged, since it's the exact same object this module
// mutates. `M.patients` IS reassigned wholesale on every snapshot (it's a
// derived list, not a single record) — index.html re-syncs its own
// `S.patients` reference via the onPatientsChange hook each time.
const M = {
  self: { down:false, uncon:false, dead:false, deathCause:null, zones:{}, bloodPct:100, hr:78, overdosing:false, odStacks:0, inv:{bandage:0,tourniquet:0,splint:0,stim:0,depressant:0,blood:0} },
  patients: [],
  db:null, cardId:null, uid:null,
  listeners: [],
  activeOpId: null, actorName: '',
}

export function getSelf() { return M.self }
export function getPatients() { return M.patients }

// The currently-active operation, if any — tagged onto every event this
// module logs so casualties/treatments can be attributed to the op they
// happened during. index.html/hosting keep this in sync with their own
// operations listener; medical.js has no opinion on what "active" means.
export function setActiveOp(opId) { M.activeOpId = opId||null }
// Display name for the acting player — medical.js only knows uids
// internally, so callers hand over the human-readable name once so the
// event log doesn't have to be joined against the roster to be readable.
export function setActorName(name) { M.actorName = name||'' }

// Append-only activity log — never awaited by callers (best-effort; a
// logging failure should never block or roll back the actual treatment
// write it's describing).
function logEvent(type, extra={}) {
  if(!M.db || !M.cardId) return
  addDoc(collection(M.db,'cards',M.cardId,'events'), {
    type, ts: serverTimestamp(), actorUid: M.uid, actorName: M.actorName,
    opId: M.activeOpId, ...extra,
  }).catch(()=>{})
}

export function initMedical(db, cardId, uid, hooks) {
  M.db = db; M.cardId = cardId; M.uid = uid
  const selfUnsub = onSnapshot(doc(db,'medical',cardId,'patients',uid), snap => {
    if(snap.exists()) {
      const d = snap.data()
      const wasDead = M.self.dead
      M.self.zones      = d.zones      || {}
      M.self.bloodPct   = d.bloodPct   ?? 100
      M.self.down       = d.down       ?? false
      M.self.uncon      = d.uncon      ?? false
      M.self.dead       = d.dead       ?? false
      M.self.deathCause = d.deathCause ?? null
      M.self.overdosing = d.overdosing ?? false
      M.self.odStacks   = d.odStacks   ?? 0
      // NOTE: inv deliberately not read here — inventory is a persistent
      // per-member resource now (see syncInventory), independent of this
      // casualty doc's lifecycle. It used to live here and silently reset
      // to full every time this doc got deleted on revive.
      // A medic's treatment (e.g. a fatal stim overdose) can kill/knock you
      // out remotely — cut an already-held PTT immediately, don't wait for
      // the next keypress.
      if(!wasDead && M.self.dead) hooks.onSelfDied?.()
    } else {
      M.self.down=false; M.self.uncon=false; M.self.dead=false; M.self.deathCause=null; M.self.zones={}; M.self.bloodPct=100
      M.self.overdosing=false; M.self.odStacks=0
    }
    hooks.onSelfChange?.(M.self)
  })

  const patientsUnsub = onSnapshot(collection(db,'medical',cardId,'patients'), snap => {
    const prevCount = M.patients.length
    // Never include your own record here — "patients" is the medic's view
    // of OTHER downed people. Your own casualty state lives in getSelf() and
    // is shown/treated only through MY STATUS.
    //
    // Also require down or dead — see renderer/js/medical.js for why a
    // casualty doc can now exist for someone who isn't actually down.
    const allDown = snap.docs.filter(d=>d.data().down || d.data().dead)
    M.patients = allDown.filter(d=>d.id!==uid).map(d=>({id:d.id,...d.data()}))
    hooks.onPatientsChange?.(M.patients, {
      prevCount,
      newCasualty: M.patients.length > prevCount && prevCount >= 0,
      totalIncludingSelf: allDown.length,
    })
  })

  M.listeners = [selfUnsub, patientsUnsub]
}

export function cleanupMedical() {
  M.listeners.forEach(u => { try { u() } catch(e){} })
  M.listeners = []
}

// Inventory is a persistent per-member resource — it lives on the member
// doc (cards/{cardId}/members/{uid}.inv), not on this casualty doc, and
// does NOT reset on revive or on going down. It only resets when an admin
// starts a new operation (see createOp), which refills every roster
// member's inv back to their current role loadout. A member with no inv
// field yet (never in a started op) is treated as having none at all.
// Called by index.html whenever the member doc's inv field changes.
export function syncInventory(inv) {
  M.self.inv = {...inv}
}

export async function markDown(username) {
  const { zones, headHit, startUncon } = rollInjuries()
  M.self.zones = zones
  M.self.bloodPct = 100; M.self.down = true; M.self.uncon = startUncon; M.self.dead = headHit
  M.self.deathCause = headHit ? 'headshot' : null
  M.self.overdosing = false; M.self.odStacks = 0
  if(headHit) M.self.hr = 0
  await setDoc(doc(M.db,'medical',M.cardId,'patients',M.uid), {
    username, uid: M.uid,
    zones: M.self.zones, bloodPct: M.self.bloodPct, overdosing:false, odStacks:0,
    down:true, uncon:startUncon, dead:headHit, deathCause:M.self.deathCause, ...(headHit?{hr:0}:{}),
    downdAt: Date.now(), updatedAt: serverTimestamp(),
  })
  logEvent('casualty', { targetUid:M.uid, targetName:username, cause: headHit?'headshot':'wounded' })
  return { headHit, startUncon }
}

export async function revive() {
  M.self.down=false; M.self.uncon=false; M.self.dead=false; M.self.deathCause=null; M.self.zones={}; M.self.bloodPct=100
  M.self.overdosing=false; M.self.odStacks=0; M.self.hr=78
  await deleteDoc(doc(M.db,'medical',M.cardId,'patients',M.uid))
  logEvent('revive', { targetUid:M.uid, targetName:M.actorName })
}

export async function clearPatient(patientId) {
  await deleteDoc(doc(M.db,'medical',M.cardId,'patients',patientId))
}

// Wipes every casualty record on the card — meant for end-of-op cleanup.
// Each affected player's own MY STATUS clears itself automatically via their
// own-medical-record listener once their doc is gone.
export async function clearAllPatients() {
  const snap = await getDocs(collection(M.db,'medical',M.cardId,'patients'))
  await Promise.all(snap.docs.map(d => deleteDoc(d.ref)))
}

// See renderer/js/medical.js for the full reasoning behind everything in
// this section — this is a straight mirror, keep the two in sync.
const NO_INV_TREATMENTS = new Set(['remove_tourniquet','remove_splint','remove_chest_seal','unpack_bandage','find_frag','remove_frag'])
const ZONE_TREATMENTS = new Set(['bandage','unpack_bandage','tourniquet','remove_tourniquet','chest_seal','remove_chest_seal','splint','remove_splint','find_frag','remove_frag'])
const INV_KEY = { chest_seal: 'chestseal' }

function transformZone(zs, treatment) {
  if(treatment==='bandage') applyBandageToZone(zs)
  else if(treatment==='unpack_bandage') unpackBandageFromZone(zs)
  else if(treatment==='tourniquet') applyTourniquetToZone(zs)
  else if(treatment==='remove_tourniquet') removeTourniquetFromZone(zs)
  else if(treatment==='chest_seal') applyChestSealToZone(zs)
  else if(treatment==='remove_chest_seal') removeChestSealFromZone(zs)
  else if(treatment==='splint') { zs.fracture=false; zs.splinted=true }
  else if(treatment==='remove_splint') { zs.fracture=true; zs.splinted=false }
  else if(treatment==='find_frag') zs.fragFound=true
  else if(treatment==='remove_frag') { zs.frag=false; zs.fragFound=false }
}

export async function applyTreatment({zone, treatment, target, patientId}) {
  const isSelf = target!=='patient'
  const targetUid = isSelf ? M.uid : patientId

  if(!isSelf && !M.patients.find(p=>p.id===patientId)) {
    throw new Error('That patient is no longer on the casualty board — treatment not applied.')
  }

  const ref = doc(M.db,'medical',M.cardId,'patients',targetUid)
  let fieldChanges = {}

  await runTransaction(M.db, async (tx) => {
    const snap = await tx.get(ref)
    // See renderer/js/medical.js for why self creates the doc when missing
    // (preemptive TQ / testing a stim before ever going down) while patient
    // still requires it to already exist.
    if(!snap.exists() && !isSelf) {
      throw new Error('That patient is no longer on the casualty board — treatment not applied.')
    }
    const data = snap.exists() ? snap.data() : {
      username: M.actorName, uid: M.uid, down:false, uncon:false, dead:false,
      deathCause:null, zones:{}, bloodPct:100, hr:78, overdosing:false, odStacks:0,
    }
    fieldChanges = {}

    if(ZONE_TREATMENTS.has(treatment)) {
      const zs = { ...freshZone(), ...(data.zones?.[zone]) }
      transformZone(zs, treatment)
      fieldChanges.zones = { ...data.zones, [zone]: zs }
    } else if(treatment==='stim') {
      const p = { hr:data.hr, uncon:data.uncon, overdosing:data.overdosing, odStacks:data.odStacks, dead:data.dead }
      applyStimTo(p)
      Object.assign(fieldChanges, p)
    } else if(treatment==='depressant') {
      const p = { hr:data.hr, overdosing:data.overdosing, odStacks:data.odStacks }
      applyDepressantTo(p)
      Object.assign(fieldChanges, p)
    } else if(treatment==='blood') {
      fieldChanges.bloodPct = Math.min(100,(data.bloodPct||0)+40)
    }

    if(snap.exists()) {
      const patch = { updatedAt: serverTimestamp() }
      for(const [k,v] of Object.entries(fieldChanges)) {
        patch[k==='zones' ? `zones.${zone}` : k] = k==='zones' ? v[zone] : v
      }
      tx.update(ref, patch)
    } else {
      // Real nested object, not dot-path keys — tx.set doesn't parse dots
      // as field paths (only tx.update/updateDoc do).
      tx.set(ref, { ...data, ...fieldChanges, updatedAt: serverTimestamp() })
    }
  })

  const invKey = INV_KEY[treatment]||treatment
  if(!NO_INV_TREATMENTS.has(treatment) && M.self.inv[invKey]!==undefined) {
    M.self.inv[invKey] = Math.max(0,(M.self.inv[invKey]||0)-1)
    await syncInventoryWrite()
  }

  const targetLocal = isSelf ? M.self : M.patients.find(p=>p.id===patientId)
  if(targetLocal) Object.assign(targetLocal, fieldChanges)

  logEvent('treatment', { targetUid, targetName: isSelf ? M.actorName : (targetLocal?.username||patientId), treatment, zone })
  return {
    isSelf,
    diedFromStim: treatment==='stim' && !!fieldChanges.dead,
    self: isSelf ? M.self : undefined,
    patient: isSelf ? undefined : targetLocal,
  }
}

// Inventory always belongs to the ACTING player (the medic), regardless of
// who they treated — persisted on their own member doc, not the casualty
// doc, so it survives reviving/going down and is only ever refilled by
// starting a new operation (see createOp in index.html).
async function syncInventoryWrite() {
  await setDoc(doc(M.db,'cards',M.cardId,'members',M.uid), { inv: M.self.inv }, {merge:true})
}

// Tourniquet clock — leaving a TQ on too long costs the limb permanently.
// Blood drain — rate is the AVERAGE of every actively-bleeding zone's own
// tier-based bleedRate, applied once per second. Averaging (rather than
// summing) keeps a flat, predictable %/s regardless of how many wounds are
// open at once, instead of blood loss compounding with every extra hit.
export function startMedicalTickers(hooks) {
  setInterval(async () => {
    // Deliberately NOT gated on M.self.down — see renderer/js/medical.js.
    if(!M.cardId || M.self.dead) return
    const upd = {}
    let changed = false
    for(const z of LIMBS) {
      const s = M.self.zones[z]
      if(!s || !s.tq || s.limbLost || !s.tqAppliedAt) continue
      const tqMs = Date.now()-s.tqAppliedAt
      if(tqMs >= TQ_LOSS_MS) {
        s.limbLost = true
        s.bleeding = false // nothing left to bleed
        upd[`zones.${z}`] = s
        changed = true
        hooks.onLimbLost?.(z)
      } else if(!s.tqNumb && tqMs >= TQ_WARN_MS) {
        // Circulation loss just caught up to this limb — it goes numb and
        // becomes unusable, distinct from (and well before) losing it outright.
        s.tqNumb = true
        upd[`zones.${z}`] = s
        changed = true
        hooks.onLimbNumb?.(z)
      }
    }
    // Chest seal — see renderer/js/medical.js for the full reasoning.
    const ts = M.self.zones.torso
    if(ts?.chestSeal && !ts.bandaged && ts.chestSealAppliedAt) {
      const sealMs = Date.now()-ts.chestSealAppliedAt
      if(sealMs >= TQ_LOSS_MS) {
        ts.chestSeal = false; ts.chestSealAppliedAt = null; ts.chestSealFailing = false
        ts.bleeding = !!ts.inj
        upd['zones.torso'] = ts
        changed = true
        hooks.onChestSealFailed?.()
      } else if(!ts.chestSealFailing && sealMs >= TQ_WARN_MS) {
        ts.chestSealFailing = true
        upd['zones.torso'] = ts
        changed = true
        hooks.onChestSealFailing?.()
      }
    }
    if(changed) {
      // Matches the treat-modal refresh the original ticker did — only on an
      // actual limb-state transition, not every tick.
      hooks.onTourniquetTick?.(M.self)
      await updateDoc(doc(M.db,'medical',M.cardId,'patients',M.uid),
        {...upd, updatedAt:serverTimestamp()})
    }
  }, 5000)

  setInterval(async () => {
    if(!M.cardId || !M.self.down || M.self.dead) return
    const bleedingZones = Object.values(M.self.zones).filter(s=>s.bleeding&&!s.tq)
    if(bleedingZones.length){
      const rate = bleedingZones.reduce((sum,s)=>sum+(INJ[s.inj]?.bleedRate ?? 1.0), 0) / bleedingZones.length
      M.self.bloodPct = Math.max(0, M.self.bloodPct-rate)
      // Every-second body-figure refresh only — the original never refreshed
      // the open treat modal on a routine tick, only on the threshold-cross
      // events below.
      hooks.onBloodTick?.(M.self)

      if(M.self.bloodPct<=0) {
        // Bled out — deceased. Only a full revive can bring them back.
        M.self.dead = true
        M.self.deathCause = 'bleed_out'
        M.self.hr = 0
        hooks.onBleedOut?.()
        await setDoc(doc(M.db,'medical',M.cardId,'patients',M.uid),{
          bloodPct:0, hr:0, dead:true, deathCause:'bleed_out', uncon:true, updatedAt:serverTimestamp()
        },{merge:true})
        return
      }

      // Blood loss knocks a conscious casualty out at 25% — synced
      // immediately (not batched) since it also gates radio transmit.
      if(!M.self.uncon && M.self.bloodPct<=25) {
        M.self.uncon = true
        hooks.onKnockedOut?.()
        await setDoc(doc(M.db,'medical',M.cardId,'patients',M.uid),{
          uncon:true, bloodPct:M.self.bloodPct, updatedAt:serverTimestamp()
        },{merge:true})
      }

      // Sync every ~5s to avoid write spam.
      if(Math.random()<0.2) {
        await setDoc(doc(M.db,'medical',M.cardId,'patients',M.uid),{bloodPct:M.self.bloodPct,hr:M.self.hr,updatedAt:serverTimestamp()},{merge:true})
      }
    }
  }, 1000)

  // Stim overdose ramp — HR climbs OD_CLIMB_RATE bpm/sec (faster per extra
  // stacked dose, see OD_STACK_MULT) until it crosses OD_ARREST_HR.
  // Deliberately NOT gated on M.self.down — see renderer/js/medical.js.
  setInterval(async () => {
    if(!M.cardId || M.self.dead || !M.self.overdosing) return
    const rate = OD_CLIMB_RATE * (1 + OD_STACK_MULT*Math.max(0,(M.self.odStacks||1)-1))
    M.self.hr = Math.min(OD_ARREST_HR, M.self.hr + rate)
    hooks.onOdTick?.(M.self)

    if(M.self.hr >= OD_ARREST_HR) {
      // Cardiac arrest — only a revive can bring them back, same as bleeding out.
      M.self.dead = true; M.self.deathCause = 'cardiac_arrest'; M.self.uncon = true; M.self.overdosing = false
      hooks.onCardiacArrest?.()
      await setDoc(doc(M.db,'medical',M.cardId,'patients',M.uid),{
        hr:OD_ARREST_HR, dead:true, deathCause:'cardiac_arrest', uncon:true, overdosing:false, updatedAt:serverTimestamp()
      },{merge:true})
      return
    }

    // Sync every ~3s so a medic watching this patient sees HR actually rising.
    if(Math.random()<0.33) {
      await setDoc(doc(M.db,'medical',M.cardId,'patients',M.uid),{hr:M.self.hr,updatedAt:serverTimestamp()},{merge:true})
    }
  }, 1000)
}
