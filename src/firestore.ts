/**
 * firestore.ts — thin, typed wrappers around Firestore Admin.
 *
 * Never logs any field values, document IDs, or user data.
 * All logging of counts/status is done in sender.ts.
 */

import type * as admin from 'firebase-admin';
import type {
  UserSettings,
  ReminderState,
  DeviceDoc,
  DayDoc,
  UserProfile,
} from './types';

type Firestore = admin.firestore.Firestore;
type FieldValue = typeof admin.firestore.FieldValue;

// ── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS: UserSettings = {
  morningTime: '08:30',
  studyTime: '19:00',
  daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
  quietHoursStart: null,
  quietHoursEnd: null,
  snoozeMinutes: 15,
  maxSnoozeCount: 3,
  notificationsEnabled: false,
  coachTheme: 'classic',
  dailyTarget: 3,
};

export const DEFAULT_REMINDER_STATE: ReminderState = {
  lastFiredSlot: {},
  snoozeUntil: null,
  dismissedToday: null,
};

// ── Reads ─────────────────────────────────────────────────────────────────────

/** List all user UIDs from the top-level `users` collection. */
export async function listUserIds(db: Firestore): Promise<string[]> {
  const snap = await db.collection('users').listDocuments();
  return snap.map((ref) => ref.id);
}

/** Read settings for a user. Returns defaults for missing fields. */
export async function readSettings(db: Firestore, uid: string): Promise<UserSettings> {
  const snap = await db.doc(`users/${uid}/meta/settings`).get();
  if (!snap.exists) return { ...DEFAULT_SETTINGS };
  const data = snap.data() ?? {};
  return {
    morningTime:          data['morningTime']          ?? DEFAULT_SETTINGS.morningTime,
    studyTime:            data['studyTime']            ?? DEFAULT_SETTINGS.studyTime,
    daysOfWeek:           data['daysOfWeek']           ?? DEFAULT_SETTINGS.daysOfWeek,
    quietHoursStart:      data['quietHoursStart']      ?? DEFAULT_SETTINGS.quietHoursStart,
    quietHoursEnd:        data['quietHoursEnd']        ?? DEFAULT_SETTINGS.quietHoursEnd,
    snoozeMinutes:        data['snoozeMinutes']        ?? DEFAULT_SETTINGS.snoozeMinutes,
    maxSnoozeCount:       data['maxSnoozeCount']       ?? DEFAULT_SETTINGS.maxSnoozeCount,
    notificationsEnabled: data['notificationsEnabled'] ?? DEFAULT_SETTINGS.notificationsEnabled,
    coachTheme:           data['coachTheme']           ?? DEFAULT_SETTINGS.coachTheme,
    dailyTarget:          data['dailyTarget']          ?? DEFAULT_SETTINGS.dailyTarget,
  };
}

/** Read reminderState for a user. Returns defaults if doc is missing. */
export async function readReminderState(db: Firestore, uid: string): Promise<ReminderState> {
  const snap = await db.doc(`users/${uid}/meta/reminderState`).get();
  if (!snap.exists) return { ...DEFAULT_REMINDER_STATE };
  const data = snap.data() ?? {};
  return {
    lastFiredSlot: data['lastFiredSlot'] ?? {},
    snoozeUntil:   data['snoozeUntil']   ?? null,
    dismissedToday: data['dismissedToday'] ?? null,
  };
}

/** Read completed count for a day. Returns 0 if doc is missing. */
export async function readDayCompleted(
  db: Firestore,
  uid: string,
  dayKey: string
): Promise<number> {
  const snap = await db.doc(`users/${uid}/days/${dayKey}`).get();
  if (!snap.exists) return 0;
  const data: DayDoc = (snap.data() as DayDoc) ?? { completed: 0 };
  return data.completed ?? 0;
}

/** Read yesterday's completed count (for nudge_missed detection). */
export async function readYesterdayCompleted(
  db: Firestore,
  uid: string,
  yesterdayKey: string
): Promise<number> {
  return readDayCompleted(db, uid, yesterdayKey);
}

/**
 * List active device docs for a user.
 * Skips devices whose lastSeenAt is older than 30 days.
 */
export async function listDevices(db: Firestore, uid: string): Promise<DeviceDoc[]> {
  const snap = await db.collection(`users/${uid}/devices`).get();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

  return snap.docs
    .map((d) => {
      const data = d.data();
      return {
        id: d.id,
        token: data['token'] as string,
        platform: data['platform'] as string,
        tz: data['tz'] as string,
        lastSeenAt: data['lastSeenAt'] ?? null,
      } as DeviceDoc;
    })
    .filter((dev) => {
      if (!dev.token) return false;
      if (!dev.lastSeenAt) return true; // keep if timestamp missing
      const ms = (dev.lastSeenAt as admin.firestore.Timestamp).toMillis();
      return ms >= cutoff;
    });
}

/** Read user profile for first name. */
export async function readProfile(db: Firestore, uid: string): Promise<UserProfile> {
  const snap = await db.doc(`users/${uid}/profile`).get();
  if (!snap.exists) return {};
  return (snap.data() ?? {}) as UserProfile;
}

// ── Writes ────────────────────────────────────────────────────────────────────

/**
 * After a successful send, mark the slot as fired for today.
 * Uses merge + FieldValue.arrayUnion so concurrent writes are safe.
 */
export async function markSlotFired(
  db: Firestore,
  FieldValue: FieldValue,
  uid: string,
  dayKey: string,
  slot: string
): Promise<void> {
  await db.doc(`users/${uid}/meta/reminderState`).set(
    {
      lastFiredSlot: {
        [dayKey]: FieldValue.arrayUnion(slot),
      },
    },
    { merge: true }
  );
}

/** Delete a device document when FCM says the token is invalid. */
export async function deleteDevice(
  db: Firestore,
  uid: string,
  deviceId: string
): Promise<void> {
  await db.doc(`users/${uid}/devices/${deviceId}`).delete();
}
