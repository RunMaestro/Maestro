/**
 * Phase 3b verification (wiring half): the renderer's side of the TTSR
 * interrupt loop - the abort-pending flag exit handling reads, and the
 * corrective respawn that continues the aborted conversation.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Controlled WindowContext: `undefined` => no window scoping (permit all); a
// predicate => this window owns only what the predicate accepts. TTSR pushes are
// broadcast to every window, so ownership is what stops two renderers from both
// respawning the corrective turn.
let mockOwnsSession: ((id: string) => boolean) | undefined;
vi.mock('../../../renderer/contexts/WindowContext', () => ({
	useWindowContextOptional: () => (mockOwnsSession ? { ownsSession: mockOwnsSession } : null),
}));

// Controlled runtime context: web-desktop clients mirror every agent (their
// ownership predicate is a permit-all), so the hook must refuse to respawn
// there outright - the desktop primary window, always alive because it hosts
// the web server, is the one that spawns.
let mockIsWebDesktop = false;
vi.mock('../../../renderer/utils/runtimeContext', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/utils/runtimeContext')>()),
	isWebDesktop: () => mockIsWebDesktop,
}));

const mockNotifyToast = vi.fn();
vi.mock('../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/notificationStore')>()),
	notifyToast: (...args: unknown[]) => mockNotifyToast(...args),
}));

import { createMockAITab, createMockSession } from '../../helpers';
import { runTtsrCorrectiveTurn, useTtsr } from '../../../renderer/hooks/useTtsr';
import { useBatchStore } from '../../../renderer/stores/batchStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import {
	isTtsrAbortPending,
	TTSR_ABORT_PENDING_TTL_MS,
	useTtsrStore,
} from '../../../renderer/stores/ttsrStore';
import type {
	TtsrAbortClearedPayload,
	TtsrAbortPendingPayload,
	TtsrTriggeredPayload,
} from '../../../shared/ttsr-types';

function makePayload(overrides: Partial<TtsrTriggeredPayload> = {}): TtsrTriggeredPayload {
	return {
		sessionId: 'session-1-ai-tab-1',
		tabId: 'tab-1',
		agentId: 'claude-code',
		rules: [{ name: 'no-console-log', path: '.maestro/rules/no-console-log.md' }],
		injectionPrompt: '<system-interrupt rule="no-console-log">Use the logger.</system-interrupt>',
		mode: 'resume',
		providerSessionId: 'prov-1',
		originalGoal: 'Refactor the auth module',
		contextMode: 'keep',
		...overrides,
	};
}

function makeAbortPending(
	overrides: Partial<TtsrAbortPendingPayload> = {}
): TtsrAbortPendingPayload {
	return {
		sessionId: 'session-1-ai-tab-1',
		tabId: 'tab-1',
		agentId: 'claude-code',
		rules: [{ name: 'no-console-log', path: '.maestro/rules/no-console-log.md' }],
		contextMode: 'keep',
		...overrides,
	};
}

function seedSession() {
	const tab = createMockAITab({ id: 'tab-1', state: 'idle' });
	const session = createMockSession({ id: 'session-1', aiTabs: [tab], activeTabId: 'tab-1' });
	useSessionStore.getState().setSessions([session]);
	return session;
}

function currentTab() {
	return useSessionStore.getState().sessions[0].aiTabs[0];
}

/**
 * Mock the three TTSR push channels and hand back the callbacks the hook
 * registered, so a test can fire a real `ttsr:triggered` instead of calling the
 * respawn directly.
 */
function wireBridge() {
	const listeners: {
		abortPending?: (payload: TtsrAbortPendingPayload) => void;
		triggered?: (payload: TtsrTriggeredPayload) => void;
		abortCleared?: (payload: TtsrAbortClearedPayload) => void;
	} = {};
	const off = {
		abortPending: vi.fn(),
		triggered: vi.fn(),
		abortCleared: vi.fn(),
	};
	window.maestro.ttsr.onAbortPending = vi.fn((cb) => {
		listeners.abortPending = cb;
		return off.abortPending;
	});
	window.maestro.ttsr.onTriggered = vi.fn((cb) => {
		listeners.triggered = cb;
		return off.triggered;
	});
	window.maestro.ttsr.onAbortCleared = vi.fn((cb) => {
		listeners.abortCleared = cb;
		return off.abortCleared;
	});
	return { listeners, off };
}

describe('ttsrStore abort-pending flag', () => {
	beforeEach(() => {
		useTtsrStore.setState({ abortPending: {}, lastTriggered: {} });
	});

	it('marks a turn while its abort is in flight', () => {
		expect(isTtsrAbortPending('session-1-ai-tab-1')).toBe(false);
		useTtsrStore.getState().noteAbortPending(makeAbortPending());
		expect(isTtsrAbortPending('session-1-ai-tab-1')).toBe(true);
		// Unrelated turns must keep their normal exit handling.
		expect(isTtsrAbortPending('session-1-ai-tab-2')).toBe(false);
	});

	it('clears the flag once the corrective payload arrives', () => {
		useTtsrStore.getState().noteAbortPending(makeAbortPending());
		useTtsrStore.getState().noteTriggered(makePayload());
		expect(isTtsrAbortPending('session-1-ai-tab-1')).toBe(false);
		expect(useTtsrStore.getState().lastTriggered['session-1-ai-tab-1']?.mode).toBe('resume');
	});

	it('releases the flag when main withdraws the abort', () => {
		const cleared: TtsrAbortClearedPayload = {
			sessionId: 'session-1-ai-tab-1',
			tabId: 'tab-1',
			agentId: 'claude-code',
			reason: 'the process could not be signalled',
		};
		const listeners: Record<string, (payload: never) => void> = {};
		window.maestro.ttsr.onAbortPending = vi.fn((cb) => {
			listeners.abortPending = cb as never;
			return () => {};
		});
		window.maestro.ttsr.onTriggered = vi.fn(() => () => {});
		window.maestro.ttsr.onAbortCleared = vi.fn((cb) => {
			listeners.abortCleared = cb as never;
			return () => {};
		});

		renderHook(() => useTtsr(true));
		listeners.abortPending?.(makeAbortPending() as never);
		expect(isTtsrAbortPending('session-1-ai-tab-1')).toBe(true);

		// No corrective turn is coming, so exit handling has to resume - otherwise
		// the tab stays suppressed and busy for good.
		listeners.abortCleared?.(cleared as never);
		expect(isTtsrAbortPending('session-1-ai-tab-1')).toBe(false);
	});

	// Main dying mid-abort, or the renderer unsubscribing between the two events,
	// leaves a mark nobody will ever clear. Without the TTL that mark suppresses
	// EVERY later exit for the session, so the agent can never go idle again.
	it('stops suppressing once the mark is older than the TTL', () => {
		useTtsrStore.getState().noteAbortPending(makeAbortPending());
		expect(isTtsrAbortPending('session-1-ai-tab-1')).toBe(true);

		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + TTSR_ABORT_PENDING_TTL_MS + 1);
		expect(isTtsrAbortPending('session-1-ai-tab-1')).toBe(false);
		// The stale entry is dropped, not just ignored.
		expect(useTtsrStore.getState().abortPending['session-1-ai-tab-1']).toBeUndefined();
		vi.restoreAllMocks();
	});

	it('keeps suppressing an abort that is merely slow', () => {
		useTtsrStore.getState().noteAbortPending(makeAbortPending());

		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + TTSR_ABORT_PENDING_TTL_MS - 1000);
		expect(isTtsrAbortPending('session-1-ai-tab-1')).toBe(true);
		vi.restoreAllMocks();
	});
});

describe('runTtsrCorrectiveTurn', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useTtsrStore.setState({ abortPending: {}, lastTriggered: {} });
		window.maestro.agents.get = vi.fn().mockResolvedValue({
			command: 'claude',
			path: '/usr/local/bin/claude',
			args: ['--print'],
			capabilities: { supportsStreamJsonInput: true },
		});
		window.maestro.process.spawn = vi.fn().mockResolvedValue({ pid: 1, success: true });
	});

	it('spawns the corrective turn on the same process id, resuming the provider session', async () => {
		seedSession();

		await expect(runTtsrCorrectiveTurn(makePayload())).resolves.toBe(true);

		expect(window.maestro.process.spawn).toHaveBeenCalledTimes(1);
		expect(window.maestro.process.spawn).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'session-1-ai-tab-1',
				agentSessionId: 'prov-1',
				prompt: expect.stringContaining('<system-interrupt'),
			})
		);
	});

	it('puts the tab back to busy and records the interruption in the transcript', async () => {
		seedSession();

		await runTtsrCorrectiveTurn(makePayload());

		const tab = currentTab();
		expect(tab.state).toBe('busy');
		expect(tab.thinkingStartTime).toBeGreaterThan(0);
		expect(tab.logs).toHaveLength(1);
		expect(tab.logs[0].source).toBe('system');
		expect(tab.logs[0].text).toContain('no-console-log');
	});

	it('tells the user the degraded path restarted the turn', async () => {
		seedSession();

		await runTtsrCorrectiveTurn(
			makePayload({ mode: 'fresh', providerSessionId: undefined, agentId: 'grok' })
		);

		expect(window.maestro.process.spawn).toHaveBeenCalledWith(
			expect.objectContaining({ agentSessionId: undefined })
		);
		expect(currentTab().logs[0].text).toContain('cannot resume mid-turn');
	});

	it('keeps the corrective turn read-only under a non-worktree Auto Run', async () => {
		const session = seedSession();
		useBatchStore.setState({
			batchRunStates: {
				[session.id]: { isRunning: true, worktreeActive: false } as never,
			},
		});

		await runTtsrCorrectiveTurn(makePayload());

		expect(window.maestro.process.spawn).toHaveBeenCalledWith(
			expect.objectContaining({ readOnlyMode: true, permissionMode: 'readonly' })
		);
		useBatchStore.setState({ batchRunStates: {} });
	});

	it('drops the corrective turn when the tab is gone', async () => {
		useSessionStore.getState().setSessions([]);

		await expect(runTtsrCorrectiveTurn(makePayload())).resolves.toBe(false);
		expect(window.maestro.process.spawn).not.toHaveBeenCalled();
	});

	it('idles the tab and reports the failure when the respawn cannot spawn', async () => {
		seedSession();
		window.maestro.process.spawn = vi.fn().mockRejectedValue(new Error('spawn failed'));

		await expect(runTtsrCorrectiveTurn(makePayload())).resolves.toBe(false);

		const tab = currentTab();
		expect(tab.state).toBe('idle');
		expect(tab.thinkingStartTime).toBeUndefined();
		expect(tab.logs.at(-1)?.text).toContain('spawn failed');
	});

	// The aborted turn's exit is suppressed by the abort-pending flag, so a failed
	// respawn is the ONLY thing left that can release the session. Miss it and the
	// agent spins forever with queue dispatch blocked until the app reloads.
	it('releases the session, not just the tab, when the respawn cannot spawn', async () => {
		seedSession();
		useSessionStore.getState().setSessions([
			{
				...useSessionStore.getState().sessions[0],
				state: 'busy',
				busySource: 'ai',
				thinkingStartTime: Date.now(),
			},
		]);
		useTtsrStore.getState().noteAbortPending(makeAbortPending());
		window.maestro.process.spawn = vi.fn().mockRejectedValue(new Error('ssh remote unresolvable'));

		await expect(runTtsrCorrectiveTurn(makePayload())).resolves.toBe(false);

		const session = useSessionStore.getState().sessions[0];
		expect(session.state).toBe('idle');
		expect(session.busySource).toBeUndefined();
		expect(session.thinkingStartTime).toBeUndefined();
		expect(isTtsrAbortPending('session-1-ai-tab-1')).toBe(false);
		expect(mockNotifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				color: 'red',
				message: expect.stringContaining('ssh remote unresolvable'),
			})
		);
		// The rule that fired is named, so the user knows what guidance was lost.
		expect(mockNotifyToast.mock.calls[0][0].message).toContain('no-console-log');
	});

	// Same rule `useAgentExitListener` follows: only the interrupted tab's turn
	// died, so a sibling tab mid-turn keeps the agent busy. Forcing the whole
	// session idle here would wipe the sibling's spinner while it still streams.
	it('keeps the session busy when a sibling tab is still mid-turn', async () => {
		const tab1 = createMockAITab({ id: 'tab-1', state: 'busy' });
		const tab2 = createMockAITab({ id: 'tab-2', state: 'busy' });
		const session = createMockSession({
			id: 'session-1',
			aiTabs: [tab1, tab2],
			activeTabId: 'tab-1',
			state: 'busy',
			busySource: 'ai',
		});
		useSessionStore.getState().setSessions([session]);
		useTtsrStore.getState().noteAbortPending(makeAbortPending());
		window.maestro.process.spawn = vi.fn().mockRejectedValue(new Error('spawn failed'));

		await expect(runTtsrCorrectiveTurn(makePayload())).resolves.toBe(false);

		const after = useSessionStore.getState().sessions[0];
		// The interrupted tab is released...
		expect(after.aiTabs.find((tab) => tab.id === 'tab-1')?.state).toBe('idle');
		// ...but tab-2 is still mid-turn, so the agent stays busy.
		expect(after.aiTabs.find((tab) => tab.id === 'tab-2')?.state).toBe('busy');
		expect(after.state).toBe('busy');
		expect(after.busySource).toBe('ai');
	});

	it('releases the session when the agent is not installed', async () => {
		seedSession();
		useSessionStore
			.getState()
			.setSessions([
				{ ...useSessionStore.getState().sessions[0], state: 'busy', busySource: 'ai' },
			]);
		useTtsrStore.getState().noteAbortPending(makeAbortPending());
		window.maestro.agents.get = vi.fn().mockResolvedValue(null);

		await expect(runTtsrCorrectiveTurn(makePayload())).resolves.toBe(false);

		expect(window.maestro.process.spawn).not.toHaveBeenCalled();
		const session = useSessionStore.getState().sessions[0];
		expect(session.state).toBe('idle');
		expect(session.busySource).toBeUndefined();
		expect(isTtsrAbortPending('session-1-ai-tab-1')).toBe(false);
		expect(mockNotifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ color: 'red', message: expect.stringContaining('not found') })
		);
	});

	it('clears the abort mark when the tab is gone, so future exits are not suppressed', async () => {
		useSessionStore.getState().setSessions([]);
		useTtsrStore.getState().noteAbortPending(makeAbortPending());

		await expect(runTtsrCorrectiveTurn(makePayload())).resolves.toBe(false);

		expect(isTtsrAbortPending('session-1-ai-tab-1')).toBe(false);
	});
});

describe('useTtsr subscription wiring', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockOwnsSession = undefined;
		useTtsrStore.setState({ abortPending: {}, lastTriggered: {} });
		window.maestro.agents.get = vi.fn().mockResolvedValue({
			command: 'claude',
			path: '/usr/local/bin/claude',
			args: ['--print'],
			capabilities: { supportsStreamJsonInput: true },
		});
		window.maestro.process.spawn = vi.fn().mockResolvedValue({ pid: 1, success: true });
	});

	it('respawns the corrective turn when `ttsr:triggered` arrives', async () => {
		seedSession();
		const { listeners } = wireBridge();

		renderHook(() => useTtsr(true));
		listeners.triggered?.(makePayload());

		await waitFor(() => expect(window.maestro.process.spawn).toHaveBeenCalledTimes(1));
		expect(useTtsrStore.getState().lastTriggered['session-1-ai-tab-1']).toBeDefined();
	});

	it('does NOT respawn in a window that does not own the agent', async () => {
		seedSession();
		mockOwnsSession = (id: string) => id === 'some-other-agent';
		const { listeners } = wireBridge();

		renderHook(() => useTtsr(true));
		listeners.triggered?.(makePayload());
		await Promise.resolve();

		// The push reaches every window, but only the owner may spawn - a second
		// spawn would kill the first mid-flight and double the interrupt.
		expect(window.maestro.process.spawn).not.toHaveBeenCalled();
		// Display state is per-renderer, so it is still recorded here.
		expect(useTtsrStore.getState().lastTriggered['session-1-ai-tab-1']).toBeDefined();
	});

	it('does NOT respawn in a web-desktop client, even though it "owns" every agent', async () => {
		seedSession();
		mockIsWebDesktop = true;
		try {
			const { listeners } = wireBridge();

			renderHook(() => useTtsr(true));
			listeners.triggered?.(makePayload());
			await Promise.resolve();

			// A browser client's ownsSession is a permit-all, so the ownership gate
			// alone would let it spawn a duplicate corrective turn alongside the
			// desktop window's. The web-desktop check is what closes that race.
			expect(window.maestro.process.spawn).not.toHaveBeenCalled();
			// Display state is per-renderer, so it is still recorded here.
			expect(useTtsrStore.getState().lastTriggered['session-1-ai-tab-1']).toBeDefined();
		} finally {
			mockIsWebDesktop = false;
		}
	});

	it('respawns in the window that DOES own the agent', async () => {
		seedSession();
		mockOwnsSession = (id: string) => id === 'session-1';
		const { listeners } = wireBridge();

		renderHook(() => useTtsr(true));
		listeners.triggered?.(makePayload());

		await waitFor(() => expect(window.maestro.process.spawn).toHaveBeenCalledTimes(1));
	});

	it('subscribes to nothing while the Encore flag is off', () => {
		wireBridge();

		renderHook(() => useTtsr(false));

		expect(window.maestro.ttsr.onTriggered).not.toHaveBeenCalled();
		expect(window.maestro.ttsr.onAbortPending).not.toHaveBeenCalled();
		expect(window.maestro.ttsr.onAbortCleared).not.toHaveBeenCalled();
	});

	it('removes every listener on unmount', () => {
		const { off } = wireBridge();

		const { unmount } = renderHook(() => useTtsr(true));
		unmount();

		expect(off.abortPending).toHaveBeenCalledTimes(1);
		expect(off.triggered).toHaveBeenCalledTimes(1);
		expect(off.abortCleared).toHaveBeenCalledTimes(1);
	});

	// An abort in flight when the hook goes away can never be cleared by the
	// normal path, and a standing mark suppresses that session's exits forever.
	it('drops standing abort marks on unmount', () => {
		const { listeners } = wireBridge();

		const { unmount } = renderHook(() => useTtsr(true));
		listeners.abortPending?.(makeAbortPending());
		expect(isTtsrAbortPending('session-1-ai-tab-1')).toBe(true);

		unmount();

		expect(isTtsrAbortPending('session-1-ai-tab-1')).toBe(false);
	});

	it('drops standing abort marks when the Encore flag flips off', () => {
		const { listeners } = wireBridge();

		const { rerender } = renderHook(({ on }: { on: boolean }) => useTtsr(on), {
			initialProps: { on: true },
		});
		listeners.abortPending?.(makeAbortPending());

		rerender({ on: false });

		expect(isTtsrAbortPending('session-1-ai-tab-1')).toBe(false);
	});

	it('removes every listener when the Encore flag flips off', () => {
		const { off } = wireBridge();

		const { rerender } = renderHook(({ on }: { on: boolean }) => useTtsr(on), {
			initialProps: { on: true },
		});
		rerender({ on: false });

		expect(off.triggered).toHaveBeenCalledTimes(1);
	});
});
