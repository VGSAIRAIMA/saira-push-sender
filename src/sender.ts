/**
 * sender.ts — main entry point for the SAIRA push reminder sender.
 *
 * Reads config from environment variables only:
 *   FIREBASE_SERVICE_ACCOUNT  — JSON string of the service account key
 *   FIREBASE_PROJECT_ID       — Firebase project ID string
 *   DRY_RUN                   — "true" to skip actual sends (default false)
 *   FORCE_TEST                — "true" to send one test push to TEST_UID user
 *   TEST_UID                  — the uid to target in force_test mode
 *                               (injected as env from Actions secret, never typed)
 *
 * SECURITY RULES (never break these):
 *  - Never print FIREBASE_SERVICE_ACCOUNT or FIREBASE_PROJECT_ID.
 *  - Never print a token, uid, email, name, or line text.
 *  - Only log counts and generic status messages.
 */

import * as admin from 'firebase-admin';
import { DateTime } from 'luxon';

import {
  listUserIds,
  readSettings,
  readReminderState,
  readDayCompleted,
  readYesterdayCompleted,
  readProfile,
  listDevices,
  markSlotFired,
} from './firestore';

import { computeDueSlots, getDayKeyIST, ZONE } from './scheduler';
import { selectLine } from './coach';
import { sendToDevices } from './tokens';
import type { RunStats } from './types';

// ── Initialise Firebase Admin ─────────────────────────────────────────────────

function initFirebase(): void {
  const saJson = process.env['FIREBASE_SERVICE_ACCOUNT'];
  const projectId = process.env['FIREBASE_PROJECT_ID'];

  if (!saJson)   throw new Error('FIREBASE_SERVICE_ACCOUNT env var is required');
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID env var is required');

  // Parse once, discard immediately. Never store or log.
  let credential: admin.credential.Credential;
  try {
    const parsed: admin.ServiceAccount = JSON.parse(saJson);
    credential = admin.credential.cert(parsed);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON');
  }

  admin.initializeApp({ credential, projectId });
}

// ── Yesterday key helper ──────────────────────────────────────────────────────

function getYesterdayKey(nowDT: DateTime): string {
  return nowDT.minus({ days: 1 }).toFormat('yyyy-MM-dd');
}

// ── Process one user ──────────────────────────────────────────────────────────

async function processUser(
  db: admin.firestore.Firestore,
  messaging: admin.messaging.Messaging,
  uid: string,
  nowDT: DateTime,
  dryRun: boolean,
  forceTest: boolean,
  stats: RunStats
): Promise<void> {
  // Read all user data in parallel to reduce latency
  const dayKey       = getDayKeyIST(nowDT);
  const yesterdayKey = getYesterdayKey(nowDT);

  const [settings, reminderState, completedToday, yesterdayCompleted, devices, profile] =
    await Promise.all([
      readSettings(db, uid),
      readReminderState(db, uid),
      readDayCompleted(db, uid, dayKey),
      readYesterdayCompleted(db, uid, yesterdayKey),
      listDevices(db, uid),
      readProfile(db, uid),
    ]);

  if (devices.length === 0) {
    stats.skipped++;
    return;
  }

  // Compute which slots should fire
  const slotChecks = computeDueSlots(
    settings,
    reminderState,
    completedToday,
    nowDT,
    forceTest
  );

  const dueSlots = slotChecks.filter((s) => s.due);

  if (dueSlots.length === 0) {
    stats.skipped++;
    return;
  }

  const missedYesterday = yesterdayCompleted === 0;
  const firstName = (profile.displayName ?? 'friend').split(' ')[0];
  // firstName is NEVER logged — used only in the FCM payload

  for (const { slot } of dueSlots) {
    const line = selectLine(settings, slot, dayKey, missedYesterday, firstName);
    // line is NEVER logged

    const result = await sendToDevices(
      messaging,
      db,
      uid,
      devices,
      slot,
      line,
      dayKey,
      dryRun
    );

    stats.sent          += result.successCount;
    stats.tokensRemoved += result.tokensRemoved;

    if (!dryRun && result.successCount > 0) {
      // Mark this slot as fired so we never double-send
      await markSlotFired(
        db,
        admin.firestore.FieldValue,
        uid,
        dayKey,
        slot
      );
    }
  }
}

// ── Force-test mode ───────────────────────────────────────────────────────────

async function runForceTest(
  db: admin.firestore.Firestore,
  messaging: admin.messaging.Messaging,
  dryRun: boolean,
  stats: RunStats
): Promise<void> {
  const testUid = process.env['TEST_UID'];
  if (!testUid) {
    console.log('[sender] force_test: TEST_UID secret not set — nothing to do');
    return;
  }
  // Never print testUid — it is a user identifier
  console.log('[sender] force_test: sending test notification to 1 user');

  const nowDT = DateTime.now().setZone(ZONE);
  stats.usersChecked = 1;
  await processUser(db, messaging, testUid, nowDT, dryRun, true, stats);
}

// ── Normal run ────────────────────────────────────────────────────────────────

async function runNormal(
  db: admin.firestore.Firestore,
  messaging: admin.messaging.Messaging,
  dryRun: boolean,
  stats: RunStats
): Promise<void> {
  const nowDT = DateTime.now().setZone(ZONE);
  const uids  = await listUserIds(db);
  stats.usersChecked = uids.length;

  // Process users sequentially to avoid overwhelming Firestore quota.
  // For large user bases, batch in parallel groups of ~20.
  for (const uid of uids) {
    try {
      await processUser(db, messaging, uid, nowDT, dryRun, false, stats);
    } catch {
      stats.errors++;
      // Never log the uid or any field from the error that might contain user data
      console.log('[sender] error processing 1 user (details suppressed for privacy)');
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dryRun    = process.env['DRY_RUN']    === 'true';
  const forceTest = process.env['FORCE_TEST'] === 'true';

  console.log(`[sender] starting | dry_run=${dryRun} force_test=${forceTest}`);

  initFirebase();

  const db        = admin.firestore();
  const messaging = admin.messaging();

  const stats: RunStats = {
    usersChecked: 0,
    sent:         0,
    skipped:      0,
    tokensRemoved: 0,
    errors:       0,
  };

  if (forceTest) {
    await runForceTest(db, messaging, dryRun, stats);
  } else {
    await runNormal(db, messaging, dryRun, stats);
  }

  // SAFE log line: only counts, no user data
  console.log(
    `[sender] done | users_checked=${stats.usersChecked}` +
    ` sent=${stats.sent}` +
    ` skipped=${stats.skipped}` +
    ` tokens_removed=${stats.tokensRemoved}` +
    ` errors=${stats.errors}`
  );
}

main().catch((err: unknown) => {
  // Log only the message, not a stack that might contain env vars
  const msg = err instanceof Error ? err.message : 'unknown error';
  console.error('[sender] fatal:', msg);
  process.exit(1);
});
