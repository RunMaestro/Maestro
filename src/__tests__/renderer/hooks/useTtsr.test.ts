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
	matchKey,
	TTSR_ABORT_PENDING_TTL_MS,
	useTtsrStore,
} from '../../../renderer/stores/ttsrStore';
import type {
	TtsrAbortClearedPayload,
	TtsrAbortPendingPayload,
	TtsrMatchedPayload,
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

function makeMatched(overrides: Partial<TtsrMatchedPayload> = {}): TtsrMatchedPayload {
	return {
		sessionId: 'session-1-ai-tab-1',
		agentId: 'claude-code',
		source: 'text',
		rules: [{ name: 'no-console-log', path: '.maestro/rules/no-console-log.md' }],
		willInterrupt: false,
		...overrides,
	};
}

/**
 * Mock the TTSR push channels and hand back the callbacks the hook registered,
 * so a test can fire a real `ttsr:triggered` instead of calling the respawn
 * directly.
 */
function wireBridge() {
	const listeners: {
		abortPending?: (payload: TtsrAbortPendingPayload) => void;
		triggered?: (payload: TtsrTriggeredPayload) => void;
		abortCleared?: (payload: TtsrAbortClearedPayload) => void;
		matched?: (payload: TtsrMatchedPayload) => void;
	} = {};
	const off = {
		abortPending: vi.fn(),
		triggered: vi.fn(),
		abortCleared: vi.fn(),
		matched: vi.fn(),
	};
	window.maestro.ttsr.onMatched = vi.fn((cb) => {
		listeners.matched = cb;
		return off.matched;
	});
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
		// Two entries: the gray system line narrating the abort, then the badged
		// `source: 'user'` entry marking the actual <system-interrupt> injection.
		expect(tab.logs).toHaveLength(2);
		expect(tab.logs[0].source).toBe('system');
		expect(tab.logs[0].text).toContain('no-console-log');
		expect(tab.logs[0].ttsr).toBeUndefined();

		const injection = tab.logs[1];
		expect(injection.source).toBe('user');
		expect(injection.text).toBe(makePayload().injectionPrompt);
		expect(injection.ttsr).toEqual({ rules: ['no-console-log'], mode: 'resume' });
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

			const tab = currentTab();
			// The transcript must not stop mid-sentence: a boundary notice is
			// appended telling the web user where the correction actually runs...
			expect(tab.logs).toHaveLength(1);
			expect(tab.logs[0].source).toBe('system');
			expect(tab.logs[0].text).toContain('no-console-log');
			expect(tab.logs[0].text).toContain('run by the desktop app');
			// ...but the tab is NOT flipped to busy - the mirrored process:* events
			// from the desktop-spawned turn are what drive the visible streaming.
			expect(tab.state).toBe('idle');
			expect(tab.thinkingStartTime).toBeUndefined();
		} finally {
			mockIsWebDesktop = false;
		}
	});

	it('uses the desktop interruption notice text on a non-web client', async () => {
		seedSession();
		const { listeners } = wireBridge();

		renderHook(() => useTtsr(true));
		listeners.triggered?.(makePayload());

		await waitFor(() => expect(window.maestro.process.spawn).toHaveBeenCalledTimes(1));
		const tab = currentTab();
		// Desktop path spawns and flips the tab busy, and its notice says this
		// client is resuming the conversation - not that the desktop app will.
		expect(tab.state).toBe('busy');
		expect(tab.logs[0].text).toContain('Reinjecting corrective guidance');
		expect(tab.logs[0].text).not.toContain('run by the desktop app');
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

// A non-interrupting match (`interruptMode: never`) emits `ttsr:matched` and
// nothing else - no toast, no abort, no transcript line - so without this
// subscription the rule fires in total silence and reads as broken.
describe('useTtsr match recording', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockOwnsSession = undefined;
		useTtsrStore.setState({ abortPending: {}, lastTriggered: {}, matches: {} });
	});

	it('records a match against every rule it names, keyed by the project root', () => {
		const session = seedSession();
		const { listeners } = wireBridge();

		renderHook(() => useTtsr(true));
		listeners.matched?.(
			makeMatched({
				rules: [
					{ name: 'no-console-log', path: '.maestro/rules/no-console-log.md' },
					{ name: 'no-any', path: '.maestro/rules/no-any.md' },
				],
			})
		);

		const { matches } = useTtsrStore.getState();
		const entry = matches[matchKey(session.cwd, '.maestro/rules/no-console-log.md')];
		expect(entry?.count).toBe(1);
		expect(entry?.lastSource).toBe('text');
		expect(entry?.lastWillInterrupt).toBe(false);
		expect(matches[matchKey(session.cwd, '.maestro/rules/no-any.md')]?.count).toBe(1);
	});

	it('counts repeats and keeps the newest interrupt flag and file path', () => {
		const session = seedSession();
		const { listeners } = wireBridge();

		renderHook(() => useTtsr(true));
		listeners.matched?.(makeMatched());
		listeners.matched?.(
			makeMatched({ willInterrupt: true, source: 'tool:edit', filePath: 'src/a.ts' })
		);

		const entry =
			useTtsrStore.getState().matches[matchKey(session.cwd, '.maestro/rules/no-console-log.md')];
		expect(entry?.count).toBe(2);
		expect(entry?.lastWillInterrupt).toBe(true);
		expect(entry?.lastSource).toBe('tool:edit');
		expect(entry?.lastFilePath).toBe('src/a.ts');
	});

	// The tab can go away while the match is in flight. Nothing was reserved for
	// this payload, so it is dropped - but it must not throw and take the
	// subscription down with it.
	it('drops a payload whose session cannot be resolved', () => {
		seedSession();
		const { listeners } = wireBridge();

		renderHook(() => useTtsr(true));
		expect(() => listeners.matched?.(makeMatched({ sessionId: 'gone-ai-tab-9' }))).not.toThrow();
		expect(Object.keys(useTtsrStore.getState().matches)).toHaveLength(0);
	});

	it('does not crash on a preload without `onMatched`', () => {
		seedSession();
		const { listeners, off } = wireBridge();
		const original = window.maestro.ttsr.onMatched;
		delete (window.maestro.ttsr as Partial<typeof window.maestro.ttsr>).onMatched;
		try {
			const { unmount } = renderHook(() => useTtsr(true));
			// The other three channels still work; only the match line is missing.
			listeners.triggered?.(makePayload());
			expect(useTtsrStore.getState().lastTriggered['session-1-ai-tab-1']).toBeDefined();
			expect(() => unmount()).not.toThrow();
			expect(off.matched).not.toHaveBeenCalled();
		} finally {
			window.maestro.ttsr.onMatched = original;
		}
	});

	it('unsubscribes the match listener on unmount', () => {
		const { off } = wireBridge();

		const { unmount } = renderHook(() => useTtsr(true));
		unmount();

		expect(off.matched).toHaveBeenCalledTimes(1);
	});

	// Display state is per-renderer, so browser clients count too - the Rules
	// panel there would otherwise stay blank while the desktop panel fills in.
	it('records in a web-desktop client as well', () => {
		const session = seedSession();
		mockIsWebDesktop = true;
		try {
			const { listeners } = wireBridge();

			renderHook(() => useTtsr(true));
			listeners.matched?.(makeMatched());

			expect(
				useTtsrStore.getState().matches[matchKey(session.cwd, '.maestro/rules/no-console-log.md')]
					?.count
			).toBe(1);
		} finally {
			mockIsWebDesktop = false;
		}
	});

	// Ownership gates the corrective SPAWN, not the display cache: a non-owning
	// window still shows what its own Rules panel is scoped to.
	it('records in a window that does not own the agent', () => {
		const session = seedSession();
		mockOwnsSession = (id: string) => id === 'some-other-agent';
		const { listeners } = wireBridge();

		renderHook(() => useTtsr(true));
		listeners.matched?.(makeMatched());

		expect(
			useTtsrStore.getState().matches[matchKey(session.cwd, '.maestro/rules/no-console-log.md')]
				?.count
		).toBe(1);
	});
});

/**
 * D2 item 4: main raises the interrupt toast optimistically, so the renderer
 * that was told to respawn has to say whether it managed to. Without the ack,
 * a corrective turn that never starts leaves a web-desktop user staring at an
 * orange toast promising a correction that is not coming.
 */
describe('corrective-turn ack', () => {
	let report: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		useTtsrStore.setState({ abortPending: {}, lastTriggered: {} });
		report = vi.fn().mockResolvedValue(undefined);
		window.maestro.ttsr.reportCorrectiveResult = report;
		window.maestro.agents.get = vi.fn().mockResolvedValue({
			command: 'claude',
			path: '/usr/local/bin/claude',
			args: ['--print'],
			capabilities: { supportsStreamJsonInput: true },
		});
		window.maestro.process.spawn = vi.fn().mockResolvedValue({ pid: 1, success: true });
	});

	it('acks success only after the spawn returns', async () => {
		seedSession();
		let resolveSpawn: (() => void) | undefined;
		window.maestro.process.spawn = vi.fn(
			() =>
				new Promise((resolve) => {
					resolveSpawn = () => resolve({ pid: 1, success: true });
				})
		);

		const running = runTtsrCorrectiveTurn(makePayload());
		await waitFor(() => expect(window.maestro.process.spawn).toHaveBeenCalled());
		// The promise the toast made is "the turn is being corrected", and until
		// the spawn resolves it is not.
		expect(report).not.toHaveBeenCalled();

		resolveSpawn?.();
		await running;

		expect(report).toHaveBeenCalledWith({
			sessionId: 'session-1-ai-tab-1',
			ok: true,
			error: undefined,
		});
	});

	it('acks failure with the spawn error', async () => {
		seedSession();
		window.maestro.process.spawn = vi.fn().mockRejectedValue(new Error('spawn failed'));

		await runTtsrCorrectiveTurn(makePayload());

		expect(report).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: 'session-1-ai-tab-1', ok: false, error: 'spawn failed' })
		);
	});

	it('acks failure when the tab is gone, so main does not wait out the timeout', async () => {
		useSessionStore.getState().setSessions([]);

		await runTtsrCorrectiveTurn(makePayload());

		expect(report).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: 'session-1-ai-tab-1', ok: false })
		);
	});

	// Older preloads and some web-desktop shims lack the method; TTSR degrades to
	// main's timeout rather than failing the corrective turn it just spawned.
	it('spawns normally when the preload has no ack method', async () => {
		seedSession();
		(window.maestro.ttsr as Record<string, unknown>).reportCorrectiveResult = undefined;

		await expect(runTtsrCorrectiveTurn(makePayload())).resolves.toBe(true);
		expect(window.maestro.process.spawn).toHaveBeenCalledTimes(1);
	});

	// The ack is advisory: a rejected report must not turn a corrective turn that
	// DID start into a reported failure.
	it('keeps the turn successful when the ack itself fails', async () => {
		seedSession();
		report.mockRejectedValue(new Error('bridge down'));

		await expect(runTtsrCorrectiveTurn(makePayload())).resolves.toBe(true);
	});

	// Web-desktop clients never spawn the corrective turn, so they must never ack
	// either: a false "ok" from a client that did nothing would cancel the very
	// watchdog that exists to cover them.
	it('does not ack from a web-desktop client', async () => {
		seedSession();
		const { listeners } = wireBridge();
		mockIsWebDesktop = true;

		renderHook(() => useTtsr(true));
		listeners.triggered?.(makePayload());
		await waitFor(() => expect(currentTab().logs).toHaveLength(1));

		expect(window.maestro.process.spawn).not.toHaveBeenCalled();
		expect(report).not.toHaveBeenCalled();
		mockIsWebDesktop = false;
	});
});
