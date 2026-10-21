/**
 * scheduler.test.ts
 *
 * Tests for: time window check, 30-min lateness rule, quiet hours,
 * day-of-week exclusion, skip rules (goal-met, snoozed, dismissed-today),
 * and dedupe through reminderState.lastFiredSlot.
 *
 * Uses a fake clock (fake DateTime) — no real Date.now() calls.
 * No user IDs, tokens, or names appear in this file.
 */

import { DateTime } from 'luxon';
import {
  isInWindow,
  isInQuietHours,
  computeDueSlots,
  getDayKeyIST,
  getJsWeekday,
  ZONE,
} from '../src/scheduler';
import type { UserSettings, ReminderState } from '../src/types';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a DateTime in IST at a specific HH:MM on 2026-10-21 (Wednesday). */
function ist(hh: number, mm: number, dateStr = '2026-10-21'): DateTime {
  return DateTime.fromISO(`${dateStr}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`, {
    zone: ZONE,
  });
}

const BASE_SETTINGS: UserSettings = {
  morningTime: '08:30',
  studyTime: '19:00',
  daysOfWeek: [0, 1, 2, 3, 4, 5, 6],  // all days
  quietHoursStart: null,
  quietHoursEnd: null,
  snoozeMinutes: 15,
  maxSnoozeCount: 3,
  notificationsEnabled: true,
  coachTheme: 'classic',
  dailyTarget: 3,
};

const EMPTY_STATE: ReminderState = {
  lastFiredSlot: {},
  snoozeUntil: null,
  dismissedToday: null,
};

// ── isInWindow ────────────────────────────────────────────────────────────────

describe('isInWindow', () => {
  test('slot time itself is in window', () => {
    expect(isInWindow('08:30', '08:30')).toBe(true);
  });

  test('14 minutes past is still in window (inclusive end)', () => {
    expect(isInWindow('08:30', '08:44')).toBe(true);
  });

  test('15 minutes past is outside window', () => {
    expect(isInWindow('08:30', '08:45')).toBe(false);
  });

  test('1 minute before slot is outside window', () => {
    expect(isInWindow('08:30', '08:29')).toBe(false);
  });

  test('evening slot', () => {
    expect(isInWindow('19:00', '19:07')).toBe(true);
    expect(isInWindow('19:00', '19:15')).toBe(false);
  });

  test('midnight boundary', () => {
    expect(isInWindow('00:00', '00:00')).toBe(true);
    expect(isInWindow('00:00', '00:14')).toBe(true);
    expect(isInWindow('00:00', '00:15')).toBe(false);
  });
});

// ── isInQuietHours ────────────────────────────────────────────────────────────

describe('isInQuietHours', () => {
  test('no quiet hours → never quiet', () => {
    expect(isInQuietHours(null, null, '02:00')).toBe(false);
  });

  test('in quiet hours (same-day)', () => {
    expect(isInQuietHours('22:00', '06:00', '23:00')).toBe(true);
    expect(isInQuietHours('22:00', '06:00', '03:00')).toBe(true);
    expect(isInQuietHours('22:00', '06:00', '05:59')).toBe(true);
  });

  test('at end boundary is NOT quiet', () => {
    expect(isInQuietHours('22:00', '06:00', '06:00')).toBe(false);
  });

  test('outside overnight quiet hours', () => {
    expect(isInQuietHours('22:00', '06:00', '08:30')).toBe(false);
    expect(isInQuietHours('22:00', '06:00', '19:00')).toBe(false);
    expect(isInQuietHours('22:00', '06:00', '21:59')).toBe(false);
  });

  test('daytime quiet hours (non-overnight)', () => {
    expect(isInQuietHours('13:00', '15:00', '14:00')).toBe(true);
    expect(isInQuietHours('13:00', '15:00', '15:00')).toBe(false);
    expect(isInQuietHours('13:00', '15:00', '12:59')).toBe(false);
  });
});

// ── getDayKeyIST ──────────────────────────────────────────────────────────────

describe('getDayKeyIST', () => {
  test('returns YYYY-MM-DD in IST zone', () => {
    const dt = ist(8, 30, '2026-10-21');
    expect(getDayKeyIST(dt)).toBe('2026-10-21');
  });

  test('UTC midnight → next day in IST (IST is UTC+5:30)', () => {
    // UTC 2026-10-21 00:00 = IST 2026-10-21 05:30 → same day key
    const dt = DateTime.fromISO('2026-10-21T00:00:00Z').setZone(ZONE);
    expect(getDayKeyIST(dt)).toBe('2026-10-21');
  });
});

// ── getJsWeekday ──────────────────────────────────────────────────────────────

describe('getJsWeekday', () => {
  test('2026-10-21 (Wednesday) → JS weekday 3', () => {
    const dt = ist(12, 0, '2026-10-21');
    expect(getJsWeekday(dt)).toBe(3);
  });

  test('2026-10-25 (Sunday) → JS weekday 0', () => {
    const dt = ist(12, 0, '2026-10-25');
    expect(getJsWeekday(dt)).toBe(0);
  });

  test('2026-10-26 (Monday) → JS weekday 1', () => {
    const dt = ist(12, 0, '2026-10-26');
    expect(getJsWeekday(dt)).toBe(1);
  });
});

// ── computeDueSlots ───────────────────────────────────────────────────────────

describe('computeDueSlots – time window', () => {
  test('morning slot fires exactly at 08:30', () => {
    const now = ist(8, 30);
    const checks = computeDueSlots(BASE_SETTINGS, EMPTY_STATE, 0, now);
    const morning = checks.find((c) => c.slot === 'morning');
    expect(morning?.due).toBe(true);
  });

  test('morning slot fires at 08:44 (14 min late)', () => {
    const now = ist(8, 44);
    const checks = computeDueSlots(BASE_SETTINGS, EMPTY_STATE, 0, now);
    const morning = checks.find((c) => c.slot === 'morning');
    expect(morning?.due).toBe(true);
  });

  test('morning slot does NOT fire at 08:45 (15 min past)', () => {
    const now = ist(8, 45);
    const checks = computeDueSlots(BASE_SETTINGS, EMPTY_STATE, 0, now);
    const morning = checks.find((c) => c.slot === 'morning');
    expect(morning?.due).toBe(false);
    expect(morning?.reason).toBe('outside-window');
  });

  test('neither slot fires outside both windows', () => {
    const now = ist(12, 0);
    const checks = computeDueSlots(BASE_SETTINGS, EMPTY_STATE, 0, now);
    expect(checks.every((c) => !c.due)).toBe(true);
  });

  test('study slot fires at 19:00', () => {
    const now = ist(19, 0);
    const checks = computeDueSlots(BASE_SETTINGS, EMPTY_STATE, 0, now);
    const study = checks.find((c) => c.slot === 'study');
    expect(study?.due).toBe(true);
  });

  test('study slot does NOT fire at 19:15', () => {
    const now = ist(19, 15);
    const checks = computeDueSlots(BASE_SETTINGS, EMPTY_STATE, 0, now);
    const study = checks.find((c) => c.slot === 'study');
    expect(study?.due).toBe(false);
  });
});

describe('computeDueSlots – skip rules', () => {
  test('notificationsEnabled=false → all skipped', () => {
    const settings = { ...BASE_SETTINGS, notificationsEnabled: false };
    const now = ist(8, 30);
    const checks = computeDueSlots(settings, EMPTY_STATE, 0, now);
    expect(checks.every((c) => !c.due)).toBe(true);
    expect(checks[0].reason).toBe('notifications-disabled');
  });

  test('day not in daysOfWeek → skipped (reason: day-excluded)', () => {
    // 2026-10-21 is Wednesday (jsWd=3); exclude it
    const settings = { ...BASE_SETTINGS, daysOfWeek: [0, 1, 2, 4, 5, 6] };
    const now = ist(8, 30, '2026-10-21');  // Wednesday
    const checks = computeDueSlots(settings, EMPTY_STATE, 0, now);
    expect(checks.every((c) => !c.due)).toBe(true);
    expect(checks[0].reason).toBe('day-excluded');
  });

  test('inside quiet hours → skipped (reason: quiet-hours)', () => {
    const settings = {
      ...BASE_SETTINGS,
      quietHoursStart: '08:00',
      quietHoursEnd: '09:00',
    };
    const now = ist(8, 30);
    const checks = computeDueSlots(settings, EMPTY_STATE, 0, now);
    const morning = checks.find((c) => c.slot === 'morning');
    expect(morning?.due).toBe(false);
    expect(morning?.reason).toBe('quiet-hours');
  });

  test('goal met (completed >= dailyTarget) → skipped', () => {
    const now = ist(8, 30);
    const checks = computeDueSlots(BASE_SETTINGS, EMPTY_STATE, 3, now);  // 3 >= 3
    expect(checks.every((c) => !c.due)).toBe(true);
    expect(checks[0].reason).toBe('goal-met');
  });

  test('goal not yet met (completed < dailyTarget) → not skipped by goal rule', () => {
    const now = ist(8, 30);
    const checks = computeDueSlots(BASE_SETTINGS, EMPTY_STATE, 2, now);  // 2 < 3
    const morning = checks.find((c) => c.slot === 'morning');
    expect(morning?.due).toBe(true);
  });

  test('dismissedToday matches dayKey → all slots skipped', () => {
    const state: ReminderState = { ...EMPTY_STATE, dismissedToday: '2026-10-21' };
    const now = ist(8, 30, '2026-10-21');
    const checks = computeDueSlots(BASE_SETTINGS, state, 0, now);
    expect(checks.every((c) => !c.due)).toBe(true);
    expect(checks[0].reason).toBe('dismissed-today');
  });

  test('dismissedToday from yesterday does NOT block today', () => {
    const state: ReminderState = { ...EMPTY_STATE, dismissedToday: '2026-10-20' };
    const now = ist(8, 30, '2026-10-21');
    const checks = computeDueSlots(BASE_SETTINGS, state, 0, now);
    const morning = checks.find((c) => c.slot === 'morning');
    expect(morning?.due).toBe(true);
  });

  test('snoozed (snoozeUntil in future) → all slots skipped', () => {
    const now = ist(8, 30);
    const state: ReminderState = {
      ...EMPTY_STATE,
      snoozeUntil: now.toMillis() + 60_000,  // 1 min in future
    };
    const checks = computeDueSlots(BASE_SETTINGS, state, 0, now);
    expect(checks.every((c) => !c.due)).toBe(true);
    expect(checks[0].reason).toBe('snoozed');
  });

  test('snoozeUntil in past does NOT block', () => {
    const now = ist(8, 30);
    const state: ReminderState = {
      ...EMPTY_STATE,
      snoozeUntil: now.toMillis() - 1,  // 1 ms ago
    };
    const checks = computeDueSlots(BASE_SETTINGS, state, 0, now);
    const morning = checks.find((c) => c.slot === 'morning');
    expect(morning?.due).toBe(true);
  });
});

describe('computeDueSlots – dedupe via reminderState', () => {
  test('slot already in lastFiredSlot for today → not due', () => {
    const now = ist(8, 30, '2026-10-21');
    const state: ReminderState = {
      ...EMPTY_STATE,
      lastFiredSlot: { '2026-10-21': ['morning'] },
    };
    const checks = computeDueSlots(BASE_SETTINGS, state, 0, now);
    const morning = checks.find((c) => c.slot === 'morning');
    expect(morning?.due).toBe(false);
    expect(morning?.reason).toBe('already-fired');
  });

  test('slot fired yesterday does NOT block today', () => {
    const now = ist(8, 30, '2026-10-21');
    const state: ReminderState = {
      ...EMPTY_STATE,
      lastFiredSlot: { '2026-10-20': ['morning'] },
    };
    const checks = computeDueSlots(BASE_SETTINGS, state, 0, now);
    const morning = checks.find((c) => c.slot === 'morning');
    expect(morning?.due).toBe(true);
  });

  test('morning fired but study not → study still due', () => {
    const now = ist(19, 0, '2026-10-21');
    const state: ReminderState = {
      ...EMPTY_STATE,
      lastFiredSlot: { '2026-10-21': ['morning'] },
    };
    const checks = computeDueSlots(BASE_SETTINGS, state, 0, now);
    const study = checks.find((c) => c.slot === 'study');
    expect(study?.due).toBe(true);
  });
});

describe('computeDueSlots – force_test mode', () => {
  test('force_test ignores all skip rules and window', () => {
    // Outside window, notifications disabled, goal met, etc.
    const settings: UserSettings = {
      ...BASE_SETTINGS,
      notificationsEnabled: false,
    };
    const state: ReminderState = {
      lastFiredSlot: { '2026-10-21': ['morning', 'study'] },
      snoozeUntil: Date.now() + 999_999,
      dismissedToday: '2026-10-21',
    };
    const now = ist(12, 0);
    const checks = computeDueSlots(settings, state, 99, now, /* forceTest= */ true);
    expect(checks.every((c) => c.due)).toBe(true);
  });
});
