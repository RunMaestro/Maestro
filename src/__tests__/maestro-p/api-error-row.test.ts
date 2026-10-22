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

import {
	isRateLimitErrorRow,
	terminalApiErrorTag,
	TERMINAL_API_ERROR_TAGS,
} from '../../maestro-p/api-error-row';

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

// The row from the run reported in issue #1753 (`--model no-such-model-xyz`).
const modelNotFoundRow = {
	type: 'assistant',
	isApiErrorMessage: true,
	error: 'model_not_found',
	message: {
		model: '<synthetic>',
		stop_reason: 'stop_sequence',
		content: [
			{
				type: 'text',
				text: "There's an issue with the selected model (no-such-model-xyz). It may not exist or you may not have access to it.",
			},
		],
	},
};

describe('terminalApiErrorTag', () => {
	it('recognizes the synthetic model_not_found row', () => {
		expect(terminalApiErrorTag(modelNotFoundRow)).toBe('model_not_found');
	});

	it('recognizes every tag on the terminal allowlist', () => {
		for (const tag of TERMINAL_API_ERROR_TAGS) {
			expect(terminalApiErrorTag({ ...modelNotFoundRow, error: tag })).toBe(tag);
		}
	});

	it('accepts the snake_case flag stream-json stdout uses', () => {
		const { isApiErrorMessage: _flag, ...rest } = modelNotFoundRow;
		expect(terminalApiErrorTag({ ...rest, is_api_error_message: true })).toBe('model_not_found');
	});

	it('leaves rate_limit to isRateLimitErrorRow', () => {
		expect(terminalApiErrorTag(weeklyLimitRow)).toBeNull();
	});

	it('treats provisional and unlisted tags as non-terminal', () => {
		expect(terminalApiErrorTag({ ...modelNotFoundRow, error: 'server_error' })).toBeNull();
		expect(terminalApiErrorTag({ ...modelNotFoundRow, error: 'unknown' })).toBeNull();
		expect(terminalApiErrorTag({ ...modelNotFoundRow, error: 'some_future_tag' })).toBeNull();
	});

	it('requires the API-error flag', () => {
		const { isApiErrorMessage: _flag, ...unflagged } = modelNotFoundRow;
		expect(terminalApiErrorTag(unflagged)).toBeNull();
		expect(terminalApiErrorTag({ ...modelNotFoundRow, isApiErrorMessage: false })).toBeNull();
	});

	it('ignores non-assistant rows and non-string tags', () => {
		expect(terminalApiErrorTag({ ...modelNotFoundRow, type: 'user' })).toBeNull();
		expect(
			terminalApiErrorTag({ ...modelNotFoundRow, error: { type: 'model_not_found' } })
		).toBeNull();
	});

	it('ignores non-object input', () => {
		expect(terminalApiErrorTag(null)).toBeNull();
		expect(terminalApiErrorTag(undefined)).toBeNull();
		expect(terminalApiErrorTag('model_not_found')).toBeNull();
	});
});
