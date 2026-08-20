/**
 * Tests for src/renderer/stores/aiCommandStore.ts
 *
 * The store's whole job is keeping a slow, uncancellable model round trip from
 * writing onto state the user has already moved past: a reply that lands after
 * a dismissal, or after a second request replaced the first.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
	aiCommandKey,
	getAiCommandEntry,
	useAiCommandStore,
} from '../../../renderer/stores/aiCommandStore';

const SESSION = 'session-1';
const TAB = 'tab-1';
const KEY = aiCommandKey(SESSION, TAB);

function begin(requestId = 'req-1', request = 'find big files', tabId = TAB) {
	useAiCommandStore.getState().beginAiCommand({ requestId, sessionId: SESSION, tabId, request });
}

beforeEach(() => {
	useAiCommandStore.setState({ entries: {} });
});

describe('aiCommandStore', () => {
	test('a new request starts thinking with Run preselected', () => {
		// The user asked for the command, so the common case is Enter-to-run.
		begin();
		const entry = useAiCommandStore.getState().entries[KEY];
		expect(entry.status).toBe('thinking');
		expect(entry.choice).toBe('run');
	});

	test('resolving moves it to a proposal', () => {
		begin();
		useAiCommandStore.getState().resolveAiCommand('req-1', 'du -sh *');
		expect(useAiCommandStore.getState().entries[KEY]).toMatchObject({
			status: 'proposed',
			command: 'du -sh *',
		});
	});

	test('a reply for a dismissed request is dropped', () => {
		// Escape must actually mean gone: without the request-id check the card
		// would pop back onto the screen seconds after the user closed it.
		begin();
		useAiCommandStore.getState().clearAiCommand(KEY);
		useAiCommandStore.getState().resolveAiCommand('req-1', 'du -sh *');
		expect(useAiCommandStore.getState().entries[KEY]).toBeUndefined();
	});

	test('a reply for a superseded request does not overwrite the current one', () => {
		begin('req-1', 'first ask');
		begin('req-2', 'second ask');
		useAiCommandStore.getState().resolveAiCommand('req-1', 'stale command');

		const entry = useAiCommandStore.getState().entries[KEY];
		expect(entry.requestId).toBe('req-2');
		expect(entry.status).toBe('thinking');
	});

	test('failure is recorded on the entry rather than clearing it', () => {
		begin();
		useAiCommandStore.getState().failAiCommand('req-1', 'nothing came back');
		expect(useAiCommandStore.getState().entries[KEY]).toMatchObject({
			status: 'error',
			error: 'nothing came back',
		});
	});

	test('entries are per tab, so a request in one tab does not touch another', () => {
		begin('req-1', 'first ask', TAB);
		begin('req-2', 'second ask', 'tab-2');

		expect(getAiCommandEntry(SESSION, TAB)?.request).toBe('first ask');
		expect(getAiCommandEntry(SESSION, 'tab-2')?.request).toBe('second ask');

		useAiCommandStore.getState().clearAiCommand(aiCommandKey(SESSION, 'tab-2'));
		expect(getAiCommandEntry(SESSION, TAB)).toBeDefined();
	});

	test('getAiCommandEntry tolerates missing ids', () => {
		expect(getAiCommandEntry(undefined, TAB)).toBeUndefined();
		expect(getAiCommandEntry(SESSION, undefined)).toBeUndefined();
	});
});
