/**
 * Automatic context compaction - the full recovery, against the real stores.
 *
 * The claim under test is the one a user cares about: a turn refused because
 * the conversation no longer fits the model is compacted and resent without
 * them ever seeing the failure, and a compaction that cannot land hands the
 * original error back unchanged.
 *
 * It drives the same call order the app does: the error listener schedules, the
 * exit listener starts the work (`noteFailedTurnExited`), and the resend's own
 * exit settles it (`clearRetryIfSettled`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	scheduleRetryForError,
	noteDispatch,
	noteFailedTurnExited,
	clearRetryIfSettled,
	cancelContextCompaction,
	cancelRecoveryForTab,
	hasPendingRetry,
	isAwaitingContextCompaction,
	getRetryEntry,
	registerAgentErrorSurfacer,
	useRetryStore,
} from '../../../renderer/stores/retryStore';
import {
	registerContextCompactionSpawner,
	type HiddenTurnSpawner,
} from '../../../renderer/services/contextCompaction';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useAgentStore, type ProcessQueuedItemDeps } from '../../../renderer/stores/agentStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { AgentError, LogEntry, QueuedItem, Session } from '../../../renderer/types';

const NOW = 1_700_000_000_000;
const SESSION = 's-compact';
const TAB = 'tab-1';
const PROVIDER_SESSION = 'claude-session-1';

const deps = {} as unknown as ProcessQueuedItemDeps;

function contextLimitError(): AgentError {
	return {
		type: 'token_exhaustion',
		message: 'Prompt is too long. Try a shorter message or start a new session.',
		recoverable: true,
		timestamp: NOW,
		agentId: 'claude-code',
	} as AgentError;
}

function queuedItem(id: string, text: string): QueuedItem {
	return { id, timestamp: NOW, tabId: TAB, type: 'message', text };
}

function session(): Session {
	return useSessionStore.getState().sessions.find((s) => s.id === SESSION)!;
}

function tab() {
	return session().aiTabs.find((t) => t.id === TAB)!;
}

function pill(): NonNullable<LogEntry['contextCompaction']> | undefined {
	return tab().logs.find((log) => log.contextCompaction)?.contextCompaction;
}

/** Lets the caller decide when, and how, the hidden compaction turn ends. */
function deferredCompaction() {
	let finish!: (result: { success: boolean; error?: string }) => void;
	const spawner = vi.fn<HiddenTurnSpawner>(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			})
	);
	registerContextCompactionSpawner(spawner);
	return { spawner, finish: (result: { success: boolean; error?: string }) => finish(result) };
}

let processQueuedItem: ReturnType<typeof vi.fn>;
let dispatched: string[];
let surfaced: ReturnType<typeof vi.fn<(processSessionId: string, error: AgentError) => void>>;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	useRetryStore.setState({ retries: {}, outages: {} });
	useSessionStore.setState({
		sessions: [
			createMockSession({
				id: SESSION,
				toolType: 'claude-code',
				aiTabs: [createMockAITab({ id: TAB, agentSessionId: PROVIDER_SESSION })],
				activeTabId: TAB,
			}),
		],
	} as never);
	dispatched = [];
	processQueuedItem = vi.fn(async (sessionId: string, item: QueuedItem) => {
		dispatched.push(item.text!);
		noteDispatch(sessionId, item, deps);
		return true;
	});
	useAgentStore.setState({ processQueuedItem } as never);
	surfaced = vi.fn<(processSessionId: string, error: AgentError) => void>();
	registerAgentErrorSurfacer(surfaced);
});

afterEach(() => {
	registerContextCompactionSpawner(null);
	registerAgentErrorSurfacer(null);
	vi.clearAllTimers();
	vi.useRealTimers();
});

/** The user's turn goes out and is refused on the context limit. */
function failOnContextLimit(text = 'how are we looking?'): boolean {
	noteDispatch(SESSION, queuedItem('turn-1', text), deps);
	return scheduleRetryForError(SESSION, TAB, contextLimitError());
}

describe('automatic context compaction', () => {
	it('compacts and resends the captured Claude turn while Codex remains selected', async () => {
		useSessionStore.setState({
			sessions: [
				{
					...session(),
					toolType: 'codex',
					aiTabs: [
						{
							...tab(),
							agentSessionId: 'codex-live',
							turnProvider: 'claude-code',
							providerSessions: { 'claude-code': { agentSessionId: PROVIDER_SESSION } },
						},
					],
				},
			],
		});
		const { spawner, finish } = deferredCompaction();
		noteDispatch(
			SESSION,
			{ ...queuedItem('captured-claude', 'continue'), turnSettings: { provider: 'claude-code' } },
			deps
		);
		expect(scheduleRetryForError(SESSION, TAB, contextLimitError())).toBe(true);
		noteFailedTurnExited(SESSION, TAB);
		expect(spawner.mock.calls[0][2]).toBe(PROVIDER_SESSION);
		expect(spawner.mock.calls[0][4]).toBe('claude-code');
		finish({ success: true });
		await vi.advanceTimersByTimeAsync(0);
		expect(processQueuedItem.mock.calls[0][1].turnSettings.provider).toBe('claude-code');
		expect(session().toolType).toBe('codex');
		expect(tab().agentSessionId).toBe('codex-live');
	});

	it('compacts the session, then resends the prompt', async () => {
		const { spawner, finish } = deferredCompaction();

		expect(failOnContextLimit()).toBe(true);

		// Taken over: a pending pill, the turn parked, and nothing started yet -
		// the failed process still has the provider session open.
		expect(pill()).toEqual({ status: 'pending' });
		expect(session().executionQueue.map((i) => i.id)).toEqual(['turn-1']);
		expect(hasPendingRetry(SESSION, TAB)).toBe(true);
		expect(isAwaitingContextCompaction(SESSION, TAB)).toBe(true);
		expect(spawner).not.toHaveBeenCalled();

		// The failed turn's process exits.
		clearRetryIfSettled(SESSION, TAB);
		noteFailedTurnExited(SESSION, TAB);

		expect(spawner).toHaveBeenCalledTimes(1);
		const [, , resumeId, prompt, toolType, , options] = spawner.mock.calls[0];
		expect(resumeId).toBe(PROVIDER_SESSION);
		expect(prompt).toBe('/compact');
		expect(toolType).toBe('claude-code');
		expect(options).toEqual({ keepTurnSettings: true, allowEmptyResponse: true });
		// The turn still reads as running while the provider summarizes.
		expect(tab().state).toBe('busy');
		expect(session().state).toBe('busy');
		expect(isAwaitingContextCompaction(SESSION, TAB)).toBe(false);
		expect(dispatched).toEqual([]);

		finish({ success: true });
		await vi.advanceTimersByTimeAsync(0);

		expect(pill()).toEqual({ status: 'done' });
		expect(dispatched).toEqual(['how are we looking?']);
		expect(session().executionQueue).toEqual([]);
		// No outage card, no stats row: nothing was waited out.
		expect(useRetryStore.getState().outages).toEqual({});
		expect(surfaced).not.toHaveBeenCalled();

		// The resent turn finishes cleanly.
		clearRetryIfSettled(SESSION, TAB);
		expect(hasPendingRetry(SESSION, TAB)).toBe(false);
	});

	it('does not start until the failed turn has exited', async () => {
		const { spawner } = deferredCompaction();
		failOnContextLimit();

		await vi.advanceTimersByTimeAsync(5_000);

		expect(spawner).not.toHaveBeenCalled();
		expect(getRetryEntry(SESSION, TAB)?.status).toBe('scheduled');
	});

	it('starts on its own when the exit never arrives but the process is gone', async () => {
		const { spawner } = deferredCompaction();
		const getActiveProcesses = vi.fn().mockResolvedValue([]);
		vi.stubGlobal('window', {
			...window,
			maestro: { ...window.maestro, process: { ...window.maestro?.process, getActiveProcesses } },
		});

		failOnContextLimit();
		await vi.advanceTimersByTimeAsync(30_000);

		expect(spawner).toHaveBeenCalledTimes(1);
		vi.unstubAllGlobals();
	});

	it('keeps waiting while the failed process is still alive', async () => {
		const { spawner } = deferredCompaction();
		const getActiveProcesses = vi.fn().mockResolvedValue([{ sessionId: `${SESSION}-ai-${TAB}` }]);
		vi.stubGlobal('window', {
			...window,
			maestro: { ...window.maestro, process: { ...window.maestro?.process, getActiveProcesses } },
		});

		failOnContextLimit();
		await vi.advanceTimersByTimeAsync(30_000);

		expect(spawner).not.toHaveBeenCalled();
		expect(isAwaitingContextCompaction(SESSION, TAB)).toBe(true);
		vi.unstubAllGlobals();
	});

	it('hands the original error back when the compaction fails', async () => {
		const { finish } = deferredCompaction();
		const error = contextLimitError();
		noteDispatch(SESSION, queuedItem('turn-1', 'how are we looking?'), deps);
		scheduleRetryForError(SESSION, TAB, error);
		noteFailedTurnExited(SESSION, TAB);

		// While the entry is live, the surfaced error must not start a second
		// compaction - that is what keeps the hand-back from looping.
		surfaced.mockImplementation(() => {
			expect(scheduleRetryForError(SESSION, TAB, error)).toBe(false);
		});

		finish({ success: false, error: 'Prompt is too long' });
		await vi.advanceTimersByTimeAsync(0);

		expect(pill()).toEqual({ status: 'error', error: 'Prompt is too long' });
		expect(surfaced).toHaveBeenCalledTimes(1);
		expect(surfaced).toHaveBeenCalledWith(`${SESSION}-ai-${TAB}`, error);
		expect(dispatched).toEqual([]);
		expect(session().executionQueue).toEqual([]);
		expect(tab().state).toBe('idle');
		expect(hasPendingRetry(SESSION, TAB)).toBe(false);
	});

	it('compacts once: a resend refused again is an error, not a second compaction', async () => {
		const { spawner, finish } = deferredCompaction();
		failOnContextLimit();
		noteFailedTurnExited(SESSION, TAB);
		finish({ success: true });
		await vi.advanceTimersByTimeAsync(0);
		expect(dispatched).toHaveLength(1);

		// The resend comes back with the same refusal.
		expect(scheduleRetryForError(SESSION, TAB, contextLimitError())).toBe(false);
		expect(spawner).toHaveBeenCalledTimes(1);
	});

	it('can be ended for one tab, leaving a compaction on another tab running', () => {
		deferredCompaction();
		failOnContextLimit();
		noteFailedTurnExited(SESSION, TAB);

		// Someone stopped a turn on a different tab of this agent.
		cancelContextCompaction(SESSION, 'some-other-tab');
		expect(hasPendingRetry(SESSION, TAB)).toBe(true);

		// And the same call, as Quick Chat's Stop makes it for this tab.
		cancelRecoveryForTab(SESSION, TAB);
		expect(hasPendingRetry(SESSION, TAB)).toBe(false);
		expect(pill()).toEqual({ status: 'canceled' });
		expect(session().executionQueue).toEqual([]);
	});

	it('ends quietly when the user presses Stop mid-compaction', async () => {
		const { finish } = deferredCompaction();
		failOnContextLimit();
		noteFailedTurnExited(SESSION, TAB);

		cancelContextCompaction(SESSION);

		expect(pill()).toEqual({ status: 'canceled' });
		expect(session().executionQueue).toEqual([]);
		expect(hasPendingRetry(SESSION, TAB)).toBe(false);

		// The killed compaction turn reports back as a failure. Nothing follows.
		finish({ success: false, error: 'exit code 143' });
		await vi.advanceTimersByTimeAsync(0);

		expect(pill()).toEqual({ status: 'canceled' });
		expect(dispatched).toEqual([]);
		expect(surfaced).not.toHaveBeenCalled();
	});

	it('leaves a context-limit error alone when it cannot help', () => {
		// No spawner wired.
		registerContextCompactionSpawner(null);
		expect(failOnContextLimit()).toBe(false);

		// A provider with no compaction command.
		deferredCompaction();
		useSessionStore.setState({
			sessions: [{ ...session(), toolType: 'codex' }],
		} as never);
		expect(failOnContextLimit()).toBe(false);

		// No provider session to resume.
		useSessionStore.setState({
			sessions: [
				{
					...session(),
					toolType: 'claude-code',
					aiTabs: [createMockAITab({ id: TAB, agentSessionId: null })],
				},
			],
		} as never);
		expect(failOnContextLimit()).toBe(false);

		expect(pill()).toBeUndefined();
		expect(hasPendingRetry(SESSION, TAB)).toBe(false);
	});

	it("does not compact when the refused turn was the user's own /compact", () => {
		deferredCompaction();
		expect(failOnContextLimit('/compact')).toBe(false);
		expect(pill()).toBeUndefined();
	});

	it('leaves an Auto Run task to the batch', () => {
		deferredCompaction();
		noteDispatch(SESSION, queuedItem('turn-1', 'task'), deps);
		expect(scheduleRetryForError(SESSION, TAB, contextLimitError(), { batch: true })).toBe(false);
		expect(pill()).toBeUndefined();
	});
});
