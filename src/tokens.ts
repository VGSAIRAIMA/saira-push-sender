/**
 * tokens.ts — FCM multicast send and token cleanup.
 *
 * Contract reference: docs/12-push-sender-contract.md §4, §6.
 *
 * SECURITY: tokens and device IDs are NEVER logged.
 * Only counts are exposed.
 */

import type * as admin from 'firebase-admin';
import type { DeviceDoc, Slot } from './types';
import { deleteDevice } from './firestore';

/** FCM error codes that mean the token is permanently invalid. */
const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

export interface SendResult {
  successCount: number;
  failureCount: number;
  tokensRemoved: number;
}

/**
 * Build the FCM data-only multicast payload.
 *
 * Contract §6: data-only (no `notification` block).
 * webpush TTL = 3600 s; urgency = high.
 */
function buildMessage(
  tokens: string[],
  slot: Slot,
  line: string,
  dayKey: string
): admin.messaging.MulticastMessage {
  return {
    tokens,
    data: {
      slot,
      line,
      url:      `/today?coach=${slot}`,
      dayKey,
      imageUrl: '/icons/icon-192.png',
    },
    webpush: {
      headers: {
        TTL:     '3600',   // 1 hour; stale reminders should not arrive hours later
        Urgency: 'high',
      },
      fcmOptions: {
        link: 'https://saira-dsa.web.app/today',
      },
    },
  };
}

/**
 * Send the notification to all valid device tokens for one user.
 *
 * Returns counts only — no token strings in the return value.
 */
export async function sendToDevices(
  messaging: admin.messaging.Messaging,
  db: admin.firestore.Firestore,
  uid: string,
  devices: DeviceDoc[],
  slot: Slot,
  line: string,
  dayKey: string,
  dryRun: boolean
): Promise<SendResult> {
  if (devices.length === 0) {
    return { successCount: 0, failureCount: 0, tokensRemoved: 0 };
  }

  if (dryRun) {
    return {
      successCount: devices.length,
      failureCount: 0,
      tokensRemoved: 0,
    };
  }

  const tokens  = devices.map((d) => d.token);
  const message = buildMessage(tokens, slot, line, dayKey);

  const response = await messaging.sendEachForMulticast(message);

  let tokensRemoved = 0;

  // Process per-token results. Never log token strings or device IDs.
  for (let i = 0; i < response.responses.length; i++) {
    const r = response.responses[i];
    if (!r.success && r.error) {
      const code = r.error.code ?? '';
      if (INVALID_TOKEN_CODES.has(code)) {
        // Delete the stale device doc silently; never log its ID or token.
        await deleteDevice(db, uid, devices[i].id).catch(() => {
          // best effort — don't let cleanup failures abort other sends
        });
        tokensRemoved++;
      }
    }
  }

  return {
    successCount: response.successCount,
    failureCount: response.failureCount,
    tokensRemoved,
  };
}
