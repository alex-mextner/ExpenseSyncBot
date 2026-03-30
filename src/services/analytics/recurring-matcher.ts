/** Checks if a newly added expense matches a recurring pattern, and periodically detects new patterns */

import { database } from '../../database';
import { createLogger } from '../../utils/logger.ts';
import { computeNextExpectedDate, detectRecurringPatterns } from './recurring-detector';

const logger = createLogger('recurring-matcher');

/** Rate limit pattern detection to once per day per group */
const lastDetectionRun = new Map<number, number>();
const DETECTION_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Amount tolerance: expenses within +/-20% are considered a match */
const AMOUNT_TOLERANCE = 0.2;

/**
 * Check if a newly recorded expense matches an existing recurring pattern.
 * If a match is found, updates last_seen_date and next_expected_date.
 * Periodically (once per day per group) runs full pattern detection and auto-saves new patterns.
 */
export function checkRecurringMatch(
  groupId: number,
  category: string,
  amount: number,
  currency: string,
  date: string,
): void {
  // 1. Check active patterns for a match
  const patterns = database.recurringPatterns.findByGroupId(groupId);
  for (const pattern of patterns) {
    if (pattern.category === category && pattern.currency === currency) {
      const maxRef = Math.max(amount, pattern.expected_amount);
      if (maxRef === 0) continue;
      const ratio = Math.abs(amount - pattern.expected_amount) / maxRef;
      if (ratio <= AMOUNT_TOLERANCE) {
        const nextDate = computeNextExpectedDate(date, pattern.expected_day ?? 15);
        database.recurringPatterns.updateLastSeen(pattern.id, date, nextDate);
        logger.info({ patternId: pattern.id, category }, 'Recurring pattern matched');
        return;
      }
    }
  }

  // 2. Periodically detect new patterns
  const lastRun = lastDetectionRun.get(groupId) ?? 0;
  if (Date.now() - lastRun < DETECTION_COOLDOWN_MS) return;
  lastDetectionRun.set(groupId, Date.now());

  const detected = detectRecurringPatterns(groupId);
  if (detected.length === 0) return;

  // Auto-save detected patterns
  for (const pattern of detected) {
    const nextDate = computeNextExpectedDate(pattern.lastDate, pattern.expectedDay);
    database.recurringPatterns.create({
      group_id: groupId,
      category: pattern.category,
      expected_amount: pattern.expectedAmount,
      currency: pattern.currency,
      expected_day: pattern.expectedDay,
      last_seen_date: pattern.lastDate,
      next_expected_date: nextDate,
    });
    logger.info(
      { category: pattern.category, amount: pattern.expectedAmount },
      'Auto-saved recurring pattern',
    );
  }
}
