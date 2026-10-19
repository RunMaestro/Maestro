/**
 * Tests for shared/tabWindowCommands - the `tab_window_command` wire shape
 * (Tab Windows, TW-12): request validation in main, result narrowing, and the
 * tab id resolver both main and the owner window use.
 */

import { describe, it, expect } from 'vitest';
import {
	isTabWindowCommandAction,
	normalizeTabWindowCommandResult,
	parseTabWindowCommandRequest,
	resolveTabIdInSessions,
} from '../../shared/tabWindowCommands';

describe('isTabWindowCommandAction', () => {
	it('accepts the three verbs only', () => {
		for (const action of ['pop-out', 'dock', 'list']) {
			expect(isTabWindowCommandAction(action), action).toBe(true);
		}
		expect(isTabWindowCommandAction('popout')).toBe(false);
		expect(isTabWindowCommandAction(undefined)).toBe(false);
	});
});

describe('parseTabWindowCommandRequest', () => {
	it('keeps only the action for list', () => {
		expect(parseTabWindowCommandRequest({ action: 'list', tabId: 'x', sessionId: 'a' })).toEqual({
			ok: true,
			request: { action: 'list' },
		});
	});

	it('trims the tab id and agent, and drops an empty agent', () => {
		expect(
			parseTabWindowCommandRequest({ action: 'dock', tabId: ' t1 ', sessionId: '  ' })
		).toEqual({ ok: true, request: { action: 'dock', tabId: 't1' } });
		expect(
			parseTabWindowCommandRequest({ action: 'dock', tabId: 't1', sessionId: ' a1 ' })
		).toEqual({ ok: true, request: { action: 'dock', tabId: 't1', sessionId: 'a1' } });
	});

	it('reads background on pop-out only, and only a literal true', () => {
		expect(
			parseTabWindowCommandRequest({ action: 'pop-out', tabId: 't', background: true })
		).toEqual({ ok: true, request: { action: 'pop-out', tabId: 't', background: true } });
		expect(parseTabWindowCommandRequest({ action: 'pop-out', tabId: 't', background: 1 })).toEqual({
			ok: true,
			request: { action: 'pop-out', tabId: 't', background: false },
		});
		expect(parseTabWindowCommandRequest({ action: 'dock', tabId: 't', background: true })).toEqual({
			ok: true,
			request: { action: 'dock', tabId: 't' },
		});
	});

	it('refuses a bad action and a missing tab id', () => {
		expect(parseTabWindowCommandRequest({ action: 'nope' }).ok).toBe(false);
		expect(parseTabWindowCommandRequest({ action: 'pop-out', tabId: ' ' })).toEqual({
			ok: false,
			error: 'tab pop-out requires a tab id',
		});
	});
});

describe('normalizeTabWindowCommandResult', () => {
	it('turns a malformed or failed answer into a failed command', () => {
		expect(normalizeTabWindowCommandResult(null)).toEqual({
			success: false,
			error: 'Invalid tab window response',
		});
		expect(normalizeTabWindowCommandResult({ success: 'yes' })).toEqual({
			success: false,
			error: 'Tab window command failed',
		});
		expect(normalizeTabWindowCommandResult({ success: false, error: 'nope' })).toEqual({
			success: false,
			error: 'nope',
		});
	});

	it('keeps well-formed fields and drops malformed ones', () => {
		expect(
			normalizeTabWindowCommandResult({
				success: true,
				agentId: 'a1',
				tabRef: { type: 'ai', id: 't1' },
				windowId: 'tw-1',
				created: true,
				tabRefs: [{ type: 'ai', id: 't1' }],
				extra: 'ignored',
			})
		).toEqual({
			success: true,
			agentId: 'a1',
			tabRef: { type: 'ai', id: 't1' },
			windowId: 'tw-1',
			created: true,
			tabRefs: [{ type: 'ai', id: 't1' }],
		});
		expect(
			normalizeTabWindowCommandResult({
				success: true,
				tabRef: { type: 'group', id: 'g' },
				tabRefs: [{ type: 'ai' }],
			})
		).toEqual({ success: true });
	});
});

describe('resolveTabIdInSessions', () => {
	const sessions = [
		{ id: 'a1', aiTabs: [{ id: 'abc-1' }], terminalTabs: [{ id: 'term-1' }] },
		{ id: 'a2', filePreviewTabs: [{ id: 'abc-12' }], browserTabs: [{ id: 'web-1' }] },
		null,
		{ name: 'no id', aiTabs: [{ id: 'web-2' }] },
	];

	it('finds a tab of every kind and names its agent', () => {
		expect(resolveTabIdInSessions(sessions, 'term-1')).toEqual({
			ok: true,
			resolved: { agentId: 'a1', tabRef: { type: 'terminal', id: 'term-1' } },
		});
		expect(resolveTabIdInSessions(sessions, 'web-1')).toEqual({
			ok: true,
			resolved: { agentId: 'a2', tabRef: { type: 'browser', id: 'web-1' } },
		});
	});

	it('prefers an exact id over a prefix it also is', () => {
		expect(resolveTabIdInSessions(sessions, 'abc-1')).toEqual({
			ok: true,
			resolved: { agentId: 'a1', tabRef: { type: 'ai', id: 'abc-1' } },
		});
	});

	it('resolves a unique prefix and refuses an ambiguous one', () => {
		expect(resolveTabIdInSessions(sessions, 'ter')).toEqual({
			ok: true,
			resolved: { agentId: 'a1', tabRef: { type: 'terminal', id: 'term-1' } },
		});
		expect(resolveTabIdInSessions(sessions, 'abc')).toEqual({
			ok: false,
			error: "Ambiguous tab ID 'abc' (2 matches)",
		});
	});

	it('skips malformed records and reports a miss', () => {
		expect(resolveTabIdInSessions(sessions, 'web-2')).toEqual({
			ok: false,
			error: 'Tab not found: web-2',
		});
	});
});
