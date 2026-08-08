// renderer/js/roles.js
// Role CRUD + permission/loadout resolution.
//
// Design note: role perms/color/loadout are still denormalized onto each
// member doc at assignment time (fan-out write on every role edit) — that
// part of the old design is kept as-is here, since removing it would mean
// migrating every other place in the app that reads a member's color/perms/
// loadout directly off the member doc (roster, ORBAT, channel rosters,
// patient display, ...), which is a much larger and riskier change than
// this pass covers. What's fixed here are the two concrete bugs found this
// session:
//   1. editRolePerms() used to require an existing member with that role to
//      even open — a brand-new role with 0 members couldn't have its
//      permissions edited at all. Now resolves from the role doc first.
//   2. New roles silently defaulted to an all-zero loadout with no way to
//      set it at creation time — the "NEW ROLE" modal now takes starting
//      loadout numbers directly instead of trapping admins into a zero
//      loadout they have to discover and fix after the fact.
// Also removed a dead, never-called duplicate of updateRoleLoadout that
// updated members but not the role collection doc.

import {
  doc, setDoc, deleteDoc, addDoc, collection,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'

export const DEFAULT_LD = {bandage:0,tourniquet:0,chestseal:0,splint:0,stim:0,depressant:0,blood:0,morphine:0}
export const PERM_KEYS = ['isAdmin','canTreatOthers','canCreateOps','canEditBrevity','canMultiChan']

// Pure — takes data rather than reading global state, so it's testable and
// has one definition instead of being reimplemented at each call site.
// Unions the card's actual role documents with "legacy" roles that only
// exist because a member's `role` string isn't in the roles collection
// (handles cards created before the Roles tab existed).
export function getEffectiveRoles(cardRoles, members) {
  const collectionRoleNames = new Set(cardRoles.map(r=>r.name))
  const memberOnlyRoles = [...new Set(members.map(m=>m.role).filter(Boolean))]
    .filter(r => !collectionRoleNames.has(r))
    .map(name => {
      const rep = members.find(m=>m.role===name)
      return { id:'member-'+name, name, color:rep?.color||'#a8b8cc',
        ld:rep?.ld||{...DEFAULT_LD},
        isAdmin:rep?.isAdmin||false, canTreatOthers:rep?.canTreatOthers||false,
        canCreateOps:rep?.canCreateOps||false, canEditBrevity:rep?.canEditBrevity||false,
        canMultiChan:rep?.canMultiChan||false,
      }
    })
  return [...cardRoles, ...memberOnlyRoles].sort((a,b)=>(a.order??999)-(b.order??999))
}

// Resolve a role's current perms/color/loadout by name, preferring the
// actual role doc (authoritative), then a representative member (legacy
// roles that predate the roles collection), then a hardcoded safety net for
// the well-known role names — so e.g. a corrupted/incomplete OWNER role can
// never end up without admin rights.
const NAME_FALLBACKS = {
  isAdmin:        ['OWNER','ADMIN'],
  canTreatOthers: ['MEDIC'],
  canCreateOps:   ['OWNER','ADMIN','OPERATIONS'],
  canEditBrevity: ['OWNER','ADMIN','OPERATIONS'],
  canMultiChan:   ['JTAC'],
}
export function resolveRole(cardRoles, members, roleName) {
  const roleDoc = cardRoles.find(r=>r.name===roleName)
  const rep = members.find(m=>m.role===roleName)
  const perm = (key) => roleDoc?.[key] ?? (NAME_FALLBACKS[key].includes(roleName) || rep?.[key] || false)
  return {
    color: roleDoc?.color || rep?.color || '#a8b8cc',
    ld: roleDoc?.ld || rep?.ld || {...DEFAULT_LD},
    isAdmin:        perm('isAdmin'),
    canTreatOthers: perm('canTreatOthers'),
    canCreateOps:   perm('canCreateOps'),
    canEditBrevity: perm('canEditBrevity'),
    canMultiChan:   perm('canMultiChan'),
  }
}

export async function createRole(db, cardId, { name, color, order, ld, isAdmin, canTreatOthers, canCreateOps, canEditBrevity, canMultiChan, createdAt }) {
  return addDoc(collection(db,'cards',cardId,'roles'), {
    name, color, order,
    ld: { ...DEFAULT_LD, ...ld },
    isAdmin: !!isAdmin, canTreatOthers: !!canTreatOthers,
    canCreateOps: !!canCreateOps, canEditBrevity: !!canEditBrevity,
    canMultiChan: !!canMultiChan,
    createdAt,
  })
}

export async function deleteRole(db, cardId, roleId) {
  if(!roleId || roleId.startsWith('member-')) return
  await deleteDoc(doc(db,'cards',cardId,'roles',roleId))
}

export async function moveRole(db, cardId, cardRoles, roleId, dir) {
  if(!roleId || roleId.startsWith('member-')) return
  const sorted = [...cardRoles].sort((a,b)=>(a.order??999)-(b.order??999))
  const idx = sorted.findIndex(r=>r.id===roleId)
  if(idx<0) return
  const swapIdx = dir==='up' ? idx-1 : idx+1
  if(swapIdx<0||swapIdx>=sorted.length) return
  const a = sorted[idx], b = sorted[swapIdx]
  await setDoc(doc(db,'cards',cardId,'roles',a.id),{order:swapIdx},{merge:true})
  await setDoc(doc(db,'cards',cardId,'roles',b.id),{order:idx},{merge:true})
}

// Updates one loadout item both on the role collection doc (if it exists)
// and on every member currently assigned that role.
export async function updateRoleLoadout(db, cardId, cardRoles, members, roleName, key, val) {
  const roleDoc = cardRoles.find(r=>r.name===roleName)
  if(roleDoc) {
    await setDoc(doc(db,'cards',cardId,'roles',roleDoc.id), {ld:{...(roleDoc.ld||{}), [key]:val}}, {merge:true})
  }
  const affected = members.filter(m=>m.role===roleName)
  await Promise.all(affected.map(m =>
    setDoc(doc(db,'cards',cardId,'members',m.id), {ld:{...(m.ld||{}), [key]:val}}, {merge:true})
  ))
}

// Saves a full permission set both to the role doc and every current member.
export async function saveRolePerms(db, cardId, cardRoles, members, roleName, perms) {
  const roleDoc = cardRoles.find(r=>r.name===roleName)
  if(roleDoc) {
    await setDoc(doc(db,'cards',cardId,'roles',roleDoc.id), perms, {merge:true})
  }
  const affected = members.filter(m=>m.role===roleName)
  await Promise.all(affected.map(m =>
    setDoc(doc(db,'cards',cardId,'members',m.id), perms, {merge:true})
  ))
}

// Assigns memberId to newRole, denormalizing that role's current
// color/loadout/perms onto their member doc (see file header for why).
export async function applyRoleChange(db, cardId, cardRoles, members, memberId, newRole) {
  const resolved = resolveRole(cardRoles, members, newRole)
  await setDoc(doc(db,'cards',cardId,'members',memberId), { role:newRole, ...resolved }, {merge:true})
}
