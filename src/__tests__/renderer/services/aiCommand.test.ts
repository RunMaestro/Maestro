/**
 * Tests for the AI command mode request/confirm/run cycle.
 *
 * The service owns three promises the rest of the feature relies on: the
 * suggestion runs under the settings codified at request time, an accepted
 * command goes through the SAME entry point a typed `!` command uses, and a
 * reply that lands after the user walked away never resurrects a dismissed
 * card.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import {
	requestAiCommand,
	acceptAiCommand,
	dismissAiCommand,
} from '../../../renderer/services/aiCommand';
import {
	aiCommandKey,
	useAiCommandStore,
	type AiCommandEntry,
} from '../../../renderer/stores/aiCommandStore';
import { dispatchShellCommand } from '../../../renderer/services/shellCommand';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { Session } from '../../../renderer/types';

vi.mock('../../../renderer/services/shellCommand', () => ({
	dispatchShellCommand: vi.fn().mockResolvedValue(undefined),
	resolveCommandCwd: vi.fn(() => '/repo'),
}));

vi.mock('../../../renderer/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockDispatch = dispatchShellCommand as unknown as Mock;

const SESSION_ID = 'agent-1';
const TAB_ID = 'tab-1';
const KEY = aiCommandKey(SESSION_ID, TAB_ID);

function makeSession(overrides: Partial<Session> = {}): Session {
	return createMockSession({
		id: SESSION_ID,
		cwd: '/repo',
		activeTabId: TAB_ID,
		customModel: 'agent-model',
		customEffort: 'medium',
		aiTabs: [createMockAITab({ id: TAB_ID })],
		...overrides,
	});
}

function entryNow(): AiCommandEntry | undefined {
	return useAiCommandStore.getState().entries[KEY];
}

let suggest: Mock;

beforeEach(() => {
	vi.clearAllMocks();
	useAiCommandStore.setState({ entries: {} });
	suggest = vi.fn().mockResolvedValue({ success: true, command: 'du -sh *' });
	(window as unknown as { maestro: unknown }).maestro = { aiCommand: { suggest } };
});

describe('requestAiCommand', () => {
	it('parks a thinking entry immediately, then resolves it with the proposal', async () => {
		const pending = requestAiCommand({
			session: makeSession(),
			tabId: TAB_ID,
			request: 'how big is everything here',
		});

		expect(entryNow()?.status).toBe('thinking');
		expect(entryNow()?.request).toBe('how big is everything here');

		await pending;

		expect(entryNow()?.status).toBe('proposed');
		expect(entryNow()?.command).toBe('du -sh *');
		// Run is highlighted by default, so Enter takes the command.
		expect(entryNow()?.choice).toBe('run');
	});

	it('codifies the tab override, not the agent default, at request time', async () => {
		const session = makeSession({
			aiTabs: [createMockAITab({ id: TAB_ID, customModel: 'tab-model', customEffort: 'high' })],
		});

		await requestAiCommand({ session, tabId: TAB_ID, request: 'list files' });

		expect(suggest).toHaveBeenCalledWith(
			expect.objectContaining({
				agentType: 'claude-code',
				cwd: '/repo',
				customModel: 'tab-model',
				customEffort: 'high',
			})
		);
		expect(entryNow()?.model).toBe('tab-model');
		expect(entryNow()?.effort).toBe('high');
	});

	it('falls back to the agent model and effort when the tab has no override', async () => {
		await requestAiCommand({ session: makeSession(), tabId: TAB_ID, request: 'list files' });

		expect(suggest).toHaveBeenCalledWith(
			expect.objectContaining({ customModel: 'agent-model', customEffort: 'medium' })
		);
	});

	it('records a failed suggestion as an error the card can show', async () => {
		suggest.mockResolvedValue({ success: false, error: 'agent timed out' });

		await requestAiCommand({ session: makeSession(), tabId: TAB_ID, request: 'list files' });

		expect(entryNow()?.status).toBe('error');
		expect(entryNow()?.error).toBe('agent timed out');
	});

	it('records a thrown IPC failure as an error rather than leaving the spinner up', async () => {
		suggest.mockRejectedValue(new Error('bridge gone'));

		await requestAiCommand({ session: makeSession(), tabId: TAB_ID, request: 'list files' });

		expect(entryNow()?.status).toBe('error');
		expect(entryNow()?.error).toBe('bridge gone');
	});

	it('drops a reply that lands after the user dismissed the request', async () => {
		let release: (value: { success: boolean; command: string }) => void = () => {};
		suggest.mockReturnValue(
			new Promise<{ success: boolean; command: string }>((resolve) => {
				release = resolve;
			})
		);

		const pending = requestAiCommand({
			session: makeSession(),
			tabId: TAB_ID,
			request: 'list files',
		});
		// The user gives up while the model is still thinking.
		useAiCommandStore.getState().clearAiCommand(KEY);
		release({ success: true, command: 'ls -la' });
		await pending;

		// The card stays closed - a late reply must not pop it back open.
		expect(entryNow()).toBeUndefined();
	});

	it('drops a reply from a request the user already replaced', async () => {
		let releaseFirst: (value: { success: boolean; command: string }) => void = () => {};
		suggest.mockReturnValueOnce(
			new Promise<{ success: boolean; command: string }>((resolve) => {
				releaseFirst = resolve;
			})
		);
		suggest.mockResolvedValueOnce({ success: true, command: 'second' });

		const first = requestAiCommand({
			session: makeSession(),
			tabId: TAB_ID,
			request: 'first request',
		});
		await requestAiCommand({ session: makeSession(), tabId: TAB_ID, request: 'second request' });
		releaseFirst({ success: true, command: 'first' });
		await first;

		expect(entryNow()?.command).toBe('second');
		expect(entryNow()?.request).toBe('second request');
	});
});

describe('acceptAiCommand', () => {
	it('runs the proposal through the shared command-mode entry point and clears the card', () => {
		const session = makeSession();
		useAiCommandStore.setState({
			entries: {
				[KEY]: {
					requestId: 'r1',
					sessionId: SESSION_ID,
					tabId: TAB_ID,
					request: 'how big is everything',
					status: 'proposed',
					command: 'du -sh *',
					choice: 'run',
					startedAt: 0,
				},
			},
		});

		acceptAiCommand(session, entryNow()!);

		// The SAME dispatch a typed `!` command uses, so the run is indistinguishable.
		expect(mockDispatch).toHaveBeenCalledWith({
			session,
			tabId: TAB_ID,
			command: 'du -sh *',
		});
		expect(entryNow()).toBeUndefined();
	});

	it('does nothing while the suggestion is still thinking', () => {
		const entry: AiCommandEntry = {
			requestId: 'r1',
			sessionId: SESSION_ID,
			tabId: TAB_ID,
			request: 'list files',
			status: 'thinking',
			choice: 'run',
			startedAt: 0,
		};
		useAiCommandStore.setState({ entries: { [KEY]: entry } });

		acceptAiCommand(makeSession(), entry);

		expect(mockDispatch).not.toHaveBeenCalled();
		expect(entryNow()).toBeDefined();
	});
});

describe('dismissAiCommand', () => {
	it('clears the card and hands the original request back for editing', () => {
		const entry: AiCommandEntry = {
			requestId: 'r1',
			sessionId: SESSION_ID,
			tabId: TAB_ID,
			request: 'how big is everything here',
			status: 'proposed',
			command: 'du -sh *',
			choice: 'run',
			startedAt: 0,
		};
		useAiCommandStore.setState({ entries: { [KEY]: entry } });

		const returned = dismissAiCommand(entry);

		expect(returned).toBe('how big is everything here');
		expect(entryNow()).toBeUndefined();
		expect(mockDispatch).not.toHaveBeenCalled();
	});
});
