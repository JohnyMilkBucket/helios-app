// ╔══════════════════════════════════════════════════════════════════════════╗
// ║                    HELIOS — FIREBASE CONFIGURATION                       ║
// ║                                                                          ║
// ║  HOW TO GET THIS:                                                        ║
// ║  1. Go to https://console.firebase.google.com                           ║
// ║  2. Create a new project (or use existing one)                           ║
// ║  3. Click the gear icon → Project Settings                              ║
// ║  4. Scroll down to "Your apps" → click Web (</>)                        ║
// ║  5. Register app as "Helios"                                             ║
// ║  6. Copy the firebaseConfig object and paste it below                   ║
// ║                                                                          ║
// ║  ALSO ENABLE THESE IN FIREBASE CONSOLE:                                 ║
// ║  • Authentication → Sign-in method → Email/Password → ENABLE            ║
// ║  • Firestore Database → Create database → Start in production mode       ║
// ║  • Realtime Database → Create database (used for voice signaling)        ║
// ║                                                                          ║
// ╚══════════════════════════════════════════════════════════════════════════╝

const FIREBASE_CONFIG = {
  // ↓↓↓ PASTE YOUR firebaseConfig VALUES HERE ↓↓↓
  apiKey:            "PASTE_YOUR_API_KEY_HERE",
  authDomain:        "PASTE_YOUR_AUTH_DOMAIN_HERE",
  databaseURL:       "PASTE_YOUR_DATABASE_URL_HERE",
  projectId:         "PASTE_YOUR_PROJECT_ID_HERE",
  storageBucket:     "PASTE_YOUR_STORAGE_BUCKET_HERE",
  messagingSenderId: "PASTE_YOUR_MESSAGING_SENDER_ID_HERE",
  appId:             "PASTE_YOUR_APP_ID_HERE",
  // ↑↑↑ END PASTE ↑↑↑
}

// ── HELIOS INTERNAL SETTINGS ─────────────────────────────────────────────────
// Internal email domain used to store Firebase accounts
// Users only see/type their callsign — this is hidden from them
const HELIOS_EMAIL_DOMAIN = "@helios.internal"

module.exports = { FIREBASE_CONFIG, HELIOS_EMAIL_DOMAIN }
