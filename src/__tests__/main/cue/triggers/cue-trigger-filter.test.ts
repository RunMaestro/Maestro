/**
 * Tests for the centralized passesFilter helper.
 *
 * Pinning down the filter contract here keeps the 6+ trigger-source callsites
 * honest: any future change to filter semantics is one edit + a test update,
 * not a hunt through the codebase.
 */

import { describe, it, expect, vi } from 'vitest';
import { passesFilter } from '../../../../main/cue/triggers/cue-trigger-filter';
import type { CueEvent, CueSubscription } from '../../../../main/cue/cue-types';

function makeSub(filter?: Record<string, string | number | boolean>): CueSubscription {
	return {
		name: 'test-sub',
		event: 'time.heartbeat',
		enabled: true,
		prompt: 'do work',
		interval_minutes: 5,
		filter,
	};
}

function makeEvent(payload: Record<string, unknown>): CueEvent {
	return {
		id: 'event-1',
		type: 'time.heartbeat',
		timestamp: '2026-03-01T00:00:00.000Z',
		triggerName: 'test-sub',
		payload,
	};
}

describe('passesFilter', () => {
	it('returns true when subscription has no filter', () => {
		const onLog = vi.fn();
		expect(passesFilter(makeSub(), makeEvent({ foo: 'bar' }), onLog)).toBe(true);
		expect(onLog).not.toHaveBeenCalled();
	});

	it('returns true when filter matches event payload', () => {
		const onLog = vi.fn();
		const sub = makeSub({ kind: 'tick' });
		expect(passesFilter(sub, makeEvent({ kind: 'tick' }), onLog)).toBe(true);
		expect(onLog).not.toHaveBeenCalled();
	});

	it('returns false and logs when filter does not match', () => {
		const onLog = vi.fn();
		const sub = makeSub({ kind: 'tick' });
		expect(passesFilter(sub, makeEvent({ kind: 'other' }), onLog)).toBe(false);
		expect(onLog).toHaveBeenCalledWith('cue', expect.stringContaining('filter not matched'));
		expect(onLog).toHaveBeenCalledWith('cue', expect.stringContaining('test-sub'));
	});

	it('returns false when payload is missing the filter key', () => {
		const onLog = vi.fn();
		const sub = makeSub({ kind: 'tick' });
		expect(passesFilter(sub, makeEvent({ other: 'value' }), onLog)).toBe(false);
		expect(onLog).toHaveBeenCalledOnce();
	});

	it('handles numeric and boolean filter values', () => {
		const onLog = vi.fn();
		const sub = makeSub({ count: 3, enabled: true });
		expect(passesFilter(sub, makeEvent({ count: 3, enabled: true }), onLog)).toBe(true);
		expect(passesFilter(sub, makeEvent({ count: 4, enabled: true }), onLog)).toBe(false);
		expect(passesFilter(sub, makeEvent({ count: 3, enabled: false }), onLog)).toBe(false);
	});
});
