// renderer/js/db.js
// All Firestore read/write operations with real-time listeners

import { db } from './firebase-init.js'
import {
  collection, doc,
  addDoc, setDoc, updateDoc, deleteDoc, getDoc, getDocs,
  onSnapshot, query, where, orderBy, serverTimestamp,
  arrayUnion, arrayRemove, increment
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'

// ── CARDS ─────────────────────────────────────────────────────────────────────

export async function createCard(name, ownerId, ownerCallsign) {
  const cardRef = await addDoc(collection(db, 'cards'), {
    name,
    ownerId,
    createdAt: serverTimestamp(),
  })

  // Owner joins as first member with full permissions
  await setDoc(doc(db, 'cards', cardRef.id, 'members', ownerId), {
    callsign:      ownerCallsign,
    uid:           ownerId,
    role:          'owner',
    isAdmin:       true,
    canTreatOthers: true,
    canCreateOps:  true,
    canEditBrevity: true,
    joinedAt:      serverTimestamp(),
    online:        true,
  })

  // Default roles
  const defaultRoles = [
    { name:'OWNER',      color:'#fbbf24', isAdmin:true,  canTreatOthers:true,  canCreateOps:true,  canEditBrevity:true,  ld:{bandage:10,tourniquet:5,stim:3,depressant:3,blood:3} },
    { name:'ADMIN',      color:'#a78bfa', isAdmin:true,  canTreatOthers:true,  canCreateOps:true,  canEditBrevity:true,  ld:{bandage:5, tourniquet:3,stim:2,depressant:2,blood:2} },
    { name:'OPERATIONS', color:'#8db3d4', isAdmin:false, canTreatOthers:false, canCreateOps:true,  canEditBrevity:true,  ld:{bandage:3, tourniquet:2,stim:1,depressant:1,blood:0} },
    { name:'JTAC',       color:'#4ade80', isAdmin:false, canTreatOthers:false, canCreateOps:false, canEditBrevity:false, ld:{bandage:3, tourniquet:2,stim:1,depressant:1,blood:0} },
    { name:'MEDIC',      color:'#f87171', isAdmin:false, canTreatOthers:true,  canCreateOps:false, canEditBrevity:false, ld:{bandage:10,tourniquet:5,stim:3,depressant:3,blood:3} },
    { name:'OPERATOR',   color:'#a8b8cc', isAdmin:false, canTreatOthers:false, canCreateOps:false, canEditBrevity:false, ld:{bandage:3, tourniquet:2,stim:0,depressant:0,blood:0} },
  ]
  for (const role of defaultRoles) {
    await addDoc(collection(db, 'cards', cardRef.id, 'roles'), role)
  }

  // Default channels
  const defaultChannels = [
    { name:'COMMAND NET', freq:'142.50', locked:false },
    { name:'MEDEVAC',     freq:'160.75', locked:false },
  ]
  for (const ch of defaultChannels) {
    await addDoc(collection(db, 'cards', cardRef.id, 'channels'), ch)
  }

  // Default brevity
  const defaultBrevity = [
    {code:'WINCHESTER', def:'Out of ammunition'},
    {code:'BINGO',      def:'Fuel state for RTB'},
    {code:'TALLY',      def:'Sighting of target'},
    {code:'NO JOY',     def:'No visual on target'},
    {code:'BROKEN ARROW', def:'Friendly position overrun'},
    {code:'TROOPS IN CONTACT', def:'Engaged with hostile force'},
    {code:'DANGER CLOSE', def:'Friendly within burst radius'},
  ]
  for (const b of defaultBrevity) {
    await addDoc(collection(db, 'cards', cardRef.id, 'brevity'), b)
  }

  return cardRef.id
}

export async function getCard(cardId) {
  const snap = await getDoc(doc(db, 'cards', cardId))
  return snap.exists() ? { id: snap.id, ...snap.data() } : null
}

// Real-time listener for card data
export function listenCard(cardId, callback) {
  return onSnapshot(doc(db, 'cards', cardId), snap => {
    if (snap.exists()) callback({ id: snap.id, ...snap.data() })
  })
}

// ── MEMBERS ───────────────────────────────────────────────────────────────────

export async function joinCard(cardId, uid, callsign, inviteCode) {
  // In production, validate inviteCode against card document
  // For now just join
  await setDoc(doc(db, 'cards', cardId, 'members', uid), {
    callsign,
    uid,
    role:          'operator',
    isAdmin:       false,
    canTreatOthers: false,
    canCreateOps:  false,
    canEditBrevity: false,
    joinedAt:      serverTimestamp(),
    online:        true,
  })
}

export async function updateMember(cardId, uid, data) {
  await updateDoc(doc(db, 'cards', cardId, 'members', uid), data)
}

export function listenMembers(cardId, callback) {
  return onSnapshot(collection(db, 'cards', cardId, 'members'), snap => {
    const members = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    callback(members)
  })
}

export async function getMember(cardId, uid) {
  const snap = await getDoc(doc(db, 'cards', cardId, 'members', uid))
  return snap.exists() ? { id: snap.id, ...snap.data() } : null
}

// ── ROLES ─────────────────────────────────────────────────────────────────────

export function listenRoles(cardId, callback) {
  return onSnapshot(collection(db, 'cards', cardId, 'roles'), snap => {
    const roles = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    callback(roles)
  })
}

export async function createRole(cardId, roleData) {
  return await addDoc(collection(db, 'cards', cardId, 'roles'), roleData)
}

export async function updateRole(cardId, roleId, data) {
  await updateDoc(doc(db, 'cards', cardId, 'roles', roleId), data)
}

export async function deleteRole(cardId, roleId) {
  await deleteDoc(doc(db, 'cards', cardId, 'roles', roleId))
}

// ── CHANNELS ──────────────────────────────────────────────────────────────────

export function listenChannels(cardId, callback) {
  return onSnapshot(collection(db, 'cards', cardId, 'channels'), snap => {
    const channels = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    callback(channels)
  })
}

export async function createChannel(cardId, data) {
  return await addDoc(collection(db, 'cards', cardId, 'channels'), data)
}

export async function updateChannel(cardId, chanId, data) {
  await updateDoc(doc(db, 'cards', cardId, 'channels', chanId), data)
}

export async function deleteChannel(cardId, chanId) {
  await deleteDoc(doc(db, 'cards', cardId, 'channels', chanId))
}

// ── OPERATIONS ────────────────────────────────────────────────────────────────

export function listenOperations(cardId, callback) {
  const q = query(collection(db, 'cards', cardId, 'operations'), orderBy('createdAt', 'desc'))
  return onSnapshot(q, snap => {
    const ops = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    callback(ops)
  })
}

export async function createOperation(cardId, data) {
  return await addDoc(collection(db, 'cards', cardId, 'operations'), {
    ...data,
    status: 'active',
    createdAt: serverTimestamp(),
  })
}

export async function updateOperation(cardId, opId, data) {
  await updateDoc(doc(db, 'cards', cardId, 'operations', opId), data)
}

// ── BREVITY ───────────────────────────────────────────────────────────────────

export function listenBrevity(cardId, callback) {
  return onSnapshot(collection(db, 'cards', cardId, 'brevity'), snap => {
    const codes = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    callback(codes)
  })
}

export async function addBrevity(cardId, code, def) {
  return await addDoc(collection(db, 'cards', cardId, 'brevity'), {
    code: code.toUpperCase().trim(),
    def: def.trim(),
    createdAt: serverTimestamp(),
  })
}

export async function deleteBrevity(cardId, codeId) {
  await deleteDoc(doc(db, 'cards', cardId, 'brevity', codeId))
}

// ── MEDICAL ───────────────────────────────────────────────────────────────────

// Get initial medical state (called when patient marks downed)
export async function getPatientMedical(cardId, patientId) {
  const snap = await getDoc(doc(db, 'medical', cardId, 'patients', patientId))
  return snap.exists() ? snap.data() : null
}

// Write entire medical state for a patient
export async function setPatientMedical(cardId, patientId, data) {
  await setDoc(doc(db, 'medical', cardId, 'patients', patientId), {
    ...data,
    updatedAt: serverTimestamp(),
  })
}

// Update specific fields on a patient's medical record
export async function updatePatientMedical(cardId, patientId, data) {
  await setDoc(doc(db, 'medical', cardId, 'patients', patientId), {
    ...data,
    updatedAt: serverTimestamp(),
  }, { merge: true })
}

// Real-time listener for ALL patients in a card (for medic view)
export function listenAllPatients(cardId, callback) {
  return onSnapshot(collection(db, 'medical', cardId, 'patients'), snap => {
    const patients = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    callback(patients)
  })
}

// Real-time listener for a single patient (player's own view)
export function listenPatient(cardId, patientId, callback) {
  return onSnapshot(doc(db, 'medical', cardId, 'patients', patientId), snap => {
    if (snap.exists()) callback(snap.data())
    else callback(null)
  })
}

// Clear patient medical record on revive
export async function clearPatientMedical(cardId, patientId) {
  await deleteDoc(doc(db, 'medical', cardId, 'patients', patientId))
}
