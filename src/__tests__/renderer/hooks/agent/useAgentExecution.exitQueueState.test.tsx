/**
 * Regression tests for the onExit reducer inside `useAgentExecution.spawnAgentForSession`.
 *
 * Auto Run spawns under its own `{sessionId}-batch-{ts}` process id and
 * deliberately never marks a tab busy. Its exit handler, however, used to
 * (a) dequeue the next queued item without marking the target tab busy, and
 * (b) force EVERY busy tab back to idle. Both dropped the in-progress
 * indicator from threads whose own `-ai-{tabId}` agents were still running.
 *
 * Tests:
 *   - Exit with no queued items leaves other still-running tabs busy
 *   - Exit with no queued items and no busy tabs still settles the session idle
 *   - Exit that dequeues an item marks the target tab busy (with its user log)
 *   - Exit that dequeues an item for a closed tab marks the orphan busy
 *   - Exit leaves an item queued when its target tab is still mid-turn (MAESTRO-ZS)
 *   - A failed dispatch after the exit is logged, not left as an unhandled rejection
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createMockSession, createMockAITab } from '../../../helpers';
import type { Session, QueuedItem } from '../../../../renderer/types';

vi.mock('../../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: {
		getState: () => ({ autoRunInactivityTimeoutMin: 0 }),
	},
}));

vi.mock('../../../../renderer/utils/spawnHelpers', () => ({
	prepareMaestroSystemPrompt: vi.fn(async () => undefined),
	getStdinFlags: () => ({ sendPromptViaStdin: false, sendPromptViaStdinRaw: false }),
}));

vi.mock('../../../../renderer/utils/contextUsage', () => ({
	estimateContextUsage: () => undefined,
}));

vi.mock('../../../../renderer/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { useAgentExecution } from '../../../../renderer/hooks/agent/useAgentExecution';
import { logger } from '../../../../renderer/utils/logger';

// ============================================================================
// Harness
// ============================================================================

/** Fires the registered process.onExit callback for the batch session id. */
let emitExit: ((sessionId: string, code: number) => void) | null = null;
/** The `{sessionId}-batch-{ts}` id the hook spawned under. */
let spawnedSessionId = '';

/**
 * The mock replaces `window.maestro` wholesale rather than patching it, so the
 * original has to be put back or every later suite in the same worker inherits
 * this stub.
 */
let originalMaestro: unknown;

function installMaestroMock() {
	emitExit = null;
	spawnedSessionId = '';
	originalMaestro = (window as unknown as { maestro: unknown }).maestro;
	(window as unknown as { maestro: unknown }).maestro = {
		agents: { get: vi.fn(async () => ({ command: 'claude', args: [], capabilities: {} })) },
		process: {
			spawn: vi.fn(async (config: { sessionId: string }) => {
				spawnedSessionId = config.sessionId;
			}),
			kill: vi.fn(async () => {}),
			onData: vi.fn(() => vi.fn()),
			onSessionId: vi.fn(() => vi.fn()),
			onUsage: vi.fn(() => vi.fn()),
			onExit: vi.fn((cb: (sessionId: string, code: number) => void) => {
				emitExit = cb;
				return vi.fn();
			}),
		},
		stats: { recordQuery: vi.fn(async () => {}) },
	};
}

/**
 * Run spawnAgentForSession against `session`, fire a clean exit, and return the
 * session as the hook's setSessions reducer left it.
 */
async function runExit(
	session: Session,
	processQueuedItem: (sessionId: string, item: QueuedItem) => Promise<void> = vi.fn(async () => {}),
	sessionsRef: { current: Session[] } = { current: [session] }
): Promise<Session> {
	const setSessions = vi.fn((updater: (prev: Session[]) => Session[]) => {
		sessionsRef.current = updater(sessionsRef.current);
	});

	const { result } = renderHook(() =>
		useAgentExecution({
			activeSession: session,
			sessionsRef: sessionsRef as never,
			setSessions: setSessions as never,
			processQueuedItemRef: { current: processQueuedItem } as never,
			getBatchState: () => ({ isRunning: false, worktreeActive: false }),
		} as never)
	);

	await act(async () => {
		void result.current.spawnAgentForSession(session.id, 'do the thing', undefined, {
			isAutoRun: true,
		});
		// Let the async agent lookup + spawn resolve so onExit is registered.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});

	expect(emitExit).toBeTypeOf('function');

	await act(async () => {
		emitExit!(spawnedSessionId, 0);
		await Promise.resolve();
	});

	return sessionsRef.current[0];
}

const queuedMessage = (tabId: string): QueuedItem =>
	({
		id: 'queued-1',
		timestamp: 1,
		tabId,
		type: 'message',
		text: 'queued prompt',
	}) as QueuedItem;

// ============================================================================
// Tests
// ============================================================================

describe('useAgentExecution - Auto Run exit vs. parallel tab busy state', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		installMaestroMock();
	});

	afterEach(() => {
		(window as unknown as { maestro: unknown }).maestro = originalMaestro;
	});

	it('leaves still-running parallel tabs busy when the batch task exits', async () => {
		// Three threads running on one agent; Auto Run finishes alongside them.
		const session = createMockSession({
			id: 'session-1',
			state: 'busy',
			busySource: 'ai',
			thinkingStartTime: 1000,
			activeTabId: 'tab-a',
			aiTabs: [
				createMockAITab({ id: 'tab-a', state: 'busy', thinkingStartTime: 1000 }),
				createMockAITab({ id: 'tab-b', state: 'busy', thinkingStartTime: 1001 }),
				createMockAITab({ id: 'tab-c', state: 'busy', thinkingStartTime: 1002 }),
			],
		});

		const next = await runExit(session);

		// Every running thread keeps its in-progress indicator (issue #1318).
		expect(next.aiTabs.map((t) => t.state)).toEqual(['busy', 'busy', 'busy']);
		expect(next.aiTabs.map((t) => t.thinkingStartTime)).toEqual([1000, 1001, 1002]);
		// Session stays busy because tabs are still working.
		expect(next.state).toBe('busy');
		expect(next.busySource).toBe('ai');
		expect(next.thinkingStartTime).toBe(1000);
	});

	it('settles the session idle when no tab is still running', async () => {
		const session = createMockSession({
			id: 'session-1',
			state: 'busy',
			busySource: 'ai',
			thinkingStartTime: 1000,
			activeTabId: 'tab-a',
			aiTabs: [createMockAITab({ id: 'tab-a', state: 'idle' })],
		});

		const next = await runExit(session);

		expect(next.state).toBe('idle');
		expect(next.busySource).toBeUndefined();
		expect(next.thinkingStartTime).toBeUndefined();
	});

	it('marks the dequeued item’s target tab busy and logs its prompt', async () => {
		const session = createMockSession({
			id: 'session-1',
			state: 'busy',
			busySource: 'ai',
			activeTabId: 'tab-a',
			executionQueue: [queuedMessage('tab-b')],
			aiTabs: [
				createMockAITab({ id: 'tab-a', state: 'idle' }),
				createMockAITab({ id: 'tab-b', state: 'idle' }),
			],
		});

		const next = await runExit(session);

		const targetTab = next.aiTabs.find((t) => t.id === 'tab-b')!;
		// The dequeued turn is running, so the tab must show as in-progress.
		expect(targetTab.state).toBe('busy');
		expect(targetTab.thinkingStartTime).toBeTypeOf('number');
		expect(targetTab.logs.map((l) => l.text)).toEqual(['queued prompt']);
		// And it is brought into view, as before.
		expect(next.activeTabId).toBe('tab-b');
		expect(next.executionQueue).toHaveLength(0);
		expect(next.state).toBe('busy');
	});

	it('marks an orphaned (closed) target tab busy without touching live tabs', async () => {
		const session = createMockSession({
			id: 'session-1',
			state: 'busy',
			busySource: 'ai',
			activeTabId: 'tab-a',
			executionQueue: [queuedMessage('tab-gone')],
			aiTabs: [createMockAITab({ id: 'tab-a', state: 'idle' })],
			orphanedThinkingTabs: [createMockAITab({ id: 'tab-gone', state: 'idle' })],
		});

		const next = await runExit(session);

		const orphan = next.orphanedThinkingTabs!.find((t) => t.id === 'tab-gone')!;
		expect(orphan.state).toBe('busy');
		expect(orphan.logs.map((l) => l.text)).toEqual(['queued prompt']);
		// The foreground tab is untouched - the send is fire-and-forget.
		expect(next.aiTabs.find((t) => t.id === 'tab-a')!.logs).toHaveLength(0);
		expect(next.activeTabId).toBe('tab-a');
	});

	// MAESTRO-ZS: the user sent a prompt on tab-b while Auto Run was running, so
	// tab-b's own `-ai-tab-b` process is live and a follow-up is queued for it.
	// Dispatching that follow-up when the batch task exits collided with the live
	// process ("Agent process already running for session ...-ai-tab-b").
	it('leaves the item queued when its target tab is still mid-turn', async () => {
		const processQueuedItem = vi.fn(async () => {});
		const sessionsRef = {
			current: [
				createMockSession({
					id: 'session-1',
					state: 'busy',
					busySource: 'ai',
					activeTabId: 'tab-a',
					executionQueue: [queuedMessage('tab-b')],
					aiTabs: [
						createMockAITab({ id: 'tab-a', state: 'idle' }),
						createMockAITab({ id: 'tab-b', state: 'busy', thinkingStartTime: 1000 }),
					],
				}),
			],
		};

		const next = await runExit(sessionsRef.current[0], processQueuedItem, sessionsRef);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		expect(processQueuedItem).not.toHaveBeenCalled();
		expect(next.executionQueue.map((item) => item.id)).toEqual(['queued-1']);
		const busyTab = next.aiTabs.find((t) => t.id === 'tab-b')!;
		expect(busyTab.state).toBe('busy');
		expect(busyTab.logs).toHaveLength(0);
		expect(next.activeTabId).toBe('tab-a');
		// tab-b is still running, so the agent stays busy.
		expect(next.state).toBe('busy');

		// Let the Auto Run task's queue-drain poll settle so no timer outlives the test.
		sessionsRef.current = [{ ...next, state: 'idle' }];
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 80));
		});
	});

	it('logs a failed dispatch instead of leaving the rejection unhandled', async () => {
		const failure = new Error('Agent process already running for session session-1-ai-tab-b');
		const processQueuedItem = vi.fn(() => Promise.reject(failure));
		const session = createMockSession({
			id: 'session-1',
			state: 'busy',
			busySource: 'ai',
			activeTabId: 'tab-a',
			executionQueue: [queuedMessage('tab-b')],
			aiTabs: [
				createMockAITab({ id: 'tab-a', state: 'idle' }),
				createMockAITab({ id: 'tab-b', state: 'idle' }),
			],
		});

		await runExit(session, processQueuedItem);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		expect(processQueuedItem).toHaveBeenCalledWith(
			'session-1',
			expect.objectContaining({ id: 'queued-1' })
		);
		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining('Queued dispatch after batch task failed'),
			undefined,
			failure
		);
	});
});
