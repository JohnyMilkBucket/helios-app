// renderer/js/auth.js
// Handles all authentication — callsign-only (Firebase email hidden from user)

import { auth, db } from './firebase-init.js'
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js'
import {
  doc, setDoc, getDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'

// Convert callsign to internal Firebase email
// User never sees this — they only ever type their callsign
function callsignToEmail(callsign) {
  // Sanitize: lowercase, remove special chars, add domain
  const safe = callsign.toLowerCase().replace(/[^a-z0-9._-]/g, '')
  return `${safe}@helios.internal`
}

// ── REGISTER ─────────────────────────────────────────────────────────────────
export async function register(callsign, password) {
  if (!callsign || callsign.length < 2) throw new Error('Callsign must be at least 2 characters')
  if (!password || password.length < 6)  throw new Error('Auth key must be at least 6 characters')

  const email = callsignToEmail(callsign)

  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password)
    const uid  = cred.user.uid

    // Create user profile in Firestore
    await setDoc(doc(db, 'users', uid), {
      callsign:    callsign.toUpperCase(),
      uid,
      createdAt:   serverTimestamp(),
      currentCard: null,
      online:      true,
    })

    return cred.user
  } catch (err) {
    if (err.code === 'auth/email-already-in-use') {
      throw new Error('Callsign already taken — choose a different one')
    }
    throw err
  }
}

// ── LOGIN ─────────────────────────────────────────────────────────────────────
export async function login(callsign, password) {
  if (!callsign || !password) throw new Error('Callsign and auth key required')

  const email = callsignToEmail(callsign)

  try {
    const cred = await signInWithEmailAndPassword(auth, email, password)

    // Update online status
    await setDoc(doc(db, 'users', cred.user.uid), { online: true }, { merge: true })

    return cred.user
  } catch (err) {
    if (err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
      throw new Error('Invalid callsign or auth key')
    }
    throw err
  }
}

// ── LOGOUT ────────────────────────────────────────────────────────────────────
export async function logout(uid) {
  if (uid) {
    await setDoc(doc(db, 'users', uid), { online: false }, { merge: true })
  }
  await signOut(auth)
}

// ── GET USER PROFILE ──────────────────────────────────────────────────────────
export async function getUserProfile(uid) {
  const snap = await getDoc(doc(db, 'users', uid))
  return snap.exists() ? snap.data() : null
}

// ── AUTH STATE LISTENER ───────────────────────────────────────────────────────
export function onAuth(callback) {
  return onAuthStateChanged(auth, callback)
}
