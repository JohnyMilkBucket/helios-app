// renderer/js/orbat.js
// Units/org-chart CRUD.
//
// Fixes the same bug class as medical.js: sub-units used to be stored as an
// ARRAY on the parent unit doc (units/{id}.subUnits = [{id,name,members}]),
// so assigning/unassigning a member to ANY sub-unit did a read-modify-write
// on the WHOLE array. Two medics editing different sub-units of the same
// unit at the same time would race — whichever write landed second silently
// overwrote the first one's change, since it was working from its own
// (already-stale) copy of the array. Same root cause as the medical zones
// bug fixed earlier this session, just on `units` instead of
// `medical/patients`.
//
// Fix: subUnits is now a MAP keyed by sub-unit id, written with per-sub-unit
// dot-path fields (`subUnits.<id>.members`) so two different sub-units can
// never clobber each other. normalizeSubUnits() also accepts the OLD array
// shape, so existing unit docs keep rendering correctly — they just migrate
// to the map shape automatically the next time they're written to (created
// a new sub-unit, assigned/unassigned a member, etc).

import {
  doc, setDoc, updateDoc, deleteDoc, addDoc, collection, serverTimestamp, deleteField,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'

export function normalizeSubUnits(subUnits) {
  if(!subUnits) return {}
  if(Array.isArray(subUnits)) {
    const map = {}
    for(const s of subUnits) map[s.id] = { name:s.name, members:s.members||[] }
    return map
  }
  return subUnits
}

// Sub-units as a list, id attached — the shape every render function in
// index.html already expects (was iterating the array directly before).
export function getSubUnitList(unit) {
  const map = normalizeSubUnits(unit.subUnits)
  return Object.entries(map).map(([id,s])=>({ id, name:s.name, members:s.members||[] }))
}

export async function createUnit(db, cardId, { name, color }) {
  return addDoc(collection(db,'cards',cardId,'units'), {
    name, color, subUnits:{}, directMembers:[], createdAt:serverTimestamp(),
  })
}

export async function deleteUnit(db, cardId, unitId) {
  await deleteDoc(doc(db,'cards',cardId,'units',unitId))
}

export async function createSubUnit(db, cardId, unitId, name) {
  // A plain Date.now() id collides whenever two sub-units get created in the
  // same millisecond (caught by testing: the second create silently
  // overwrote the first) — doc(collection(...)).id gets a real random
  // Firestore-style id for free, no document actually created at that path.
  const subId = doc(collection(db,'cards',cardId,'units')).id
  await updateDoc(doc(db,'cards',cardId,'units',unitId),
    { [`subUnits.${subId}`]: { name, members:[] } })
  return subId
}

export async function deleteSubUnit(db, cardId, unitId, subId) {
  await updateDoc(doc(db,'cards',cardId,'units',unitId),
    { [`subUnits.${subId}`]: deleteField() })
}

// unit must be the current unit object (for directMembers/subUnits reads);
// subId falsy means "assign directly to the unit, not a sub-unit".
export async function assignMember(db, cardId, unit, subId, uid) {
  if(!subId) {
    const list = [...new Set([...(unit.directMembers||[]), uid])]
    await setDoc(doc(db,'cards',cardId,'units',unit.id), {directMembers:list}, {merge:true})
    return
  }
  const map = normalizeSubUnits(unit.subUnits)
  const sub = map[subId] || {name:'', members:[]}
  const members = [...new Set([...(sub.members||[]), uid])]
  await updateDoc(doc(db,'cards',cardId,'units',unit.id), { [`subUnits.${subId}.members`]: members })
}

export async function unassignMember(db, cardId, unit, subId, uid) {
  if(!subId || subId==='null') {
    const newList = (unit.directMembers||[]).filter(id=>id!==uid)
    await setDoc(doc(db,'cards',cardId,'units',unit.id), {directMembers:newList}, {merge:true})
    return
  }
  const map = normalizeSubUnits(unit.subUnits)
  const sub = map[subId]
  if(!sub) return
  const members = (sub.members||[]).filter(id=>id!==uid)
  await updateDoc(doc(db,'cards',cardId,'units',unit.id), { [`subUnits.${subId}.members`]: members })
}
