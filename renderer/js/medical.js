// renderer/js/medical.js
// Medical system — Bellum-style
// Handles injury generation, treatment timers, blood/vitals simulation

import { setPatientMedical, updatePatientMedical, clearPatientMedical } from './db.js'

// ── INJURY TYPES ──────────────────────────────────────────────────────────────
export const INJ = {
  BLEED: { name: 'Bleeding Wound', color: '#dc2626', bleeds: true  },
  FRAG:  { name: 'Fragmentation',  color: '#f97316', bleeds: true  },
}

// ── TREATMENT TIMINGS (ms) ────────────────────────────────────────────────────
export const APPLY_MS = {
  bandage_bleed: 5000,
  bandage_frag:  15000,
  tourniquet:    3000,
  stim:          3000,
  depressant:    3000,
  blood:         10000,
}

// ── ZONES ─────────────────────────────────────────────────────────────────────
export const ZONES = ['head','torso','l_arm','r_arm','l_leg','r_leg']
export const ZONE_LABEL = {
  head:'HEAD', torso:'TORSO', l_arm:'L.ARM', r_arm:'R.ARM', l_leg:'L.LEG', r_leg:'R.LEG'
}

// ── GENERATE RANDOM INJURIES ──────────────────────────────────────────────────
export function generateInjuries() {
  const shuffled = [...ZONES].sort(() => Math.random() - 0.5)
  const count    = 1 + Math.floor(Math.random() * 4)
  const zones    = {}

  shuffled.slice(0, count).forEach(z => {
    const inj = Math.random() < 0.6 ? 'BLEED' : 'FRAG'
    zones[z]  = { inj, bleeding: true, tq: false }
  })

  return zones
}

// ── APPLY TREATMENT ───────────────────────────────────────────────────────────
// Returns updated patient data after treatment is applied
export function applyTreatmentLocally(patient, zone, treatment) {
  const p = JSON.parse(JSON.stringify(patient)) // deep clone

  if (treatment === 'bandage') {
    if (p.zones[zone]) {
      p.zones[zone].bleeding = false
    }
    p.inv.bandage = Math.max(0, (p.inv.bandage || 0) - 1)
  }

  else if (treatment === 'tourniquet') {
    if (zone === 'head') return patient // blocked on head
    if (!p.zones[zone]) p.zones[zone] = { inj: null, bleeding: false, tq: false }
    p.zones[zone].tq      = true
    p.zones[zone].bleeding = false
    p.inv.tourniquet = Math.max(0, (p.inv.tourniquet || 0) - 1)
  }

  else if (treatment === 'stim') {
    if (!p.uncon) {
      // OVERDOSE — heart rate spikes to critical
      p.overdosed = true
      p.hr = 215
    } else {
      p.uncon    = false
      p.overdosed = false
    }
    p.inv.stim = Math.max(0, (p.inv.stim || 0) - 1)
  }

  else if (treatment === 'depressant') {
    p.hr       = 55
    p.inv.depressant = Math.max(0, (p.inv.depressant || 0) - 1)
  }

  else if (treatment === 'blood') {
    p.bloodPct = Math.min(100, (p.bloodPct || 0) + 40)
    p.inv.blood = Math.max(0, (p.inv.blood || 0) - 1)
  }

  return p
}

// ── GET APPLY DURATION ────────────────────────────────────────────────────────
export function getApplyDuration(patient, zone, treatment) {
  if (treatment === 'bandage') {
    const inj = patient.zones?.[zone]?.inj
    return inj === 'FRAG' ? APPLY_MS.bandage_frag : APPLY_MS.bandage_bleed
  }
  return APPLY_MS[treatment] || 3000
}

// ── MARK DOWNED (write to Firestore) ─────────────────────────────────────────
export async function markDowned(cardId, patientId, callsign, roleLoadout) {
  const zones = generateInjuries()
  const state = {
    callsign,
    down:      true,
    uncon:     true,
    overdosed: false,
    zones,
    bloodPct:  100,
    hr:        78,
    inv:       { ...roleLoadout },
    downdAt:   Date.now(),
  }
  await setPatientMedical(cardId, patientId, state)
  return state
}

// ── REVIVE (clear from Firestore) ─────────────────────────────────────────────
export async function revivePatient(cardId, patientId) {
  await clearPatientMedical(cardId, patientId)
}

// ── SYNC TREATMENT TO FIRESTORE ───────────────────────────────────────────────
export async function syncTreatment(cardId, patientId, updatedPatient) {
  await updatePatientMedical(cardId, patientId, {
    zones:     updatedPatient.zones,
    bloodPct:  updatedPatient.bloodPct,
    hr:        updatedPatient.hr,
    uncon:     updatedPatient.uncon,
    overdosed: updatedPatient.overdosed,
    inv:       updatedPatient.inv,
  })
}

// ── IS BLEEDING ANYWHERE ──────────────────────────────────────────────────────
export function isBleedingAnywhere(zones) {
  return Object.values(zones || {}).some(s => s.bleeding && !s.tq)
}

// ── DRAIN BLOOD TICK (call every second when bleeding) ────────────────────────
export function tickBloodDrain(currentPct) {
  return Math.max(0, currentPct - 1.2)
}

// ── COMPUTE HR ────────────────────────────────────────────────────────────────
export function computeHR(currentHR, down, uncon, bloodPct, overdosed) {
  if (overdosed) return Math.min(220, Math.round(currentHR + (Math.random() - 0.3) * 8))
  let base = 78
  if (down) base = uncon ? 145 : 110
  if (bloodPct < 40) base += 32
  else if (bloodPct < 70) base += 16
  const next = base + (Math.random() - 0.5) * 6 + (currentHR - base) * 0.28
  return Math.round(Math.max(38, Math.min(220, next)))
}
