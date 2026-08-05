// renderer/js/medical.js
// Medical state + treatment logic, rebuilt to fix a confirmed bug: treatment
// state (bandagesApplied, bleeding, tq, ...) was being mutated locally AND
// written to Firestore, while a separate onSnapshot listener ALSO wrote to
// the same local state on every fire. Two writers racing meant a fresh local
// change could be silently overwritten by a stale/delayed snapshot with no
// error — confirmed live via console logging: the mutation was always
// correct in isolation, but reverted between actions.
//
// Fix: single-writer state. Every action here computes its *next* value
// purely and writes it straight to Firestore — it never touches local state
// directly. The one onSnapshot listener below is the ONLY thing that ever
// updates local state, so there's nothing for it to conflict with; it's
// always the sole source of truth. Callers subscribe via onMedicalChange()
// and re-render from getSelf()/getPatients() whenever it fires.

import {
  doc, setDoc, deleteDoc, getDocs, collection, onSnapshot, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'

// ── CONSTANTS ─────────────────────────────────────────────────────────────
export const ZONES = ['head','torso','l_arm','r_arm','l_leg','r_leg']
export const ZONE_LABEL = {head:'HEAD',torso:'TORSO',l_arm:'L.ARM',r_arm:'R.ARM',l_leg:'L.LEG',r_leg:'R.LEG'}
export const ZONE_SPEECH = {l_arm:'left arm',r_arm:'right arm',l_leg:'left leg',r_leg:'right leg'}
export const ICON_POS = {head:{x:86,y:8},torso:{x:86,y:88},l_arm:{x:30,y:161},r_arm:{x:140,y:161},l_leg:{x:72,y:260},r_leg:{x:106,y:260}}
// Tourniquets only make sense on limbs — never head or torso.
export const LIMBS = ['l_arm','r_arm','l_leg','r_leg']
// A TQ doesn't numb the limb the instant it's on — circulation loss takes a
// few minutes to actually cost you the use of it, and a few more past that
// to cost you the limb outright. TQ_WARN_MS is also the numbness cutoff
// (limb becomes unusable), TQ_LOSS_MS is the permanent-loss cutoff.
export const TQ_WARN_MS = 4*60*1000
export const TQ_LOSS_MS = 6*60*1000
// tier: severity 1 (minor) - 3 (severe). bleedRate: %blood lost/sec while
// actively bleeding (unTQ'd) — tier 1 loses 1% every 1.5s, tier 2 every 1s,
// tier 3 every 0.5s. Bandages needed to fully pack a wound scale with tier
// (BANDAGES_NEEDED) — never surfaced to the player directly.
export const INJ = {
  BLEED_LOW:  { name:'Low Velocity Wound',    color:'#f87171', tier:1, bleedRate:1/1.5 },
  BLEED:      { name:'Medium Velocity Wound', color:'#dc2626', tier:2, bleedRate:1 },
  BLEED_HIGH: { name:'High Velocity Wound',   color:'#991b1b', tier:3, bleedRate:2 },
}
export const BANDAGES_NEEDED = {1:1, 2:2, 3:3}
// Fragmentation is a flag layered on top of a bleed (like fracture), not its
// own bleed type — a wound can be e.g. a Medium Velocity Wound WITH frag.
export const FRAG_INFO = { name:'Fragmentation', color:'#f97316' }
export const APPLY_MS = {
  bandage_bleed:5000, bandage_frag:15000,
  tourniquet:3000, stim:3000, depressant:3000, blood:10000, remove_tourniquet:2000,
  splint:6000,
}
const DEFAULT_INV = {bandage:0,tourniquet:0,splint:0,stim:0,depressant:0,blood:0}
const HEAD_HIT_CHANCE = 0.08

// ── PURE STATE-TRANSITION FUNCTIONS ─────────────────────────────────────────
// Each returns a NEW object and never mutates its argument — safe to call
// against the latest known state without any risk of corrupting a shared
// reference other code might still be holding.
export function freshZone() {
  return {inj:null,frag:false,bleeding:false,tq:false,bandaged:false,bandagesApplied:0,fracture:false,tqAppliedAt:null,tqNumb:false,limbLost:false}
}

function bandageZone(zs) {
  const z = {...zs}
  z.bandagesApplied = (z.bandagesApplied||0)+1
  const need = BANDAGES_NEEDED[INJ[z.inj]?.tier] || 1
  if(z.bandagesApplied>=need) { z.bleeding=false; z.bandaged=true }
  return z
}
function tourniquetZone(zs) {
  const z = {...(zs||freshZone())}
  z.tq=true; z.bleeding=false; z.tqAppliedAt=Date.now(); z.tqNumb=false
  return z
}
function removeTourniquetZone(zs) {
  const z = {...zs}
  z.tq=false; z.tqAppliedAt=null; z.tqNumb=false
  z.bleeding = z.bandaged ? false : !!z.inj
  return z
}
function splintZone(zs) {
  return {...zs, fracture:false}
}
// Unconscious -> stim wakes them up clean, no risk. Conscious -> stim is an
// overdose: heart rate spikes into the 200-250 danger band, and every
// additional dose taken while still in that band stacks another +2% on top
// of the running chance of cardiac death (rolled on that dose).
function stimTarget(t) {
  const next = {...t}
  if(next.uncon) {
    next.uncon=false; next.overdosing=false; next.odStacks=0; next.hr=95
  } else {
    next.odStacks=(next.odStacks||0)+1
    next.overdosing=true
    next.hr=200+Math.floor(Math.random()*51) // 200-250
    if(Math.random() < Math.min(1, 0.02*next.odStacks)) {
      next.dead=true; next.uncon=true; next.overdosing=false; next.hr=0
    }
  }
  return next
}
// Clears an active overdose outright — otherwise just a normal HR-lowering aid.
function depressantTarget(t) {
  const next = {...t}
  if(next.overdosing) { next.hr=78; next.overdosing=false; next.odStacks=0 }
  else next.hr=55
  return next
}

// Rolls a fresh set of random injuries the same way a "mark down" event
// always has: each hit zone gets an overall wound tier (60% tier 1, 30%
// tier 2, 10% tier 3) composing its own bleed severity / frag / fracture
// odds. A head hit is rolled separately at a flat low chance and is always
// instantly fatal, rather than being just one of the 6 zones (which used to
// make most casualties instant deaths).
function rollInjuries() {
  const headHit = Math.random() < HEAD_HIT_CHANCE
  const bodyPool = ZONES.filter(z=>z!=='head')
  const shuffled = [...bodyPool].sort(()=>Math.random()-.5)
  const count = 1+Math.floor(Math.random()*4)
  const hitZones = headHit ? ['head', ...shuffled.slice(0,Math.max(0,count-1))] : shuffled.slice(0,count)
  const zones = {}
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
  const maxTier = Math.max(0, ...Object.values(zones).map(s=>INJ[s.inj]?.tier||0))
  const startUncon = headHit || maxTier>=3
  return { zones, headHit, startUncon }
}

// ── MODULE STATE — the only place self/patients data lives ─────────────────
const state = {
  db: null, cardId: null, uid: null, getLoadout: () => ({...DEFAULT_INV}),
  self: { down:false, uncon:false, dead:false, zones:{}, bloodPct:100, hr:78, overdosing:false, odStacks:0, inv:{...DEFAULT_INV} },
  patients: [],
  patientDocCount: 0,
  listeners: [],
}
const subscribers = new Set()
function notify() { subscribers.forEach(fn=>{ try { fn() } catch(e) { console.error('medical subscriber error', e) } }) }

export function onMedicalChange(fn) { subscribers.add(fn); return () => subscribers.delete(fn) }
export function getSelf() { return state.self }
export function getPatients() { return state.patients }
export function getActivePatientDocCount() { return state.patientDocCount }
function selfRef() { return doc(state.db,'medical',state.cardId,'patients',state.uid) }
function patientRef(uid) { return doc(state.db,'medical',state.cardId,'patients',uid) }

// getLoadout: () => inv object, called whenever a fresh medical record needs
// a starting inventory (own record deleted / never existed) — pass the
// member's role-loadout resolver so a fresh state isn't just zeros.
export function initMedical(db, cardId, uid, getLoadout) {
  cleanupMedical()
  state.db=db; state.cardId=cardId; state.uid=uid
  if(getLoadout) state.getLoadout = getLoadout

  state.listeners.push(onSnapshot(selfRef(), snap => {
    const wasIncapacitated = state.self.dead || state.self.uncon
    if(snap.exists()) {
      const d = snap.data()
      state.self = {
        down: d.down??false, uncon: d.uncon??false, dead: d.dead??false,
        zones: d.zones||{}, bloodPct: d.bloodPct??100, hr: d.hr??78,
        overdosing: d.overdosing??false, odStacks: d.odStacks??0,
        inv: d.inv || state.self.inv,
      }
      // A medic's treatment (e.g. a fatal stim overdose) or bleeding out can
      // knock you out remotely — callers use this to cut an already-held PTT
      // immediately instead of waiting for the next keypress.
      state.self._justIncapacitated = !wasIncapacitated && (state.self.dead || state.self.uncon)
    } else {
      state.self = { down:false, uncon:false, dead:false, zones:{}, bloodPct:100, hr:78, overdosing:false, odStacks:0, inv: state.getLoadout() }
      state.self._justIncapacitated = false
    }
    notify()
  }))

  state.listeners.push(onSnapshot(collection(db,'medical',cardId,'patients'), snap => {
    state.patients = snap.docs.filter(d=>d.id!==uid).map(d=>({id:d.id,...d.data()}))
    state.patientDocCount = snap.docs.length // includes self, for admin "active" count
    notify()
  }))
}

export function cleanupMedical() {
  state.listeners.forEach(u=>{try{u()}catch(e){}})
  state.listeners = []
}

// ── ACTIONS — every one computes purely and WRITES ONLY. None of them touch
// state.self/state.patients directly; the listener above is what updates
// those, once, from the authoritative server data. ──────────────────────────

export async function markDown() {
  const { zones, headHit, startUncon } = rollInjuries()
  const inv = state.getLoadout()
  await setDoc(selfRef(), {
    uid: state.uid,
    zones, bloodPct:100, overdosing:false, odStacks:0,
    down:true, uncon:startUncon, dead:headHit, ...(headHit?{hr:0}:{}), inv,
    downdAt:Date.now(), updatedAt:serverTimestamp()
  })
  return { headHit, startUncon }
}

export async function revive() {
  await deleteDoc(selfRef())
}

// { zone, treatment, target:'self'|'patient', patientId }
export async function applyTreatment({ zone, treatment, target, patientId }) {
  const isSelf = target!=='patient'
  const current = isSelf ? state.self : state.patients.find(p=>p.id===patientId)
  if(!current) throw new Error('Treatment target not found')
  if(current.dead) throw new Error('Deceased — no treatment applies')

  const zs = current.zones?.[zone]
  const upd = { updatedAt: serverTimestamp() }
  let nextZone = zs

  if(treatment==='bandage') {
    nextZone = bandageZone(zs || freshZone())
  } else if(treatment==='tourniquet') {
    if(!LIMBS.includes(zone)) throw new Error('Tourniquets only go on limbs')
    if(zs?.tq) throw new Error('Already has a tourniquet on')
    nextZone = tourniquetZone(zs)
  } else if(treatment==='remove_tourniquet') {
    if(!zs) throw new Error('Nothing to remove')
    nextZone = removeTourniquetZone(zs)
  } else if(treatment==='splint') {
    nextZone = splintZone(zs || freshZone())
  } else if(treatment==='stim') {
    const next = stimTarget(current)
    upd.uncon=next.uncon; upd.dead=next.dead; upd.hr=next.hr
    upd.overdosing=next.overdosing; upd.odStacks=next.odStacks
  } else if(treatment==='depressant') {
    const next = depressantTarget(current)
    upd.hr=next.hr; upd.overdosing=next.overdosing; upd.odStacks=next.overdosing?current.odStacks:0
  } else if(treatment==='blood') {
    upd.bloodPct = Math.min(100,(current.bloodPct||0)+40)
  } else {
    throw new Error('Unknown treatment: '+treatment)
  }

  if(nextZone !== zs) upd[`zones.${zone}`] = nextZone

  const targetUid = isSelf ? state.uid : patientId
  await setDoc(patientRef(targetUid), upd, {merge:true})

  // Inventory is always deducted from the ACTING player's own record,
  // whether they're treating themselves or someone else.
  if(treatment!=='remove_tourniquet') {
    const invField = `inv.${treatment}`
    const nextCount = Math.max(0, (state.self.inv?.[treatment]||0) - 1)
    await setDoc(selfRef(), { [invField]: nextCount, updatedAt: serverTimestamp() }, {merge:true})
  }
}

// Background tick: leaving a TQ on too long costs the limb permanently.
// Call every few seconds while down; no-ops if nothing needs to change.
export async function tickTourniquetClock(calloutFn, sfxFn) {
  if(!state.self.down || state.self.dead) return
  const upd = {}
  let changed = false
  for(const z of LIMBS) {
    const s = state.self.zones[z]
    if(!s || !s.tq || s.limbLost || !s.tqAppliedAt) continue
    const tqMs = Date.now()-s.tqAppliedAt
    if(tqMs >= TQ_LOSS_MS) {
      upd[`zones.${z}`] = { ...s, limbLost:true, bleeding:false }
      changed = true
      sfxFn?.('alert')
    } else if(!s.tqNumb && tqMs >= TQ_WARN_MS) {
      upd[`zones.${z}`] = { ...s, tqNumb:true }
      changed = true
      sfxFn?.('alert')
      calloutFn?.(`${ZONE_SPEECH[z]} unusable, tourniquet`)
    }
  }
  if(changed) {
    upd.updatedAt = serverTimestamp()
    await setDoc(selfRef(), upd, {merge:true})
  }
}

// Background tick: blood loss. Rate is the AVERAGE of every actively-
// bleeding zone's tier bleedRate (not summed), so it stays a flat,
// predictable %/s no matter how many wounds are open. Call once/sec.
export async function tickBloodDrain(sfxFn) {
  if(!state.self.down || state.self.dead) return
  const bleedingZones = Object.values(state.self.zones).filter(s=>s.bleeding&&!s.tq)
  if(!bleedingZones.length) return
  const rate = bleedingZones.reduce((sum,s)=>sum+(INJ[s.inj]?.bleedRate ?? 1.0), 0) / bleedingZones.length
  const nextBloodPct = Math.max(0, state.self.bloodPct - rate)

  if(nextBloodPct<=0) {
    sfxFn?.('alert')
    await setDoc(selfRef(), { bloodPct:0, hr:0, dead:true, uncon:true, updatedAt:serverTimestamp() }, {merge:true})
    return
  }
  if(!state.self.uncon && nextBloodPct<=25) {
    sfxFn?.('alert')
    await setDoc(selfRef(), { uncon:true, bloodPct:nextBloodPct, updatedAt:serverTimestamp() }, {merge:true})
    return
  }
  // Not a state-changing threshold — just the ongoing drain. Synced every
  // tick (bloodPct is cheap and medics need it close to live).
  await setDoc(selfRef(), { bloodPct:nextBloodPct, updatedAt:serverTimestamp() }, {merge:true})
}

// A medic clearing one stabilized patient off the casualty board.
export async function clearPatient(patientId) {
  await deleteDoc(patientRef(patientId))
}

// Admin end-of-op reset — wipes every casualty record on the card.
export async function clearAllPatients() {
  const snap = await getDocs(collection(state.db,'medical',state.cardId,'patients'))
  await Promise.all(snap.docs.map(d => deleteDoc(d.ref)))
}
