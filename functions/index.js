// Helios Cloud Functions — push notifications for medical events.
//
// Everything here reacts to writes on medical/{cardId}/patients/{uid}, the
// same casualty doc renderer/js/medical.js (and its hosting/ mirror)
// already read/write directly. This function never writes game state — it
// only reads the before/after snapshots Firestore hands it and, when a
// state transition matches something worth alerting on, sends a push via
// FCM to the affected player's (or that card's medics') registered device
// tokens. Tokens live on cards/{cardId}/members/{uid}.fcmTokens, written by
// the client itself when notification permission is granted (see
// hosting/index.html's enableAlerts()).
//
// This complements, not replaces, the foreground alertUser() sound+
// Notification calls already in hosting/index.html — those fire instantly
// while the tab is open; this fires even if the app is fully closed, at
// the cost of the extra network hop through FCM.

const { onDocumentWritten } = require('firebase-functions/v2/firestore')
const { initializeApp } = require('firebase-admin/app')
const { getFirestore, FieldValue } = require('firebase-admin/firestore')
const { getMessaging } = require('firebase-admin/messaging')

initializeApp()
const db = getFirestore()

const DEATH_LABEL = { headshot: 'HEAD TRAUMA', bleed_out: 'BLED OUT', cardiac_arrest: 'CARDIAC ARREST' }

// Sends to every token on a member doc, then prunes any token FCM reports
// as no-longer-registered (uninstalled app, revoked permission, etc) so
// the array doesn't grow stale forever.
async function sendToTokens(cardId, uid, title, body) {
  const memberRef = db.doc(`cards/${cardId}/members/${uid}`)
  const memberSnap = await memberRef.get()
  const tokens = memberSnap.data()?.fcmTokens || []
  if (!tokens.length) return

  const resp = await getMessaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    webpush: { fcmOptions: { link: 'https://helios-app-c803f.web.app' } },
  })

  const dead = []
  resp.responses.forEach((r, i) => {
    if (!r.success && r.error?.code === 'messaging/registration-token-not-registered') dead.push(tokens[i])
  })
  if (dead.length) await memberRef.update({ fcmTokens: FieldValue.arrayRemove(...dead) })
}

async function notifyMedics(cardId, excludeUid, title, body) {
  const membersSnap = await db.collection(`cards/${cardId}/members`).get()
  const medics = membersSnap.docs.filter(d => {
    const m = d.data()
    return d.id !== excludeUid && (m.canTreatOthers || m.isAdmin)
  })
  await Promise.all(medics.map(d => sendToTokens(cardId, d.id, title, body)))
}

exports.onCasualtyWrite = onDocumentWritten('medical/{cardId}/patients/{uid}', async (event) => {
  const { cardId, uid } = event.params
  const before = event.data.before.exists ? event.data.before.data() : null
  const after = event.data.after.exists ? event.data.after.data() : null

  if (!after) return // doc deleted (revive) — nothing to alert on

  // New casualty (doc just created) — always alert medics/admins on the
  // card. markDown() always creates fresh (revive deletes the doc first,
  // so there's no "update" path into an existing casualty doc) — which
  // means an instant headshot death is ALSO a creation, not an update, so
  // the self "YOU DIED" alert has to be checked here too, not only in the
  // update branch below (a doc created already-dead would otherwise never
  // reach that check).
  if (!before) {
    const name = after.username || 'A player'
    await notifyMedics(cardId, uid, 'NEW CASUALTY', `${name} needs treatment.`)
    if (after.dead) await sendToTokens(cardId, uid, 'YOU DIED', DEATH_LABEL[after.deathCause] || 'Medical emergency')
    else if (after.uncon) await sendToTokens(cardId, uid, 'UNCONSCIOUS', 'You went down and are unconscious — you need a medic.')
    return
  }

  // Transitions within an existing casualty doc (bleed-out / cardiac
  // arrest / knockout ticks and tourniquet-numbness all update in place).
  if (!before.dead && after.dead) {
    await sendToTokens(cardId, uid, 'YOU DIED', DEATH_LABEL[after.deathCause] || 'Medical emergency')
    return // dead supersedes uncon/tqNumb — no need to also fire those
  }
  if (!before.uncon && after.uncon) {
    await sendToTokens(cardId, uid, 'UNCONSCIOUS', 'Blood loss knocked you out — you need a medic.')
  }
  const beforeZones = before.zones || {}
  const afterZones = after.zones || {}
  for (const zone of Object.keys(afterZones)) {
    if (afterZones[zone]?.tqNumb && !beforeZones[zone]?.tqNumb) {
      await sendToTokens(cardId, uid, 'LIMB NUMB', 'A tourniquet has been on too long — circulation is going.')
      break // one push is enough even if multiple zones went numb in the same write
    }
  }
})
