/**
 * coach.ts — theme and line selection.
 *
 * Contract reference: docs/12-push-sender-contract.md §5.
 * The avatar-lines.seed.json is bundled in this repo; never fetched from the
 * main SAIRA repo at runtime.
 *
 * No user data is logged here.
 */

import type { Slot, UserSettings } from './types';
import avatarLines from './data/avatar-lines.seed.json';

type ThemeName = 'classic' | 'hero' | 'realm' | 'mahabharata';
type GroupName = 'morning' | 'study' | 'nudge_missed';

const THEMES: ThemeName[] = ['classic', 'hero', 'realm', 'mahabharata'];

interface AvatarLines {
  schemaVersion: number;
  themes: Record<ThemeName, Record<GroupName, string[]>>;
}

const lines = avatarLines as unknown as AvatarLines;

/**
 * Deterministic daily theme rotation for "mix".
 * Same formula as the contract (§5).
 */
export function resolveTheme(coachTheme: UserSettings['coachTheme'], dayKey: string): ThemeName {
  if (coachTheme !== 'mix') return coachTheme as ThemeName;

  let hash = 0;
  for (const ch of dayKey) hash = ((hash * 31) + ch.charCodeAt(0)) >>> 0;
  return THEMES[hash % THEMES.length];
}

/**
 * Pick a random line from the correct theme+group.
 * Returns the line WITH {name} still present — caller substitutes it.
 */
export function pickLine(
  theme: ThemeName,
  group: GroupName,
  randomFn: () => number = Math.random
): string {
  const pool = lines.themes[theme]?.[group];
  if (!pool || pool.length === 0) {
    // Fallback to classic if group is missing for some theme
    const fallback = lines.themes['classic'][group];
    return fallback[Math.floor(randomFn() * fallback.length)];
  }
  return pool[Math.floor(randomFn() * pool.length)];
}

/**
 * Full line selection pipeline.
 *
 * @param settings     user settings (theme)
 * @param slot         'morning' | 'study'
 * @param dayKey       IST YYYY-MM-DD
 * @param missedYesterday  if true use nudge_missed group
 * @param firstName    learner first name for {name} substitution
 * @param randomFn     injectable for tests
 */
export function selectLine(
  settings: Pick<UserSettings, 'coachTheme'>,
  slot: Slot,
  dayKey: string,
  missedYesterday: boolean,
  firstName: string,
  randomFn: () => number = Math.random
): string {
  const theme = resolveTheme(settings.coachTheme, dayKey);
  const group: GroupName = missedYesterday ? 'nudge_missed' : slot;
  const raw = pickLine(theme, group, randomFn);
  return raw.replace(/\{name\}/g, firstName);
}
