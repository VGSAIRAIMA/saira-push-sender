# SAIRA: Push Sender Contract

**Audience:** the `saira-push-sender` repo. It must NOT import any files from this repo.
This document contains everything the sender needs. Do not guess field names.

---

## 1. Firebase project

- **Project ID:** `saira-dsa`
- **Region:** `asia-south1`
- **Authentication:** Service account key JSON (Admin SDK). Never commit it.
- The sender uses `firebase-admin`; Firestore security rules do **not** apply to Admin SDK reads/writes.

---

## 2. Firestore paths the sender reads

### 2a. User settings
```
users/{uid}/meta/settings
```

> **Note on Timezone:** All times in `users/{uid}/meta/settings` (`morningTime`, `studyTime`, `quietHoursStart`, `quietHoursEnd`) are in **IST (`Asia/Kolkata`, UTC+05:30)**.

Fields:
| Field | Type | Default | Meaning |
|---|---|---|---|
| `morningTime` | `string` | `"08:30"` | HH:MM (24-h) in IST |
| `studyTime` | `string` | `"19:00"` | HH:MM (24-h) in IST |
| `daysOfWeek` | `number[]` | `[0,1,2,3,4,5,6]` | JS weekday numbers (0=Sunday, 6=Saturday) |
| `quietHoursStart` | `string \| null` | `null` | HH:MM in IST, null = no quiet hours |
| `quietHoursEnd` | `string \| null` | `null` | HH:MM in IST |
| `snoozeMinutes` | `number` | `15` | minutes per snooze |
| `maxSnoozeCount` | `number` | `3` | max snoozes per slot per day |
| `notificationsEnabled` | `boolean` | `false` | must be `true` to send |
| `dailyTarget` | `number` | `3` | Target items to complete per day (used by §2c) |
| `coachTheme` | `"classic" \| "hero" \| "realm" \| "mahabharata" \| "mix"` | `"classic"` | which theme to pick lines from |
| `firstName` | `string` | `"friend"` | **Learner's first name for `{name}` substitution** (see §2d) |

### 2b. Reminder state (last fired)
```
users/{uid}/meta/reminderState
```
Fields:
| Field | Type | Meaning |
|---|---|---|
| `lastFiredSlot` | `string \| { [dayKey: string]: string[] }` | e.g. `"morning"` / `"study"`, or map `{ "2026-10-21": ["morning"] }` |
| `lastFiredDate` | `string \| undefined` | `YYYY-MM-DD` in IST of the last fired slot |
| `snoozeUntil` | `number \| null` | Unix ms timestamp; if `Date.now() < snoozeUntil` skip the slot |
| `dismissedSlots` | `string[] \| undefined` | Array of `"${dayKey}:${slot}"` dismissed by user (e.g. `["2026-10-21:morning"]`) |
| `dismissedToday` | `string \| null` | Optional dayKey string of the last "not today" dismissal; if matches today skip all slots |
| `missedNudgeFiredForDate` | `string \| undefined` | `YYYY-MM-DD` dayKey when `nudge_missed` was fired (prevents firing it more than once per day) |

The sender reads this doc to ensure it does not fire a slot that has already fired today.

### 2c. Today's progress (daily target check)
```
users/{uid}/days/{dayKey}
```
`dayKey` format: `YYYY-MM-DD` in `Asia/Kolkata` (IST).

Fields:
| Field | Type | Meaning |
|---|---|---|
| `completed` | `number` | items completed today (0 if doc does not exist) |

`dailyTarget` is read from `users/{uid}/meta/settings` (§2a, default `3`).
If `completed >= dailyTarget`, skip the slot — goal already met today.

### 2d. Learner's first name (for `{name}` placeholder in coach lines)

**Exact path:**
```
users/{uid}/meta/settings
```
**Exact field:** `firstName` (`string`)

**How it is written by the app:**
On every sign-in and on every page reload (inside Firebase Auth's `onAuthStateChanged`), the app calls `syncFirstName(user)` in `src/lib/reminderStorage.ts`. This function:
1. Takes `user.displayName` from Firebase Auth (e.g. `"Priya Sharma"`).
2. Splits on space and takes the first word (`"Priya"`).
3. Trims whitespace; falls back to `"friend"` when displayName is null, undefined, or empty.
4. Writes `{ firstName: "Priya" }` with `merge: true` to `users/{uid}/meta/settings`.

**How the sender uses it:**
```js
// Inside the sender, after reading the settings doc:
const firstName = settings.firstName || 'friend';
line = line.replace(/\{name\}/g, firstName);
```

**Fallback:** if the `firstName` field is missing or empty, fall back to `"friend"`.

**The sender does NOT need to call the Firebase Auth Admin SDK** (`admin.auth().getUser(uid)`). `firstName` is read directly from the settings doc that the sender already fetches — zero extra reads.

---

## 3. Computing dayKey and slot evaluation in Asia/Kolkata (IST)

```js
const { DateTime } = require('luxon'); // or Intl.DateTimeFormat

function getDayKeyIST() {
  return DateTime.now().setZone('Asia/Kolkata').toFormat('yyyy-MM-dd');
}

function getCurrentMinutesIST() {
  const now = DateTime.now().setZone('Asia/Kolkata');
  return now.hour * 60 + now.minute;
}

function parseTimeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
```

### 30-Minute Slot Window Rule
The sender fires a slot if:
```
slotTime <= now < slotTime + 30 minutes (IST)
```
and `lastFiredSlot` does not already contain that slot for today.

Example:
- `morningTime = "08:30"` (510 minutes)
- Slot window: `[08:30, 09:00)` IST (minutes `510 <= now < 540`)

### Additional Guard Rules:
1. **Quiet hours:** if `quietHoursStart` and `quietHoursEnd` are configured, and current IST time falls within quiet hours, skip all slots.
2. **Days of week:** `DateTime.now().setZone('Asia/Kolkata').weekday % 7` → JS weekday (0=Sunday, 6=Saturday). Skip if not in `settings.daysOfWeek`.
3. **Dismissed today:** skip if `reminderState.dismissedSlots` contains `"${dayKey}:${slot}"` or `reminderState.dismissedToday === dayKey`.
4. **Snooze:** skip if `reminderState.snoozeUntil != null` and `Date.now() < reminderState.snoozeUntil`.
5. **Daily target:** skip if `completedToday >= settings.dailyTarget`.

---

## 4. Device documents the sender reads

```
users/{uid}/devices/{deviceId}
```
Fields:
| Field | Type | Meaning |
|---|---|---|
| `token` | `string` | FCM registration token — use as the send target |
| `platform` | `string` | `"desktop"` / `"android-chrome"` / `"ios-safari"` |
| `tz` | `string` | Client timezone (informational; scheduling always uses IST) |
| `lastSeenAt` | `Timestamp` | Firestore server timestamp; skip devices with `lastSeenAt < now - 30d` |

The sender lists all docs in `users/{uid}/devices` and sends to each valid token.

### Invalid token cleanup
When iterating through `response.responses[i]`:
If `!res.success`, delete the device doc if the error is due to an invalid/expired token:
- `error.code === 'messaging/registration-token-not-registered'`
- `error.code === 'messaging/invalid-registration-token'`
- `error.code === 'messaging/invalid-argument'` (or malformed token error)

Delete command:
```js
await admin.firestore().doc(`users/${uid}/devices/${deviceId}`).delete();
```

---

## 5. Coach line selection

The sender picks a line from the avatar-lines seed file. Copy the exact JSON from:
```
src/data/avatar-lines.seed.json
```
(in this repo — copy it into the sender repo).

**Schema (schemaVersion: 2):**
```json
{
  "schemaVersion": 2,
  "themes": {
    "classic": {
      "morning":       ["...", "..."],
      "study":         ["...", "..."],
      "nudge_missed":  ["...", "..."],
      "snooze_ack":    ["...", "..."],
      "start_ack":     ["...", "..."],
      "done_today":    ["...", "..."],
      "weekly_review": ["...", "..."]
    },
    "hero": { /* same groups */ },
    "realm": { /* same groups */ },
    "mahabharata": { /* same groups */ }
  }
}
```

### How to pick a theme:
- `classic`, `hero`, `realm`, `mahabharata` → use directly from `settings.coachTheme`.
- `mix` → deterministic daily rotation:
  ```js
  const themes = ['classic', 'hero', 'realm', 'mahabharata'];
  const dayKey = getDayKeyIST(); // e.g. "2026-10-21"
  let hash = 0;
  for (const ch of dayKey) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const theme = themes[hash % themes.length];
  ```

### How to decide `nudge_missed`:
The app decides `nudge_missed` strictly as follows (matching `src/lib/schedule.ts`):
1. **Slot must be `"study"`** (never `"morning"`).
2. Calculate yesterday's dayKey in IST: `yesterdayKey = DateTime.fromISO(dayKey).minus({ days: 1 }).toFormat('yyyy-MM-dd')`.
3. Check `users/{uid}/days/{yesterdayKey}`.
4. If yesterday's log is missing OR `yesterdayLog.completed === 0` (and `yesterdayLog.restDay !== true`), yesterday was missed.
5. Check that `nudge_missed` has not already fired today: `reminderState.missedNudgeFiredForDate !== todayKey`.
6. If all match: use line group `"nudge_missed"`.
7. Otherwise: use line group `"study"`.

### How to pick the line & substitute `{name}`:
1. Look up `themes[theme][group]` where `group` is `"morning"`, `"study"`, or `"nudge_missed"`.
2. Pick a line from the array (random or non-repeating).
3. The first name comes **ONLY** from `users/{uid}/meta/settings` field `firstName` (§2d):
   ```js
   const firstName = settings.firstName || 'friend';
   line = line.replace(/\{name\}/g, firstName);
   ```

---

## 6. FCM data-only payload the sender must send

Use `sendEachForMulticast` (firebase-admin v12+) with a **data-only** message. Do NOT include a `notification` block — the service worker builds the notification itself.

```js
const message = {
  tokens: [token1, token2, ...],   // from devices collection
  data: {
    slot:     'morning',            // or 'study'
    line:     'Good morning, friend! Your sheet is ready.',
    url:      '/today?coach=morning',
    dayKey:   '2026-10-21',         // IST day key YYYY-MM-DD
    imageUrl: '/icons/icon-192.png' // optional; coach art URL
  },
  // webpush config for immediate delivery
  webpush: {
    headers: {
      TTL: '3600',                  // 1-hour time-to-live
      Urgency: 'high'               // High priority delivery
    }
  }
};
const response = await admin.messaging().sendEachForMulticast(message);
```

---

## 7. After sending — update reminderState

**Important:** Write `lastFiredSlot` **ONLY after at least one token accepted the message** (`response.successCount > 0`). If every send fails, do NOT write to `reminderState`, so the next cron run will retry within the 30-minute window.

```js
if (response.successCount > 0) {
  const isMissedNudge = (group === 'nudge_missed');
  
  await admin.firestore().doc(`users/${uid}/meta/reminderState`).set(
    {
      lastFiredSlot: slot,
      lastFiredDate: dayKey,
      lastFiredSlots: admin.firestore.FieldValue.arrayUnion(`${dayKey}:${slot}`),
      ...(isMissedNudge ? { missedNudgeFiredForDate: dayKey } : {})
    },
    { merge: true }
  );
}
```

---

## 8. Scheduling cadence

Run the sender via **GitHub Actions cron only** (e.g. `*/15 * * * *` or `*/10 * * * *` UTC).

Reference times in UTC for the default IST schedule:
- 08:30 IST = 03:00 UTC
- 19:00 IST = 13:30 UTC

GitHub Actions cron can occasionally be delayed by several minutes. Because the sender evaluates a **30-minute window** (`slotTime <= now < slotTime + 30m`), any cron run within 30 minutes of the slot time will reliably trigger the reminder.

---

## 9. What the client does when it receives the push

The service worker (`src/sw.ts`) handles the background message via `onBackgroundMessage`:
- Reads `data.slot`, `data.line`, `data.dayKey`, `data.imageUrl` from the FCM payload.
- If a focused browser window is open: posts `{ type: 'SAIRA_COACH_SHOW', slot, line }` to the page — **no system notification**.
- If no focused window: calls `showNotification('SAIRA Coach', { ... })` with tag `saira-{slot}-{dayKey}`, `renotify: false`, actions Start and Snooze.
- Clicking "Start" opens `/today?coach={slot}`; clicking "Snooze" opens `/today?snooze={slot}`.
