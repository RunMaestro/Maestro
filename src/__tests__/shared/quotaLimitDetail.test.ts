/**
 * Tests for quotaLimitDetail - reading Claude Code's structured plan-limit
 * payload so a limit banner can say WHICH window was exhausted and whether
 * anything can be done about it.
 *
 * The payload shapes here are copied from the real captured transcript already
 * used by `claude-output-parser.test.ts`, so the two agree about what actually
 * arrives on the wire.
 */

import { describe, it, expect } from 'vitest';
import {
	parseQuotaLimitDetail,
	describeQuotaWindow,
	describeQuotaRemedy,
} from '../../shared/quotaLimitDetail';

/** The real envelope Claude Code emits on a hit 5-hour limit, trimmed. */
const REAL_ENVELOPE = {
	type: 'assistant',
	error: 'rate_limit',
	isApiErrorMessage: true,
	apiErrorStatus: 429,
	quotaLimits: {
		status: 'rejected',
		resetsAt: 1787416800,
		rateLimitType: 'five_hour',
		overageStatus: 'rejected',
		overageDisabledReason: 'out_of_credits',
	},
	message: {
		role: 'assistant',
		model: '<synthetic>',
		content: [{ type: 'text', text: "You've hit your session limit · resets 11:40am" }],
	},
};

describe('parseQuotaLimitDetail', () => {
	it('reads every field off the real captured envelope', () => {
		const detail = parseQuotaLimitDetail(REAL_ENVELOPE);
		expect(detail).toEqual({
			window: 'five_hour',
			windowRaw: 'five_hour',
			status: 'rejected',
			resetsAt: 1787416800 * 1000,
			overageStatus: 'rejected',
			overageInUse: undefined,
			overageDisabledReason: 'out_of_credits',
		});
	});

	it('converts epoch seconds to milliseconds but leaves milliseconds alone', () => {
		expect(parseQuotaLimitDetail({ quotaLimits: { resetsAt: 1787416800 } })?.resetsAt).toBe(
			1787416800_000
		);
		expect(parseQuotaLimitDetail({ quotaLimits: { resetsAt: 1787416800000 } })?.resetsAt).toBe(
			1787416800000
		);
	});

	it('keeps an unrecognized rateLimitType as raw rather than inventing a window', () => {
		const detail = parseQuotaLimitDetail({
			quotaLimits: { rateLimitType: 'thirty_day_sonnet', status: 'rejected' },
		});
		expect(detail?.window).toBe('unknown');
		expect(detail?.windowRaw).toBe('thirty_day_sonnet');
	});

	it('recognizes the weekly windows', () => {
		expect(parseQuotaLimitDetail({ quotaLimits: { rateLimitType: 'seven_day' } })?.window).toBe(
			'seven_day'
		);
		expect(
			parseQuotaLimitDetail({ quotaLimits: { rateLimitType: 'seven_day_opus' } })?.window
		).toBe('seven_day_opus');
	});

	it('accepts snake_case spellings and the rate_limit container', () => {
		const detail = parseQuotaLimitDetail({
			rate_limit: {
				rate_limit_type: 'seven_day',
				resets_at: 1787416800,
				overage_status: 'allowed',
				overage_in_use: true,
			},
		});
		expect(detail?.window).toBe('seven_day');
		expect(detail?.resetsAt).toBe(1787416800_000);
		expect(detail?.overageStatus).toBe('allowed');
		expect(detail?.overageInUse).toBe(true);
	});

	it('returns undefined when no quota object came through', () => {
		// The plain `--output-format stream-json` path forwards only the message
		// envelope, so every consumer has to handle absence.
		expect(parseQuotaLimitDetail({ type: 'assistant', message: { content: [] } })).toBeUndefined();
		expect(parseQuotaLimitDetail(undefined)).toBeUndefined();
		expect(parseQuotaLimitDetail('not an object')).toBeUndefined();
	});

	it('returns undefined for a quota container carrying none of the fields we read', () => {
		// An empty block on screen says less than the notice text above it.
		expect(parseQuotaLimitDetail({ quotaLimits: { somethingElse: 1 } })).toBeUndefined();
	});
});

describe('describeQuotaWindow', () => {
	it('names each recognized window', () => {
		expect(describeQuotaWindow({ window: 'five_hour' })).toBe('5-hour session limit');
		expect(describeQuotaWindow({ window: 'seven_day' })).toBe('Weekly limit');
		expect(describeQuotaWindow({ window: 'seven_day_opus' })).toBe('Weekly Opus limit');
	});

	it('falls back to a generic name for an unknown or absent window', () => {
		expect(describeQuotaWindow({ window: 'unknown' })).toBe('Plan limit');
		expect(describeQuotaWindow(undefined)).toBe('Plan limit');
	});
});

describe('describeQuotaRemedy', () => {
	// THE TRAP THIS FUNCTION EXISTS FOR. `overageStatus` stays `allowed` after
	// hard exhaustion, so a surface reading it alone would tell a user whose turn
	// was just cut off that paid extra usage has them covered.
	it('never claims coverage once the request was rejected, even with overage allowed', () => {
		const remedy = describeQuotaRemedy({
			window: 'five_hour',
			status: 'rejected',
			overageStatus: 'allowed',
		});
		expect(remedy).toBeDefined();
		expect(remedy).not.toMatch(/cover/i);
		expect(remedy).toMatch(/exhausted/i);
	});

	it('names out-of-credits as the reason nothing can extend the window', () => {
		expect(describeQuotaRemedy(parseQuotaLimitDetail(REAL_ENVELOPE))).toMatch(/out of credits/i);
	});

	it('says extra usage will not help when overage is itself rejected', () => {
		expect(
			describeQuotaRemedy({ window: 'seven_day', status: 'rejected', overageStatus: 'rejected' })
		).toMatch(/will not cover/i);
	});

	it('reports active coverage only when the request was not rejected', () => {
		expect(
			describeQuotaRemedy({
				window: 'five_hour',
				status: 'allowed_warning',
				overageStatus: 'allowed_warning',
				overageInUse: true,
			})
		).toMatch(/covering the overflow/i);
	});

	it('reports available-but-unused coverage', () => {
		expect(
			describeQuotaRemedy({ window: 'five_hour', status: 'allowed', overageStatus: 'allowed' })
		).toMatch(/available to cover/i);
	});

	it('says nothing rather than guessing when the payload supports no claim', () => {
		// A wrong reassurance here is worse than silence.
		expect(describeQuotaRemedy({ window: 'five_hour' })).toBeUndefined();
		expect(describeQuotaRemedy(undefined)).toBeUndefined();
	});
});
