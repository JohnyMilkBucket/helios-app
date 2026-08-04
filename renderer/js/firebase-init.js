// renderer/js/firebase-init.js
// Initializes Firebase using the config from firebase.config.js (loaded via preload)

import { initializeApp }    from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js'
import { getAuth }          from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js'
import { getFirestore }     from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
import { getDatabase }      from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js'

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  PASTE YOUR FIREBASE CONFIG HERE                                         ║
// ║                                                                          ║
// ║  1. Go to https://console.firebase.google.com                           ║
// ║  2. Your Project → Project Settings → Your Apps → Web App               ║
// ║  3. Copy the firebaseConfig object                                       ║
// ║  4. Replace everything in the FIREBASE_CONFIG object below               ║
// ╚══════════════════════════════════════════════════════════════════════════╝

const FIREBASE_CONFIG = {
  apiKey:            "PASTE_YOUR_API_KEY_HERE",
  authDomain:        "PASTE_YOUR_AUTH_DOMAIN_HERE",
  databaseURL:       "PASTE_YOUR_DATABASE_URL_HERE",
  projectId:         "PASTE_YOUR_PROJECT_ID_HERE",
  storageBucket:     "PASTE_YOUR_STORAGE_BUCKET_HERE",
  messagingSenderId: "PASTE_YOUR_MESSAGING_SENDER_ID_HERE",
  appId:             "PASTE_YOUR_APP_ID_HERE",
}

const firebaseApp = initializeApp(FIREBASE_CONFIG)

export const auth = getAuth(firebaseApp)
export const db   = getFirestore(firebaseApp)
export const rtdb = getDatabase(firebaseApp)
