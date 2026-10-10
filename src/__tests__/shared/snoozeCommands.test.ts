/**
 * Tests for shared/snoozeCommands - the wire contract behind `maestro-cli
 * snooze`.
 *
 * Two failures this file exists to catch, both silent:
 *
 *  - A write that reaches the renderer without a `wakeAt` parks a tab at an
 *    instant that never comes due and never reads as overdue, so the tab is
 *    simply gone with no row anywhere to bring it back.
 *  - A reply that is not a result at all being read as a success, so the CLI
 *    reports a snooze that never happened.
 */

import { describe, it, expect } from 'vitest';
import {
	SNOOZE_COMMAND_ACTIONS,
	isSnoozeCommandAction,
	normalizeSnoozeCommandResult,
	parseSnoozeCommandRequest,
} from '../../shared/snoozeCommands';

describe('parseSnoozeCommandRequest', () => {
	it('rejects an unknown or missing action', () => {
		expect(parseSnoozeCommandRequest({})).toEqual({
			ok: false,
			error: expect.stringContaining('Invalid or missing snooze action'),
		});
		expect(parseSnoozeCommandRequest({ action: 'nap' }).ok).toBe(false);
	});

	it('accepts every action it advertises', () => {
		// The list is what the error message offers the caller, so a verb missing
		// from it is a verb the CLI can send and nothing will run.
		for (const action of SNOOZE_COMMAND_ACTIONS) {
			expect(isSnoozeCommandAction(action), action).toBe(true);
		}
	});

	it('requires both ids on every write', () => {
		for (const action of ['snooze', 'wake', 'dismiss', 'reschedule']) {
			expect(parseSnoozeCommandRequest({ action, targetId: 't1' }).ok, action).toBe(false);
			expect(parseSnoozeCommandRequest({ action, sessionId: 's1' }).ok, action).toBe(false);
		}
	});

	it('requires a numeric wakeAt on snooze and reschedule', () => {
		// The failure being blocked: a tab parked at NaN is invisible AND never
		// due, so it cannot be found or restored from any surface.
		const base = { sessionId: 's1', targetId: 't1' };
		expect(parseSnoozeCommandRequest({ ...base, action: 'snooze' }).ok).toBe(false);
		expect(parseSnoozeCommandRequest({ ...base, action: 'snooze', wakeAt: 'tomorrow' }).ok).toBe(
			false
		);
		expect(parseSnoozeCommandRequest({ ...base, action: 'reschedule', wakeAt: NaN }).ok).toBe(
			false
		);
		const ok = parseSnoozeCommandRequest({ ...base, action: 'snooze', wakeAt: 1_800_000_000_500 });
		expect(ok).toEqual({
			ok: true,
			request: { action: 'snooze', sessionId: 's1', targetId: 't1', wakeAt: 1_800_000_000_500 },
		});
	});

	it('does not ask a read for an agent', () => {
		expect(parseSnoozeCommandRequest({ action: 'list' })).toEqual({
			ok: true,
			request: { action: 'list' },
		});
		expect(parseSnoozeCommandRequest({ action: 'history', limit: 5 })).toEqual({
			ok: true,
			request: { action: 'history', limit: 5 },
		});
	});

	it('keeps an empty note, because empty is the way a note is cleared', () => {
		// An absent field means "leave it alone" on a reschedule and an empty one
		// means "clear it". Collapsing the two would make the note unclearable.
		const parsed = parseSnoozeCommandRequest({
			action: 'reschedule',
			sessionId: 's1',
			targetId: 'sn1',
			wakeAt: 1_800_000_000_000,
			note: '',
		});
		expect(parsed.ok && parsed.request.note).toBe('');
		const untouched = parseSnoozeCommandRequest({
			action: 'reschedule',
			sessionId: 's1',
			targetId: 'sn1',
			wakeAt: 1_800_000_000_000,
		});
		expect(untouched.ok && 'note' in untouched.request).toBe(false);
	});

	it('treats background as an opt-in, never as an absent-means-true', () => {
		const args = { action: 'snooze', sessionId: 's1', targetId: 't1', wakeAt: 1_800_000_000_000 };
		const absent = parseSnoozeCommandRequest({ ...args });
		expect(absent.ok && 'background' in absent.request).toBe(false);
		for (const value of [false, 'true', 1, null]) {
			const parsed = parseSnoozeCommandRequest({ ...args, background: value });
			expect(parsed.ok && parsed.request.background, String(value)).toBeUndefined();
		}
		const opted = parseSnoozeCommandRequest({ ...args, background: true });
		expect(opted.ok && opted.request.background).toBe(true);
	});

	it('trims ids so a shell-quoted argument still resolves', () => {
		const parsed = parseSnoozeCommandRequest({
			action: 'wake',
			sessionId: ' s1 ',
			targetId: ' sn1 ',
		});
		expect(parsed.ok && parsed.request).toMatchObject({ sessionId: 's1', targetId: 'sn1' });
	});
});

describe('normalizeSnoozeCommandResult', () => {
	it('turns a non-result into a failure rather than a silent success', () => {
		// The reply crosses IPC from a renderer that can be a different build, and
		// `success: undefined` read as done reports a snooze that never happened.
		for (const raw of [null, undefined, 'ok', 42, {}, { success: 'yes' }]) {
			expect(normalizeSnoozeCommandResult(raw).success, String(raw)).toBe(false);
		}
	});

	it('keeps the failure message the renderer supplied', () => {
		expect(normalizeSnoozeCommandResult({ success: false, error: 'No snooze with id x' })).toEqual({
			success: false,
			error: 'No snooze with id x',
		});
	});

	it('passes a well-formed success through with its payload', () => {
		const snooze = {
			snoozeId: 'sn1',
			agentId: 'a1',
			agentName: 'Agent',
			type: 'ai' as const,
			label: 'Tab',
			tabId: 't1',
			snoozedAt: 1,
			wakeAt: 2,
		};
		expect(
			normalizeSnoozeCommandResult({ success: true, snooze, tabId: 't1', wasDuplicate: true })
		).toEqual({ success: true, snooze, tabId: 't1', wasDuplicate: true });
	});

	it('drops a wasDuplicate that is not literally true', () => {
		const result = normalizeSnoozeCommandResult({ success: true, wasDuplicate: 'yes' });
		expect(result.wasDuplicate).toBeUndefined();
	});
});
