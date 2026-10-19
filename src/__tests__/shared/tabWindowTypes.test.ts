/**
 * Tests for shared/tabWindowTypes - the wire contract between a tab window,
 * the main-process relay, and the owner app window.
 *
 * The relay checks every intent and patch envelope with these guards before it
 * forwards it. A guard that accepts a malformed message lets a tab window act
 * on a group ref or an empty agent id; one that rejects a valid kind silently
 * drops a user action (a Stop that never arrives).
 */

import { describe, it, expect } from 'vitest';
import {
	TAB_WINDOW_BROWSER_TAB_WRITE_BACK_FIELDS,
	TAB_WINDOW_CHANNELS,
	TAB_WINDOW_FILE_TAB_FIELDS,
	TAB_WINDOW_INTENT_KINDS,
	formatTabWindowTitle,
	isTabWindowBrowserTabField,
	isTabWindowBrowserTabWriteBackField,
	isTabWindowIntent,
	isTabWindowFileTabField,
	isTabWindowIntentKind,
	isTabWindowSessionPatch,
	type TabWindowIntent,
	type TabWindowIntentOf,
	type TabWindowSessionPatch,
} from '../../shared/tabWindowTypes';
import { isSameTabRef, isSingleTabRef } from '../../shared/unifiedTabRef';

const aiRef = { type: 'ai', id: 'tab-1' } as const;

describe('isSingleTabRef', () => {
	it('accepts each single-tab kind', () => {
		for (const type of ['ai', 'file', 'terminal', 'browser']) {
			expect(isSingleTabRef({ type, id: 'x' })).toBe(true);
		}
	});

	it('rejects a group ref, an unknown kind, and an empty or missing id', () => {
		expect(isSingleTabRef({ type: 'group', id: 'g' })).toBe(false);
		expect(isSingleTabRef({ type: 'chat', id: 'x' })).toBe(false);
		expect(isSingleTabRef({ type: 'ai', id: '' })).toBe(false);
		expect(isSingleTabRef({ type: 'ai' })).toBe(false);
		expect(isSingleTabRef(null)).toBe(false);
		expect(isSingleTabRef('ai:tab-1')).toBe(false);
	});
});

describe('isSameTabRef', () => {
	it('matches on both type and id', () => {
		expect(isSameTabRef(aiRef, { type: 'ai', id: 'tab-1' })).toBe(true);
		expect(isSameTabRef(aiRef, { type: 'file', id: 'tab-1' })).toBe(false);
		expect(isSameTabRef(aiRef, { type: 'ai', id: 'tab-2' })).toBe(false);
	});
});

describe('TAB_WINDOW_INTENT_KINDS', () => {
	it('lists each kind once', () => {
		expect(new Set(TAB_WINDOW_INTENT_KINDS).size).toBe(TAB_WINDOW_INTENT_KINDS.length);
	});

	it('covers the actions a popped AI tab must reach (TW-7)', () => {
		for (const kind of ['send', 'interrupt', 'setDraft', 'setModel', 'setEffort', 'closeTab']) {
			expect(TAB_WINDOW_INTENT_KINDS).toContain(kind);
		}
	});

	it('lets a tab window ask for a fresh snapshot (D2)', () => {
		expect(TAB_WINDOW_INTENT_KINDS).toContain('requestSnapshot');
	});

	it('lets a tab window write a popped file tab back (D5)', () => {
		expect(TAB_WINDOW_INTENT_KINDS).toContain('setFileTabState');
	});

	it('lets a tab window write a popped browser tab back (D5)', () => {
		expect(TAB_WINDOW_INTENT_KINDS).toContain('setBrowserTabState');
	});

	it('is frozen', () => {
		expect(Object.isFrozen(TAB_WINDOW_INTENT_KINDS)).toBe(true);
	});
});

describe('isTabWindowFileTabField', () => {
	it('names the file tab fields a tab window owns while the tab is popped out (D5)', () => {
		for (const field of ['editContent', 'editMode', 'scrollTop', 'content', 'path']) {
			expect(isTabWindowFileTabField(field)).toBe(true);
		}
		expect(TAB_WINDOW_FILE_TAB_FIELDS.every(isTabWindowFileTabField)).toBe(true);
		expect(Object.isFrozen(TAB_WINDOW_FILE_TAB_FIELDS)).toBe(true);
	});

	it('leaves out what the owner keeps writing: identity, name, loading state', () => {
		for (const field of ['id', 'customName', 'isLoading', 'sshRemoteId', 'toString']) {
			expect(isTabWindowFileTabField(field)).toBe(false);
		}
	});
});

describe('isTabWindowBrowserTabField', () => {
	it('names what the tab window webview reports while the tab is popped out (D5)', () => {
		for (const field of [
			'url',
			'title',
			'favicon',
			'canGoBack',
			'canGoForward',
			'isLoading',
			'webContentsId',
			'remotePage',
		]) {
			expect(isTabWindowBrowserTabField(field)).toBe(true);
		}
	});

	it('leaves out what the owner keeps writing: identity, rename, partition, visibility', () => {
		for (const field of ['id', 'customTitle', 'partition', 'hiddenFromAgent', 'toString']) {
			expect(isTabWindowBrowserTabField(field)).toBe(false);
		}
	});
});

describe('isTabWindowBrowserTabWriteBackField', () => {
	it('writes back the page and the agent visibility toggle, never the guest state', () => {
		expect([...TAB_WINDOW_BROWSER_TAB_WRITE_BACK_FIELDS].sort()).toEqual(
			['favicon', 'hiddenFromAgent', 'title', 'url'].sort()
		);
		expect(
			TAB_WINDOW_BROWSER_TAB_WRITE_BACK_FIELDS.every(isTabWindowBrowserTabWriteBackField)
		).toBe(true);
		for (const field of ['canGoBack', 'webContentsId', 'remotePage', 'partition', 'toString']) {
			expect(isTabWindowBrowserTabWriteBackField(field)).toBe(false);
		}
		expect(Object.isFrozen(TAB_WINDOW_BROWSER_TAB_WRITE_BACK_FIELDS)).toBe(true);
	});
});

describe('isTabWindowIntentKind', () => {
	it('accepts every listed kind and nothing else', () => {
		for (const kind of TAB_WINDOW_INTENT_KINDS) expect(isTabWindowIntentKind(kind)).toBe(true);
		expect(isTabWindowIntentKind('dropDatabase')).toBe(false);
		expect(isTabWindowIntentKind('toString')).toBe(false);
		expect(isTabWindowIntentKind(undefined)).toBe(false);
	});
});

describe('isTabWindowIntent', () => {
	it('accepts a well-formed intent', () => {
		const intent: TabWindowIntent = {
			kind: 'send',
			agentId: 'agent-1',
			tabRef: aiRef,
			text: 'hello',
			commandMode: 'off',
		};
		expect(isTabWindowIntent(intent)).toBe(true);
	});

	it('accepts an intent with no payload', () => {
		const intent: TabWindowIntentOf<'interrupt'> = {
			kind: 'interrupt',
			agentId: 'agent-1',
			tabRef: aiRef,
		};
		expect(isTabWindowIntent(intent)).toBe(true);
	});

	it('rejects an unknown kind', () => {
		expect(isTabWindowIntent({ kind: 'nope', agentId: 'agent-1', tabRef: aiRef })).toBe(false);
	});

	it('rejects a missing or empty agent id', () => {
		expect(isTabWindowIntent({ kind: 'interrupt', tabRef: aiRef })).toBe(false);
		expect(isTabWindowIntent({ kind: 'interrupt', agentId: '', tabRef: aiRef })).toBe(false);
	});

	it('rejects a group ref or a missing tab ref', () => {
		expect(
			isTabWindowIntent({ kind: 'interrupt', agentId: 'a', tabRef: { type: 'group', id: 'g' } })
		).toBe(false);
		expect(isTabWindowIntent({ kind: 'interrupt', agentId: 'a' })).toBe(false);
	});

	it('rejects non-objects', () => {
		expect(isTabWindowIntent(null)).toBe(false);
		expect(isTabWindowIntent('send')).toBe(false);
	});
});

describe('isTabWindowSessionPatch', () => {
	it('accepts a snapshot and a delta', () => {
		const snapshot: TabWindowSessionPatch = {
			form: 'snapshot',
			agentId: 'agent-1',
			seq: 0,
			tabRefs: [aiRef],
			session: { id: 'agent-1' },
		};
		const delta: TabWindowSessionPatch = {
			form: 'delta',
			agentId: 'agent-1',
			seq: 1,
			tabs: [{ ref: aiRef, logSplice: { start: 0, entries: [] } }],
		};
		expect(isTabWindowSessionPatch(snapshot)).toBe(true);
		expect(isTabWindowSessionPatch(delta)).toBe(true);
	});

	it('rejects a snapshot without a session object', () => {
		const base = { form: 'snapshot', agentId: 'a', seq: 0, tabRefs: [aiRef] };
		expect(isTabWindowSessionPatch(base)).toBe(false);
		expect(isTabWindowSessionPatch({ ...base, session: null })).toBe(false);
	});

	it('rejects a snapshot without its popped refs, or of another agent than it names', () => {
		const base = { form: 'snapshot', agentId: 'a', seq: 0, session: { id: 'a' } };
		expect(isTabWindowSessionPatch(base)).toBe(false);
		expect(isTabWindowSessionPatch({ ...base, tabRefs: [{ type: 'group', id: 'g' }] })).toBe(false);
		expect(isTabWindowSessionPatch({ ...base, tabRefs: [], session: { id: 'b' } })).toBe(false);
		expect(isTabWindowSessionPatch({ ...base, tabRefs: [] })).toBe(true);
	});

	it('rejects a bad sequence number', () => {
		for (const seq of [-1, 1.5, '1', undefined]) {
			expect(isTabWindowSessionPatch({ form: 'delta', agentId: 'a', seq })).toBe(false);
		}
	});

	it('rejects an unknown form or a missing agent id', () => {
		expect(isTabWindowSessionPatch({ form: 'full', agentId: 'a', seq: 0 })).toBe(false);
		expect(isTabWindowSessionPatch({ form: 'delta', agentId: '', seq: 0 })).toBe(false);
		expect(isTabWindowSessionPatch(null)).toBe(false);
	});
});

describe('TAB_WINDOW_CHANNELS', () => {
	it('uses distinct channel names', () => {
		const names = Object.values(TAB_WINDOW_CHANNELS);
		expect(new Set(names).size).toBe(names.length);
	});

	it('keeps the relay channels on the tabWindow: prefix and the registry verbs on tabWindows:', () => {
		expect(TAB_WINDOW_CHANNELS.sessionPatch).toBe('tabWindow:sessionPatch');
		expect(TAB_WINDOW_CHANNELS.intent).toBe('tabWindow:intent');
		expect(TAB_WINDOW_CHANNELS.popOut).toBe('tabWindows:popOut');
	});
});

describe('formatTabWindowTitle (TW-3)', () => {
	it('puts the agent name before the suffix', () => {
		expect(formatTabWindowTitle('Maestro Marketing')).toBe('Maestro Marketing - Tab Window');
	});

	it('trims the name', () => {
		expect(formatTabWindowTitle('  Docs  ')).toBe('Docs - Tab Window');
	});

	it('falls back to the bare suffix before the agent name is known', () => {
		expect(formatTabWindowTitle(undefined)).toBe('Tab Window');
		expect(formatTabWindowTitle(null)).toBe('Tab Window');
		expect(formatTabWindowTitle('   ')).toBe('Tab Window');
	});
});
