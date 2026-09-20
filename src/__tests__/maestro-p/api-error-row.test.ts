/**
 * @file api-error-row.test.ts
 * @description Tests for src/maestro-p/api-error-row.ts plan-limit row detection.
 *
 * When a plan limit is hit mid-turn, claude writes a synthetic assistant row
 * tagged `error: 'rate_limit'` and goes idle. That row is the only transcript
 * signal that the turn is over, so `isRateLimitErrorRow` must recognize it
 * without depending on the banner wording, and must NOT fire on claude's other
 * API-error rows, which claude retries past.
 */

import { describe, it, expect } from 'vitest';

import { isRateLimitErrorRow } from '../../maestro-p/api-error-row';

// The last transcript row of the real run reported in issue #1578.
const weeklyLimitRow = {
	type: 'assistant',
	isApiErrorMessage: true,
	error: 'rate_limit',
	message: {
		model: '<synthetic>',
		stop_reason: 'stop_sequence',
		content: [
			{
				type: 'text',
				text: "You've hit your weekly limit · resets Aug 27 at 10am (America/Chicago)",
			},
		],
	},
};

describe('isRateLimitErrorRow', () => {
	it('recognizes the synthetic weekly-limit row claude writes to the transcript', () => {
		expect(isRateLimitErrorRow(weeklyLimitRow)).toBe(true);
	});

	it('does not depend on the banner wording', () => {
		const reworded = {
			...weeklyLimitRow,
			message: { ...weeklyLimitRow.message, content: [{ type: 'text', text: 'Out of quota.' }] },
		};
		expect(isRateLimitErrorRow(reworded)).toBe(true);
	});

	it('accepts the snake_case flag stream-json stdout uses', () => {
		const { isApiErrorMessage: _flag, ...rest } = weeklyLimitRow;
		expect(isRateLimitErrorRow({ ...rest, is_api_error_message: true })).toBe(true);
	});

	it('ignores API-error rows claude retries past', () => {
		expect(isRateLimitErrorRow({ ...weeklyLimitRow, error: 'server_error' })).toBe(false);
	});

	it('requires the API-error flag', () => {
		const { isApiErrorMessage: _flag, ...unflagged } = weeklyLimitRow;
		expect(isRateLimitErrorRow(unflagged)).toBe(false);
		expect(isRateLimitErrorRow({ ...weeklyLimitRow, isApiErrorMessage: false })).toBe(false);
	});

	it('ignores non-assistant rows', () => {
		expect(isRateLimitErrorRow({ ...weeklyLimitRow, type: 'user' })).toBe(false);
	});

	it('ignores an ordinary assistant row', () => {
		expect(
			isRateLimitErrorRow({
				type: 'assistant',
				message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
			})
		).toBe(false);
	});

	it('ignores non-object input', () => {
		expect(isRateLimitErrorRow(null)).toBe(false);
		expect(isRateLimitErrorRow(undefined)).toBe(false);
		expect(isRateLimitErrorRow('rate_limit')).toBe(false);
	});
});
