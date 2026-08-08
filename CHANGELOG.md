# Changelog

All notable changes to Helios are documented here. Versions correspond to
GitHub releases.

## v1.4.20
- Fixed tourniquets not ticking toward numbness/limb loss when applied to
  a zone that was never actually injured (e.g. testing/preemptively
  applying one without going down first) — the numbness/loss clock, and
  the stim overdose ramp, no longer require the patient to be marked
  "down" to run.
- Self-treatment (bandage/TQ/stim/etc.) now works even before you've ever
  gone down — it used to fail outright since there was no casualty record
  yet to write to.
- A casualty record created this way doesn't show up in medics' PATIENTS
  list unless the patient is actually down or dead.

## v1.4.19
- Fixed "treatment failed to save" happening on stim, depressant, blood,
  and bandaging an uninjured zone — these writes always included whichever
  zone's treat panel happened to be open, even when that treatment doesn't
  touch a zone at all (systemic effects) or that zone has no injury entry.
  Firestore rejected the resulting undefined field outright.
- Rewrote treatment application to run inside a Firestore transaction that
  always reads the patient's current server state immediately before
  writing, instead of a possibly-stale local copy — two medics treating
  the same patient (even the same zone) at the same time can no longer
  silently clobber each other's work.

## v1.4.18
- Splinting a fracture no longer erases it — the zone now shows
  "(FRACTURE) SPLINT" so medics can still see it was fractured. Removing
  the splint brings the fracture back (the limb is impaired again until
  re-splinted).

## v1.4.17
- Fixed treating another patient sometimes silently doing nothing (most
  noticeable in the Medical pop-out window) — a stale/out-of-sync patient
  reference would let the treatment "complete" (sound played, supply
  consumed) without ever actually writing to the patient's record. Now it
  fails loudly with a real error instead of pretending it worked.

## v1.4.16
- Fixed a license key reuse bug — card creation and license renewal now go
  through a server-side Cloud Function instead of a client transaction, so
  a key can never be attached to more than one card. (Rules/backend fix,
  already live — this release just ships the matching client code.)

## v1.4.15
- Mobile companion now has a SWITCH CARD button (top bar) — lets you pick
  a different card without logging out, same as desktop. The card list
  also now shows real card names (with a CURRENT badge) instead of raw IDs.

## v1.4.14
- Fixed the mobile companion COPY LINK button doing nothing — it now
  copies via Electron's clipboard directly instead of the browser
  Clipboard API, which was failing silently in this window.

## v1.4.13
- Added a COPY LINK button next to the mobile companion URL in Settings —
  the app disables text selection globally, so that link couldn't be
  copied by hand before.

## v1.4.12
- Archived operations can now be permanently deleted (admin/canCreateOps
  only). An operation has to be archived first, so an active roster can
  never be deleted by mistake.

## v1.4.11
- Removed the 9-Line CASEVAC callout drawer/button from the Comms tab.

## v1.4.10
- Added a RULES tab (desktop + mobile) — your faction's own SOP text,
  written and edited by admins, visible to every member. Separate from the
  fixed radio-discipline presets under Joint Ops op types.
- Suspended accounts (managed from the separate admin panel) now get
  stopped at login with an appeal message instead of reaching the app, on
  both desktop and mobile.

## v1.4.9
- Mobile companion now sends real push notifications for medical events
  (new casualty, you died, unconscious, tourniquet-too-long) — these arrive
  even when the app is fully closed, as long as you've granted notification
  permission via "Enable Alerts." Backed by a new Cloud Function reacting to
  casualty writes in Firestore.

## v1.4.8
- Mobile companion gets a new ORG tab: read-only ORBAT (units, sub-units,
  assigned members) and Roles (perms, loadouts, member counts).
- Mobile companion now shows an active Joint Operation (if your card is in
  one) with the shared casualty board, read-only.

## v1.4.7
- Added an activity log to the Admin panel — who treated whom, who went
  down/revived, who started/archived operations, with timestamps.
- Operations now show a live casualty count (desktop op cards and mobile
  Past Operations), tallied from the new activity log.

## v1.4.6
- Mobile companion is now installable as a real app (add to home screen,
  works on Android and iOS).
- Mobile companion can show sound + browser alerts while open — you're
  marked down/die, get knocked unconscious, a tourniquet's been on too
  long, or (for medics) a new casualty appears. Opt-in via an "Enable
  Alerts" button.
- Operations tab (desktop + mobile) now shows roster size on every op, and
  archived ops are clearly labeled instead of just losing their ACTIVE
  badge. Mobile dashboard now also shows a short "Past Operations" history.

## v1.4.5
- Added a mobile web companion at helios-app-c803f.web.app — same account,
  same card, no install. Check the roster, active operation, and
  casualties, and treat patients (including yourself) from a phone.
  Comms, ORBAT, roles, and admin tools remain desktop-only for now.

## v1.4.4
- Added a short tutorial for every tab (Operations, Medical, Comms, ORBAT,
  Roles, Joint Ops, Admin, Settings). Shows once automatically the first
  time you open that tab, can be skipped, and can be replayed any time
  from Settings → Tutorials.

## v1.4.3
- Added an in-app "What's New" panel (auto-shows once per update, plus a
  button in Settings to view anytime) and this changelog.
- Login screen now shows the real running version instead of a stale
  hardcoded "v1.0".
- Fixed a real bug affecting every confirm dialog in the app: close/cancel
  buttons were silently throwing an error and doing nothing (only clicking
  the backdrop worked). All modal buttons now work correctly.

## v1.4.2
- Fixed the PTT "transmit" glow disappearing after ~1 second even while
  still holding the key down.
- Fixed the "HOLD X TO TRANSMIT" hint not updating when you rebind your
  PTT key — it used to keep showing the old key forever.

## v1.4.1
- Rebuilt radio/comms (channel join/leave, PTT, ear routing, mic device +
  test) into its own module for stability.

## v1.4.0
- Medical supplies are now persistent per Operation: using a bandage or
  tourniquet actually uses it up. Reviving someone no longer refills their
  supplies — only starting a new Operation resets everyone's loadout.
- Death screen now shows the real cause (headshot / bled out / cardiac
  arrest) instead of always saying "bled out."
- Comms tab marked as a work-in-progress (caution-tape banner) while voice
  quality gets fully verified end-to-end.
- Popping out the medical panel now opens a real standalone window instead
  of an always-on-top overlay glued to the main app.
- Reordered the top navigation tabs so they read in a sensible order.

## v1.3.9
- Stim overdose is now a gradual mechanic: heart rate climbs to cardiac
  arrest over about 30 seconds instead of an instant chance roll. Stacking
  more doses speeds up the climb; a depressant still clears it instantly if
  used in time.

## v1.3.8
- SPLINT is now always shown as a treatment option, greyed out when there's
  no fracture to fix, instead of disappearing entirely.

## v1.3.6
- Found and fixed the real root cause of bandages/tourniquets not sticking:
  a Firestore write bug (`setDoc` + `merge` doesn't treat a dotted field
  name as a nested path) was silently dropping every treatment write.
  Switched every affected write to `updateDoc`, which fixes it correctly.
  (v1.3.0–v1.3.7 covers the investigation and a rewrite that was briefly
  reverted after exposing this same pre-existing bug — 1.3.6 is the actual
  fix.)

## v1.2.x series
- Tiered tourniquet impairment with audio callouts, rebalanced head-hit
  lethality, averaged multi-wound bleed rate, guarded against
  double-applying a tourniquet, and stopped treatment buttons from
  silently eating clicks when blocked. General medical-system hardening
  across this series.

## v1.1.0
- Overhauled the medical system, fixed a voice permissions bug, and
  reworked the patient-card UX.

## v1.0.1
- Trauma card overhaul, medical desync/soft-lock fixes, auto-update
  support, and ORBAT role assignment.
