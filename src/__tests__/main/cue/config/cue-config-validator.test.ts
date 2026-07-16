/**
 * Unit tests for `validateSubscription` - focused on the `time.once` event
 * type and the `notify` action added in Phase 01.
 *
 * Mirrors the table-driven style used elsewhere in the cue test suite:
 * a small `base` subscription literal per `describe`, then per-`it` overrides
 * that flip a single field and assert which error message(s) surface.
 */

import { describe, it, expect } from 'vitest';

import { validateSubscription } from '../../../../main/cue/config/cue-config-validator';

function errs(sub: unknown): string[] {
	return validateSubscription(sub, 'sub');
}

// ────────────────────────────────────────────────────────────────────────────
// time.once event validation
// ────────────────────────────────────────────────────────────────────────────

describe('validateSubscription - time.once', () => {
	const base = {
		name: 'task-1',
		event: 'time.once',
		action: 'notify' as const,
		notify: { message: 'reminder' },
		agent_id: 'agent-xyz',
		fire_at: '2026-05-22T14:30:00-05:00',
	};

	it('accepts a fully valid time.once notify subscription', () => {
		expect(errs(base)).toEqual([]);
	});

	it('accepts fire_at with Z (UTC) suffix', () => {
		expect(errs({ ...base, fire_at: '2026-05-22T14:30:00Z' })).toEqual([]);
	});

	it('accepts fire_at with +HHMM offset (no colon)', () => {
		expect(errs({ ...base, fire_at: '2026-05-22T14:30:00+0500' })).toEqual([]);
	});

	it('rejects missing fire_at', () => {
		const { fire_at, ...rest } = base;
		const found = errs(rest);
		expect(
			found.some((e) =>
				/fire_at is required for time\.once events and must be an ISO-8601 timestamp with timezone/.test(
					e
				)
			)
		).toBe(true);
	});

	it('rejects empty-string fire_at', () => {
		const found = errs({ ...base, fire_at: '' });
		expect(
			found.some((e) =>
				/fire_at is required for time\.once events and must be an ISO-8601 timestamp with timezone/.test(
					e
				)
			)
		).toBe(true);
	});

	it('rejects unparseable fire_at', () => {
		const found = errs({ ...base, fire_at: 'not-a-date' });
		expect(
			found.some((e) =>
				/fire_at is required for time\.once events and must be an ISO-8601 timestamp with timezone/.test(
					e
				)
			)
		).toBe(true);
	});

	it('rejects a non-canonical fire_at (space instead of T) that Date.parse may accept', () => {
		const found = errs({ ...base, fire_at: '2026-05-22 14:30:00-05:00' });
		expect(
			found.some((e) =>
				/fire_at is required for time\.once events and must be an ISO-8601 timestamp with timezone/.test(
					e
				)
			)
		).toBe(true);
	});

	it('rejects fire_at without a timezone offset (naive local time)', () => {
		const found = errs({ ...base, fire_at: '2026-05-22T14:30:00' });
		expect(
			found.some((e) => /fire_at must include a timezone offset \(Z, ±HH:MM, or ±HHMM\)/.test(e))
		).toBe(true);
	});

	it('rejects non-integer grace_minutes', () => {
		const found = errs({ ...base, grace_minutes: 10.5 });
		expect(
			found.some((e) =>
				/"grace_minutes" must be a non-negative integer no greater than 10080/.test(e)
			)
		).toBe(true);
	});

	it('rejects negative grace_minutes', () => {
		const found = errs({ ...base, grace_minutes: -1 });
		expect(
			found.some((e) =>
				/"grace_minutes" must be a non-negative integer no greater than 10080/.test(e)
			)
		).toBe(true);
	});

	it('rejects grace_minutes above the 7-day cap', () => {
		const found = errs({ ...base, grace_minutes: 10081 });
		expect(
			found.some((e) =>
				/"grace_minutes" must be a non-negative integer no greater than 10080/.test(e)
			)
		).toBe(true);
	});

	it('accepts grace_minutes of 0 (disable missed-fire rescue)', () => {
		expect(errs({ ...base, grace_minutes: 0 })).toEqual([]);
	});

	it('accepts grace_minutes at the 7-day cap', () => {
		expect(errs({ ...base, grace_minutes: 10080 })).toEqual([]);
	});

	it('rejects non-boolean self_destruct_on_failure', () => {
		const found = errs({ ...base, self_destruct_on_failure: 'yes' });
		expect(
			found.some((e) =>
				/"self_destruct_on_failure" must be a boolean when provided for time\.once events/.test(e)
			)
		).toBe(true);
	});

	it('accepts self_destruct_on_failure: false', () => {
		expect(errs({ ...base, self_destruct_on_failure: false })).toEqual([]);
	});

	it('rejects missing agent_id', () => {
		const { agent_id, ...rest } = base;
		const found = errs(rest);
		expect(
			found.some((e) =>
				/"agent_id" is required and must be a non-empty string for time\.once events/.test(e)
			)
		).toBe(true);
	});

	it('rejects whitespace-only agent_id', () => {
		const found = errs({ ...base, agent_id: '   ' });
		expect(
			found.some((e) =>
				/"agent_id" is required and must be a non-empty string for time\.once events/.test(e)
			)
		).toBe(true);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// action: 'notify' validation
// ────────────────────────────────────────────────────────────────────────────

describe('validateSubscription - action: notify', () => {
	const base = {
		name: 'notify-1',
		event: 'time.once',
		action: 'notify' as const,
		notify: { message: 'hi' },
		agent_id: 'agent-xyz',
		fire_at: '2026-05-22T14:30:00-05:00',
	};

	it('accepts action: notify even without a prompt field', () => {
		// `prompt` is intentionally absent - notify never reads it.
		expect(errs(base)).toEqual([]);
	});

	it('rejects action: notify without a notify object', () => {
		const { notify, ...rest } = base;
		const found = errs(rest);
		expect(
			found.some((e) =>
				/"notify" is required and must be an object when action is "notify"/.test(e)
			)
		).toBe(true);
	});

	it('rejects notify object with non-string message', () => {
		const found = errs({ ...base, notify: { message: 42 } });
		expect(found.some((e) => /"notify\.message" must be a string when provided/.test(e))).toBe(
			true
		);
	});

	it('rejects notify object with non-boolean sticky', () => {
		const found = errs({ ...base, notify: { message: 'hi', sticky: 'true' } });
		expect(found.some((e) => /"notify\.sticky" must be a boolean when provided/.test(e))).toBe(
			true
		);
	});

	it('accepts notify with empty {} (message falls back at runtime)', () => {
		expect(errs({ ...base, notify: {} })).toEqual([]);
	});

	it('accepts notify with sticky: true', () => {
		expect(errs({ ...base, notify: { message: 'hi', sticky: true } })).toEqual([]);
	});

	it('rejects command field when action is notify', () => {
		const found = errs({
			...base,
			command: { mode: 'shell', shell: 'echo hi' },
		});
		expect(found.some((e) => /"command" is not supported when action is "notify"/.test(e))).toBe(
			true
		);
	});

	it('rejects fan_out when action is notify', () => {
		const found = errs({ ...base, fan_out: ['Agent A', 'Agent B'] });
		expect(found.some((e) => /"fan_out" is not supported when action is "notify"/.test(e))).toBe(
			true
		);
	});

	it('rejects missing agent_id for notify (overrides default looseness)', () => {
		const { agent_id, ...rest } = base;
		const found = errs(rest);
		expect(
			found.some((e) =>
				/"agent_id" is required and must be a non-empty string when action is "notify"/.test(e)
			)
		).toBe(true);
	});

	it('rejects unknown action values', () => {
		const found = errs({ ...base, action: 'explode' });
		expect(
			found.some((e) => /"action" must be "prompt", "command", or "notify" when provided/.test(e))
		).toBe(true);
	});
});
