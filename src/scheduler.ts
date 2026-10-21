/**
 * scheduler.ts — time-window and skip-rule logic.
 *
 * Pure functions only. No Firestore, no FCM, no logging of any user data.
 *
 * Contract reference: docs/12-push-sender-contract.md §3 and §6-scheduling.
 */

import { DateTime } from 'luxon';
import type { Slot, UserSettings, ReminderState } from './types';

export const ZONE = 'Asia/Kolkata';

// ── time helpers ────────────────────────────────────────────────────────────

/** Return current IST date as YYYY-MM-DD. Accepts an override for tests. */
export function getDayKeyIST(now?: DateTime): string {
  const dt = now ?? DateTime.now().setZone(ZONE);
  return dt.toFormat('yyyy-MM-dd');
}

/** Return current HH:MM in IST. Accepts an override for tests. */
export function getCurrentHHMM(now?: DateTime): string {
  const dt = now ?? DateTime.now().setZone(ZONE);
  return `${String(dt.hour).padStart(2, '0')}:${String(dt.minute).padStart(2, '0')}`;
}

/**
 * Get JS weekday number (0=Sunday … 6=Saturday) for IST.
 * Luxon uses 1=Monday … 7=Sunday, so: weekday % 7 maps 7→0, 1→1, etc.
 */
export function getJsWeekday(now?: DateTime): number {
  const dt = now ?? DateTime.now().setZone(ZONE);
  return dt.weekday % 7;   // 1→1, 2→2, …, 6→6, 7→0 (Sunday)
}

// ── window check ─────────────────────────────────────────────────────────────

/**
 * Is `current` (HH:MM) within the 15-minute slot window?
 *
 * Contract: windowStart = slotTime, windowEnd = slotTime + 14 min (inclusive).
 * String comparison is safe because both sides are zero-padded HH:MM.
 */
export function isInWindow(slotTime: string, current: string): boolean {
  const [slotH, slotM] = slotTime.split(':').map(Number);
  const [curH, curM]   = current.split(':').map(Number);

  const slotMinutes = slotH * 60 + slotM;
  const curMinutes  = curH  * 60 + curM;

  return curMinutes >= slotMinutes && curMinutes <= slotMinutes + 14;
}

/** Is `current` (HH:MM) within the quiet-hours range (start inclusive, end exclusive)? */
export function isInQuietHours(
  start: string | null,
  end: string | null,
  current: string
): boolean {
  if (!start || !end) return false;

  const toMin = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };

  const s = toMin(start);
  const e = toMin(end);
  const c = toMin(current);

  // Handle overnight quiet hours (e.g. 22:00 – 06:00)
  if (s <= e) return c >= s && c < e;
  return c >= s || c < e;
}

// ── which slots should fire right now ────────────────────────────────────────

export interface SlotCheck {
  slot: Slot;
  due: boolean;
  reason?: string;  // why skipped — generic, no user data
}

/**
 * Determine which slots should fire for a user right now.
 *
 * Returns an array of {slot, due} entries. Caller checks dedupe via
 * reminderState separately so we can test each concern in isolation.
 */
export function computeDueSlots(
  settings: UserSettings,
  reminderState: ReminderState,
  completedToday: number,
  nowDT: DateTime,
  forceTest = false
): SlotCheck[] {
  const current  = getCurrentHHMM(nowDT);
  const dayKey   = getDayKeyIST(nowDT);
  const jsWd     = getJsWeekday(nowDT);
  const nowMs    = nowDT.toMillis();

  const results: SlotCheck[] = [];

  const slots: Array<{ slot: Slot; time: string }> = [
    { slot: 'morning', time: settings.morningTime },
    { slot: 'study',   time: settings.studyTime   },
  ];

  for (const { slot, time } of slots) {
    // ── force_test skips all scheduling checks ──────────────────────────────
    if (forceTest) {
      results.push({ slot, due: true });
      continue;
    }

    // ── 1. notificationsEnabled ─────────────────────────────────────────────
    if (!settings.notificationsEnabled) {
      results.push({ slot, due: false, reason: 'notifications-disabled' });
      continue;
    }

    // ── 2. day of week ──────────────────────────────────────────────────────
    if (!settings.daysOfWeek.includes(jsWd)) {
      results.push({ slot, due: false, reason: 'day-excluded' });
      continue;
    }

    // ── 3. quiet hours ──────────────────────────────────────────────────────
    if (isInQuietHours(settings.quietHoursStart, settings.quietHoursEnd, current)) {
      results.push({ slot, due: false, reason: 'quiet-hours' });
      continue;
    }

    // ── 4. goal already met ─────────────────────────────────────────────────
    if (completedToday >= settings.dailyTarget) {
      results.push({ slot, due: false, reason: 'goal-met' });
      continue;
    }

    // ── 5. dismissedToday ───────────────────────────────────────────────────
    if (reminderState.dismissedToday === dayKey) {
      results.push({ slot, due: false, reason: 'dismissed-today' });
      continue;
    }

    // ── 6. snoozed ──────────────────────────────────────────────────────────
    if (reminderState.snoozeUntil !== null && nowMs < reminderState.snoozeUntil) {
      results.push({ slot, due: false, reason: 'snoozed' });
      continue;
    }

    // ── 7. already fired today (dedupe) ─────────────────────────────────────
    const firedToday = reminderState.lastFiredSlot[dayKey] ?? [];
    if (firedToday.includes(slot)) {
      results.push({ slot, due: false, reason: 'already-fired' });
      continue;
    }

    // ── 8. time window ──────────────────────────────────────────────────────
    if (!isInWindow(time, current)) {
      results.push({ slot, due: false, reason: 'outside-window' });
      continue;
    }

    results.push({ slot, due: true });
  }

  return results;
}
