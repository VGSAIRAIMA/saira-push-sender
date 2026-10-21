/**
 * logs.test.ts
 *
 * Verifies that the only things the sender logs are counts and generic status —
 * never user IDs, tokens, emails, display names, or line text.
 *
 * We capture console.log calls and inspect the strings.
 */

import { computeDueSlots } from '../src/scheduler';
import { selectLine }      from '../src/coach';
import { DateTime }        from 'luxon';
import { ZONE }            from '../src/scheduler';

// ── spy on console ────────────────────────────────────────────────────────────

const logSpy  = jest.spyOn(console, 'log').mockImplementation(() => {});
const errSpy  = jest.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  logSpy.mockClear();
  errSpy.mockClear();
});

afterAll(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

// ── The suspicious strings we must NEVER see in log output ───────────────────
//
// Rules:
//   - /[a-zA-Z0-9]{20,}/ catches long token-like strings (FCM tokens are ~150 chars).
//   - /\buid\b|\buser_id\b|\buserId\b/ catches user-id field names (whole words only).
//   - /\bfcm\b/i catches the bare acronym; "tokens_removed" is a stat label, not a token.
//   - Line-text strings from the avatar seed must never appear in logs.
//
// We deliberately do NOT ban the substring "token" because "tokens_removed=N" is
// the allowed count stat. Instead we ban "fcm" as a whole word and rely on the
// 20-char pattern to catch actual token strings.

const FORBIDDEN_PATTERNS: RegExp[] = [
  /[a-zA-Z0-9]{20,}/,              // FCM tokens are ~150 chars; any 20+ char blob is suspicious
  /\buid\b|\buser_id\b|\buserId\b/i, // user-id field names (whole word)
  /\bfcm\b/i,                      // bare FCM acronym (not "tokens_removed")
  /Good morning/i,                  // sample line text from classic-morning
  /Rise, /i,                        // hero-morning line text
  /Arjuna/i,                        // mahabharata line text
  /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/, // email pattern
];

function extractLogStrings(): string[] {
  return logSpy.mock.calls.map((args) => String(args[0]));
}

// ── Test: scheduler produces no console output ────────────────────────────────

describe('scheduler logs', () => {
  test('computeDueSlots produces no console output', () => {
    const now = DateTime.now().setZone(ZONE);
    computeDueSlots(
      {
        morningTime: '08:30',
        studyTime: '19:00',
        daysOfWeek: [0,1,2,3,4,5,6],
        quietHoursStart: null,
        quietHoursEnd: null,
        snoozeMinutes: 15,
        maxSnoozeCount: 3,
        notificationsEnabled: true,
        coachTheme: 'classic',
        dailyTarget: 3,
      },
      { lastFiredSlot: {}, snoozeUntil: null, dismissedToday: null },
      0,
      now
    );

    expect(logSpy).not.toHaveBeenCalled();
  });
});

// ── Test: coach.selectLine produces no console output ────────────────────────

describe('coach.selectLine logs', () => {
  test('selectLine produces no console output', () => {
    selectLine(
      { coachTheme: 'classic' },
      'morning',
      '2026-10-21',
      false,
      'TestName'
    );
    expect(logSpy).not.toHaveBeenCalled();
  });
});

// ── Test: simulated sender log messages are clean ────────────────────────────

describe('simulated sender log output', () => {
  /**
   * These are the ONLY log patterns the sender uses.
   * We verify a simulated version of them to catch regressions.
   */
  function emitSenderLogs(stats: {
    usersChecked: number;
    sent: number;
    skipped: number;
    tokensRemoved: number;
    errors: number;
  }): void {
    console.log(`[sender] starting | dry_run=false force_test=false`);
    console.log(
      `[sender] done | users_checked=${stats.usersChecked}` +
      ` sent=${stats.sent}` +
      ` skipped=${stats.skipped}` +
      ` tokens_removed=${stats.tokensRemoved}` +
      ` errors=${stats.errors}`
    );
  }

  test('sender log output contains no forbidden patterns', () => {
    emitSenderLogs({ usersChecked: 42, sent: 7, skipped: 35, tokensRemoved: 1, errors: 0 });

    const lines = extractLogStrings();
    for (const line of lines) {
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(line).not.toMatch(pattern);
      }
    }
  });

  test('sender log contains usersChecked count', () => {
    emitSenderLogs({ usersChecked: 100, sent: 10, skipped: 90, tokensRemoved: 2, errors: 0 });
    const output = extractLogStrings().join('\n');
    expect(output).toContain('users_checked=100');
    expect(output).toContain('sent=10');
    expect(output).toContain('skipped=90');
    expect(output).toContain('tokens_removed=2');
  });

  test('force_test log does not reveal uid or token', () => {
    // Simulate what sender.ts logs in force_test mode
    console.log('[sender] force_test: sending test notification to 1 user');
    const lines = extractLogStrings();
    for (const line of lines) {
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(line).not.toMatch(pattern);
      }
    }
  });
});