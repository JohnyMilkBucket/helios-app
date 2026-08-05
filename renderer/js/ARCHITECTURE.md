# Helios renderer architecture

## Why this file exists

Most of this session went into hunting a bug where treatment state
(bandaging, tourniquets) mutated correctly locally but silently reverted
between actions. The root cause: two different pieces of code were both
writing to the same shared state (`S.self.zones`) with no coordination — a
local mutation from a treatment, and a Firestore listener that also
overwrote the same field on every snapshot. Whichever one ran last won, with
zero error. The same exact bug pattern was then found independently in
ORBAT's sub-unit assignment.

This isn't a one-off — it's what happens by default in a single 5000+ line
file where every feature reads and writes one big shared `S` object. This
doc is the convention that's meant to stop that from happening again.

## The rule: single writer per piece of state

If a value is persisted to Firestore, exactly **one** thing is allowed to
change the local copy of it: the `onSnapshot` listener for that document.
Everything else — button clicks, background timers, whatever — is only
allowed to **write to Firestore**. It never reaches into local state and
sets a field directly.

```
Action (click, tick) ──write only──▶ Firestore ──onSnapshot──▶ local state ──▶ render
```

Not this:

```
Action ──mutates local state directly──▶ render
   └──also writes to Firestore──▶ onSnapshot ──mutates local state again──▶ render
```

The second shape is a race by construction — two writers, no ordering
guarantee, and a stale echo from the second write path can clobber a fresh
change from the first with no error to show for it. That's exactly what
happened.

## Per-module pattern (see `medical.js` for the fullest example)

Each stateful feature area gets its own file under `renderer/js/`:

- **Constants** it owns (`medical.js` → `INJ`, `ZONES`, ...; `roles.js` →
  `DEFAULT_LD`).
- **Pure transition functions** — take a value, return a new value, never
  mutate their argument, no I/O. These are what make the logic actually
  testable (see the stub-Firestore harnesses used to verify each rewrite
  this session — write→snapshot-echo simulators, not "never fires" stubs).
- **Module-local state** (a plain object, not exported directly) updated
  *only* inside the module's own `onSnapshot` callback(s).
- **Action exports** — `applyTreatment()`, `assignMember()`, etc. — that
  compute the next value with the pure functions and write it. They never
  touch the module's local state directly.
- **`getX()` exports** for reading current state, and (where other code
  needs to react to changes) an `onXChange(fn)` subscription — see
  `medical.js`'s `onMedicalChange`.

`index.html` keeps a *mirror* (`S.self`, `S.patients`, `S.cardRoles`, ...)
that gets **replaced wholesale** by the module's subscription callback, and
is never independently written to by anything else in `index.html`. That's
what keeps every existing render function (`updateBodyFigure`,
`renderPatients`, `renderRoles`, ...) working unchanged — they just read a
mirror that's now guaranteed to only ever reflect one source of truth.

## When a Firestore field is an array vs. a map

`ORBAT`'s `subUnits` used to be an array on the parent unit doc, so
assigning one member to one sub-unit required a read-modify-write of the
*entire* array — two edits to two different sub-units at the same time would
race the same way `S.self.zones` did. Fixed by making it a map keyed by
sub-unit id, so each edit is a dot-path write (`subUnits.<id>.members`) that
can never touch a sibling sub-unit.

**Rule of thumb:** if a Firestore field is a collection of independently-
editable things, store it as a map keyed by id, not an array — arrays force
whole-field writes, maps allow dot-path writes. `medical.js`'s `zones` field
already followed this (keyed by body zone) before this session; `subUnits`
now does too.

## What does *not* need this treatment

Not every piece of state is a race risk. `renderer/js/voice.js` and the
comms/PTT code in `index.html` were audited for this same bug class and
found clean: live radio/PTT state (`S.radioSlots`, `S.activeChanIds`) is
**never written to Firestore** — it's pure client-local UI/WebRTC state, so
there's no listener to race against. Forcing it into the same
single-writer-module shape as medical/roles/ORBAT would add an artificial
boundary without removing any actual risk, since the risk this pattern
guards against doesn't exist there. Only reach for this pattern when a
feature has local state that's *also* being kept in sync with a Firestore
listener — that's the specific shape that broke.

## Checklist for adding a new feature area

1. Does it persist to Firestore *and* keep a local copy for rendering? If
   yes, it needs this pattern. If it's pure local UI state, it doesn't.
2. Put constants + pure transition functions + the listener + action
   exports in `renderer/js/<feature>.js`.
3. `index.html` subscribes once, mirrors the module's state into its own
   `S.<feature>` on every change, and never assigns to that field from
   anywhere else.
4. Test with a Firestore stub that actually simulates the write→snapshot
   round trip (see any of this session's rewrites for the pattern) — a stub
   where `onSnapshot` never fires can't catch this bug class at all, and
   that's exactly how it shipped several times before being caught.
