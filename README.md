# saira-push-sender

Background service that sends push-notification reminders for the **SAIRA DSA Study Tracker** PWA.

---

## What this does

SAIRA lets learners set two daily reminder times — a morning slot (default 08:30 IST) and an evening study slot (default 19:00 IST). This script runs every 15 minutes on GitHub Actions, checks which users have a reminder due right now, and sends them a data-only FCM push message. The user's service worker receives the push and shows the system notification.

### Key behaviours

| What | How |
|---|---|
| Schedule | Cron every 15 min UTC on GitHub Actions |
| Who gets notified | Users with `notificationsEnabled=true` whose slot time falls in the current 15-minute window |
| Time zone | All times are in `Asia/Kolkata` (IST) |
| Dedupe | `reminderState.lastFiredSlot` prevents double-sends across runs |
| Invalid tokens | Automatically deleted from Firestore when FCM rejects them |
| Message type | Data-only (no `notification` block) — the service worker builds the notification |
| Coach theme | Chosen per-user; `mix` rotates through all four themes daily |

### What it does NOT do

- It does not store any secret in the repo.
- It does not log user IDs, tokens, emails, names, or message text — only counts. This matters because GitHub Actions logs on a public repo are public.

---

## Three secrets you must add

Go to your fork → **Settings → Secrets and variables → Actions → New repository secret**.

### 1. `FIREBASE_SERVICE_ACCOUNT`

The Firebase Admin SDK service account key for the `saira-dsa` project.

**What is a service account?**  
A service account is a machine identity (a JSON file with a private key) that lets a server script prove to Google that it is authorised to read/write this Firebase project. It is not your personal Google account. Treat this JSON like a password — never commit it.

**How to get it:**
1. Firebase Console → Project Settings → Service Accounts → Generate new private key.
2. Download the JSON file.
3. Open it, copy the *entire contents* as a single-line JSON string.
4. Paste as the secret value.

> ⚠️ Never commit this file. Never paste it in a workflow YAML file. Pass it only through a secret.

### 2. `FIREBASE_PROJECT_ID`

Your Firebase project ID. For SAIRA this is `saira-dsa`. You can find it in the Firebase Console top bar.

### 3. `TEST_UID`

The Firestore UID of one real user account you use for testing. Only needed for the `force_test` mode below.

**Why a secret?** User IDs are considered personal identifiers. Putting a UID in a typed workflow input would make it visible in the Actions UI and logs. Storing it as a secret keeps it private.

---

## Running a dry run

A dry run reads Firestore and computes which notifications *would* be sent, but does not call FCM and does not update `reminderState`. It is safe to run at any time.

1. Go to **Actions → Push Reminders → Run workflow**.
2. Leave **Dry run** checked (it defaults to `true`).
3. Leave **Force test** unchecked.
4. Click **Run workflow**.

Read the log — you will see something like:

```
[sender] starting | dry_run=true force_test=false
[sender] done | users_checked=3 sent=0 skipped=3 tokens_removed=0 errors=0
```

In dry-run mode `sent` counts what *would* have been sent.

---

## Running a forced test

Force-test mode ignores the schedule, quiet hours, day-of-week settings, goal check, and the `lastFiredSlot` dedupe. It sends one real notification right now to the user whose UID is in the `TEST_UID` secret.

1. Go to **Actions → Push Reminders → Run workflow**.
2. Uncheck **Dry run**.
3. Check **Force test**.
4. Click **Run workflow**.

You should receive a push notification on any device signed in as `TEST_UID`.

---

## UTC conversion reference

GitHub Actions cron times are always UTC. The default SAIRA reminder times in UTC:

| Event | IST (user-facing) | UTC (cron) |
|---|---|---|
| Morning reminder | 08:30 IST | 03:00 UTC |
| Study reminder | 19:00 IST | 13:30 UTC |

IST = UTC + 5 hours 30 minutes. So subtract 5:30 to convert IST → UTC.

The cron `*/15 * * * *` fires at :00, :15, :30, :45 of every hour. The sender's 15-minute window means it will catch the notification at whichever of those four firings falls within 0–14 minutes of the slot time.

---

## Scheduled run limitations

- **GitHub Actions cron can be late** by up to ~15 minutes during peak load. Since the sender window is 15 minutes wide, a delayed run might just barely miss a window. Treat delivery as best-effort.
- **Scheduled workflows in public repos are paused** after approximately 60 days without any repository activity (commits, PRs, etc.). To keep the scheduler alive, either make the repo private, or push a commit at least once every 60 days (e.g. update the README).
- For more reliable delivery, consider migrating to **Google Cloud Scheduler + Cloud Functions** (requires a Firebase Blaze plan).

---

## Running tests locally

```bash
npm install
npm test
npm run typecheck
```

Tests use a fake clock and fake Firestore/FCM — no real credentials are needed.

---

## Project structure

```
src/
  sender.ts        Main entry point
  scheduler.ts     Time-window and skip-rule logic (pure functions)
  coach.ts         Theme and line selection
  firestore.ts     Typed Firestore wrappers
  tokens.ts        FCM multicast send + invalid-token cleanup
  data/
    avatar-lines.seed.json  Copied from the main SAIRA repo
tests/
  scheduler.test.ts   Time window, skip rules, dedupe
  tokens.test.ts      Token cleanup, dry run
  logs.test.ts        Log output safety checks
.github/workflows/
  push-reminders.yml  The Actions workflow
```
