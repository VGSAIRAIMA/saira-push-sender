/**
 * tokens.test.ts
 *
 * Tests for: token cleanup on invalid FCM error codes, dry-run mode
 * returning success counts without calling FCM.
 *
 * Uses fake messaging and fake Firestore — no real credentials.
 * No tokens, device IDs, or user IDs appear in assertions or logs.
 */

import { sendToDevices } from '../src/tokens';
import type { DeviceDoc } from '../src/types';

// ── fakes ─────────────────────────────────────────────────────────────────────

function makeDevice(overrides: Partial<DeviceDoc> = {}): DeviceDoc {
  return {
    id: 'fake-device-id',         // not logged in any assertion
    token: 'fake-fcm-token',      // not logged in any assertion
    platform: 'desktop',
    tz: 'Asia/Kolkata',
    lastSeenAt: null,
    ...overrides,
  };
}

function makeFakeMessaging(responses: Array<{ success: boolean; errorCode?: string }>) {
  return {
    sendEachForMulticast: jest.fn(async () => ({
      successCount: responses.filter((r) => r.success).length,
      failureCount: responses.filter((r) => !r.success).length,
      responses: responses.map((r) =>
        r.success
          ? { success: true, messageId: 'msg-id' }
          : { success: false, error: { code: r.errorCode ?? 'messaging/unknown' } }
      ),
    })),
  };
}

function makeFakeDb(deleteFn = jest.fn()) {
  return {
    doc: jest.fn(() => ({ delete: deleteFn })),
  };
}

// ── dry run ───────────────────────────────────────────────────────────────────

describe('sendToDevices – dry run', () => {
  test('dry run: does not call messaging, returns device count as successCount', async () => {
    const messaging = makeFakeMessaging([]);
    const db = makeFakeDb();
    const devices = [makeDevice(), makeDevice()];

    const result = await sendToDevices(
      messaging as never,
      db as never,
      'uid-placeholder',
      devices,
      'morning',
      'Good morning!',
      '2026-10-21',
      true  // dryRun
    );

    expect(messaging.sendEachForMulticast).not.toHaveBeenCalled();
    expect(result.successCount).toBe(2);
    expect(result.tokensRemoved).toBe(0);
    // uid-placeholder is used as argument only — never printed by sendToDevices itself
  });

  test('dry run with zero devices returns zeros', async () => {
    const messaging = makeFakeMessaging([]);
    const db = makeFakeDb();

    const result = await sendToDevices(
      messaging as never,
      db as never,
      'uid-placeholder',
      [],
      'study',
      'Study time!',
      '2026-10-21',
      true
    );

    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(0);
    expect(result.tokensRemoved).toBe(0);
  });
});

// ── token cleanup ─────────────────────────────────────────────────────────────

describe('sendToDevices – invalid token cleanup', () => {
  test('registration-token-not-registered causes device deletion', async () => {
    const deleteFn = jest.fn().mockResolvedValue(undefined);
    const db = makeFakeDb(deleteFn);

    const messaging = makeFakeMessaging([
      { success: false, errorCode: 'messaging/registration-token-not-registered' },
    ]);

    const device = makeDevice();
    const result = await sendToDevices(
      messaging as never,
      db as never,
      'uid-placeholder',
      [device],
      'morning',
      'Hello!',
      '2026-10-21',
      false  // real send
    );

    // Device should be deleted
    expect(db.doc).toHaveBeenCalledWith('users/uid-placeholder/devices/fake-device-id');
    expect(deleteFn).toHaveBeenCalledTimes(1);
    expect(result.tokensRemoved).toBe(1);
    expect(result.successCount).toBe(0);
  });

  test('invalid-registration-token also triggers cleanup', async () => {
    const deleteFn = jest.fn().mockResolvedValue(undefined);
    const db = makeFakeDb(deleteFn);

    const messaging = makeFakeMessaging([
      { success: false, errorCode: 'messaging/invalid-registration-token' },
    ]);

    await sendToDevices(
      messaging as never,
      db as never,
      'uid-placeholder',
      [makeDevice()],
      'study',
      'Study!',
      '2026-10-21',
      false
    );

    expect(deleteFn).toHaveBeenCalledTimes(1);
  });

  test('generic failure does NOT delete device', async () => {
    const deleteFn = jest.fn();
    const db = makeFakeDb(deleteFn);

    const messaging = makeFakeMessaging([
      { success: false, errorCode: 'messaging/unavailable' },
    ]);

    const result = await sendToDevices(
      messaging as never,
      db as never,
      'uid-placeholder',
      [makeDevice()],
      'morning',
      'Hello!',
      '2026-10-21',
      false
    );

    expect(deleteFn).not.toHaveBeenCalled();
    expect(result.tokensRemoved).toBe(0);
    expect(result.failureCount).toBe(1);
  });

  test('mixed results: one success, one invalid → 1 deleted, 1 success', async () => {
    const deleteFn = jest.fn().mockResolvedValue(undefined);
    const db = makeFakeDb(deleteFn);

    const messaging = makeFakeMessaging([
      { success: true },
      { success: false, errorCode: 'messaging/registration-token-not-registered' },
    ]);

    const devices = [makeDevice({ id: 'dev-a' }), makeDevice({ id: 'dev-b' })];

    const result = await sendToDevices(
      messaging as never,
      db as never,
      'uid-placeholder',
      devices,
      'morning',
      'Good morning!',
      '2026-10-21',
      false
    );

    expect(result.successCount).toBe(1);
    expect(result.tokensRemoved).toBe(1);
    expect(deleteFn).toHaveBeenCalledTimes(1);
  });
});
