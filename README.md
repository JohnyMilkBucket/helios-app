# HELIOS — SETUP GUIDE
## Tactical Overlay for BRM5

---

## WHAT YOU NEED BEFORE STARTING
- Node.js v18+ → https://nodejs.org
- A Google account (for Firebase)
- Git (optional but recommended)

---

## STEP 1 — FIREBASE SETUP

### 1A. Create Firebase Project
1. Go to https://console.firebase.google.com
2. Click **Add project**
3. Name it `helios` (or anything you want)
4. Disable Google Analytics (not needed)
5. Click **Create project**

### 1B. Enable Authentication
1. In Firebase Console → **Authentication** → **Get started**
2. Click **Email/Password**
3. Toggle **Enable** → Save
> Note: Users won't see emails. Helios uses callsigns internally converted to fake emails.

### 1C. Create Firestore Database
1. In Firebase Console → **Firestore Database** → **Create database**
2. Select **Start in production mode**
3. Choose a region closest to your players (us-east1, europe-west1, etc.)
4. Click **Enable**

### 1D. Apply Firestore Rules
1. In Firestore → **Rules** tab
2. Delete everything in the editor
3. Open `firestore.rules` from this folder
4. Copy everything below the dashed line
5. Paste into Firebase Rules editor
6. Click **Publish**

### 1E. Create Realtime Database (for voice signaling)
1. In Firebase Console → **Realtime Database** → **Create database**
2. Select **Start in locked mode**
3. Choose a region
4. Click **Enable**
5. Go to **Rules** tab and replace with:
```json
{
  "rules": {
    "rtc": {
      "$cardId": {
        ".read":  "auth != null",
        ".write": "auth != null"
      }
    }
  }
}
```
6. Click **Publish**

### 1F. Get Your Firebase Config
1. In Firebase Console → **Project Settings** (gear icon) → **General**
2. Scroll to **Your apps** → Click **</>** (Web) if you haven't added an app yet
3. Register the app as `Helios Web`
4. You'll see a `firebaseConfig` object — **copy it**

---

## STEP 2 — PASTE YOUR FIREBASE CONFIG

Open **`renderer/js/firebase-init.js`** and find this section:

```javascript
const FIREBASE_CONFIG = {
  apiKey:            "PASTE_YOUR_API_KEY_HERE",
  authDomain:        "PASTE_YOUR_AUTH_DOMAIN_HERE",
  ...
```

Replace it with your actual config. It will look like:

```javascript
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyBxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  authDomain:        "helios-xxxxx.firebaseapp.com",
  databaseURL:       "https://helios-xxxxx-default-rtdb.firebaseio.com",
  projectId:         "helios-xxxxx",
  storageBucket:     "helios-xxxxx.appspot.com",
  messagingSenderId: "123456789012",
  appId:             "1:123456789012:web:xxxxxxxxxxxxxxxx",
}
```

**Save the file.**

---

## STEP 3 — INSTALL AND RUN

Open a terminal in this folder and run:

```bash
# Install dependencies
npm install

# Run in development
npm start
```

The Helios overlay will launch. It will be transparent and always on top of your game.

---

## STEP 4 — BUILD EXE (for distribution)

```bash
# Build Windows EXE installer
npm run build

# The installer will be in: dist/Helios Setup X.X.X.exe
```

---

## STEP 5 — FIRST USE

1. Launch Helios
2. Click **NEW ACCOUNT** and enter your callsign + auth key
3. The person setting up the faction clicks **CREATE CARD** and enters a faction name
4. Share the **Card ID** with your team (shown in settings)
5. Team members click **JOIN CARD** and paste the Card ID

---

## FILE STRUCTURE

```
helios-app/
├── main.js              ← Electron — transparent window setup
├── preload.js           ← Electron — IPC bridge (don't touch)
├── package.json         ← Dependencies
├── firebase.config.js   ← Backup config reference (not used at runtime)
├── firestore.rules      ← Paste into Firebase Console
└── renderer/
    ├── index.html       ← Main app UI
    ├── css/
    │   └── style.css    ← All styles
    └── js/
        ├── firebase-init.js  ← ★ PASTE YOUR CONFIG HERE ★
        ├── auth.js           ← Login / register logic
        ├── db.js             ← All Firestore operations
        ├── voice.js          ← WebRTC voice channels
        ├── medical.js        ← Medical system logic
        └── app.js            ← Main app — wires everything together
```

---

## OVERLAY CONTROLS (in app)

| Control | What it does |
|---------|-------------|
| Title bar drag | Move the window |
| Opacity slider | Make more/less transparent |
| Pin button | Toggle always-on-top |
| Click-through toggle | Let clicks pass through to game |

---

## VOICE CHANNEL NOTES

- Voice uses **WebRTC** — direct peer-to-peer audio (no server relay needed for most connections)
- Firebase Realtime Database is only used for the initial connection handshake
- STUN servers (Google's free) handle most NAT traversal
- If players on strict NATs can't connect, you'll need to add TURN servers to `voice.js`

---

## PERMISSIONS REFERENCE

| Permission | Who it affects |
|-----------|---------------|
| `isAdmin` | Can manage roles, channels, members |
| `canTreatOthers` | Can apply treatments to other players (Medic role) |
| `canCreateOps` | Can create and archive operations |
| `canEditBrevity` | Can add/remove brevity codes |
| Multi-channel join | Set per-role in the Roles tab |

---

## TROUBLESHOOTING

**"Cannot read firebaseConfig"** → You didn't paste your config into `renderer/js/firebase-init.js`

**Voice not working** → Check browser mic permissions. Electron may need: Add `--use-fake-ui-for-media-stream` to main.js args for testing

**App not transparent** → Transparency requires a compositor on Linux. On Windows/Mac it works out of the box.

**"Permission denied" from Firestore** → Your Firestore Rules weren't applied correctly. Re-paste from `firestore.rules`

**Players can't join card** → Share the Card ID from the Settings panel (gear icon on the card header)
