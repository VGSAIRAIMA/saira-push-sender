/**
 * types.ts — shared TypeScript types for the push sender.
 * No secrets, no user data logged anywhere.
 */

export type Slot = 'morning' | 'study';

export interface UserSettings {
  morningTime: string;         // HH:MM 24h in user's tz (always Asia/Kolkata per contract)
  studyTime: string;
  daysOfWeek: number[];        // JS weekday: 0=Sunday … 6=Saturday
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  snoozeMinutes: number;
  maxSnoozeCount: number;
  notificationsEnabled: boolean;
  coachTheme: 'classic' | 'hero' | 'realm' | 'mahabharata' | 'mix';
  dailyTarget: number;         // default 3
}

export interface ReminderState {
  lastFiredSlot: Record<string, string[]>; // { "2026-10-21": ["morning"] }
  snoozeUntil: number | null;              // Unix ms
  dismissedToday: string | null;           // dayKey
}

export interface DeviceDoc {
  id: string;                  // Firestore doc ID — never logged
  token: string;               // FCM token — never logged
  platform: string;
  tz: string;
  lastSeenAt: FirebaseFirestore.Timestamp | null;
}

export interface DayDoc {
  completed: number;
}

export interface UserProfile {
  displayName?: string;
}

export interface RunStats {
  usersChecked: number;
  sent: number;
  skipped: number;
  tokensRemoved: number;
  errors: number;
}
