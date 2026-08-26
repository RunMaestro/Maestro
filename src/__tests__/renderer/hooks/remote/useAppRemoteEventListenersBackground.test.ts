/**
 * Covers the `--background` half of the CLI/web file, terminal and agent
 * bridges in useAppRemoteEventListeners.
 *
 * The invariant under test is the same one `open-browser --background` already
 * holds, extended to the rest of the surface-creating verbs: the surface is
 * created and addressable, and NEITHER the active agent NOR the active tab
 * within any agent moves. The risk this file exists to catch is a flag that
 * reaches the CLI and then gets dropped somewhere on the way down, which is
 * worse than no flag because the caller believes they were polite.
 *
 * Every case is asserted in both directions: with the flag, and without it.
 * An unflagged call that stops focusing is a regression, and threading
 * absent-as-falsy in the wrong direction is the most likely way to ship one.
 */
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { useAppRemoteEventListeners } from '../../../../renderer/hooks/remote/useAppRemoteEventListeners';
import { createMockSession } from '../../../helpers/mockSession';
import type { Session } from '../../../../renderer/types';

vi.mock('../../../../renderer/stores/sessionStore', () => ({
	useSessionStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
	selectSessionById: vi.fn(),
}));
vi.mock('../../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
}));
vi.mock('../../../../renderer/hooks/batch/batchUtils', () => ({ DEFAULT_BATCH_PROMPT: '' }));
vi.mock('../../../../renderer/services/git', () => ({
	gitService: { isRepo: vi.fn().mockResolvedValue(false) },
}));
vi.mock('../../../../renderer/utils/worktreeSpawn', () => ({
	spawnWorktreeAgentAndDispatch: vi.fn(),
}));
vi.mock('../../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));
vi.mock('../../../../renderer/utils/browserTabPersistence', () => ({
	getBrowserTabPartition: () => 'persist:test',
}));

function setup(sessions: Session[]) {
	const sessionsRef = { current: sessions };
	const setActiveSessionId = vi.fn();
	const setSessions = vi.fn();
	const handleOpenFileTab = vi.fn();

	renderHook(() =>
		useAppRemoteEventListeners({
			sessionsRef,
			setActiveSessionId,
			setSessions,
			setGroups: vi.fn(),
			handleOpenFileTab,
			refreshFileTree: vi.fn(),
			handleAutoRunRefresh: vi.fn(),
			startBatchRun: vi.fn(),
			stopBatchRun: vi.fn(),
			resumeAfterError: vi.fn(),
			skipCurrentDocument: vi.fn(),
			abortBatchOnError: vi.fn(),
		} as any)
	);

	return { setActiveSessionId, setSessions, handleOpenFileTab };
}

/** Run the reducer that setSessions was called with against the given state. */
function applyUpdate(setSessions: Mock, sessions: Session[]): Session[] {
	const updater = setSessions.mock.calls[0][0] as (prev: Session[]) => Session[];
	return updater(sessions);
}

beforeEach(() => {
	vi.clearAllMocks();
	(window as any).maestro = {
		fs: {
			readFile: vi.fn().mockResolvedValue('file contents'),
			stat: vi.fn().mockResolvedValue({ modifiedAt: 0 }),
		},
		process: {
			sendRemoteOpenTerminalTabResponse: vi.fn(),
			sendRemoteCreateSessionResponse: vi.fn(),
		},
	};
});

describe('maestro:openFileTab --background', () => {
	function dispatch(detail: Record<string, unknown>) {
		window.dispatchEvent(new CustomEvent('maestro:openFileTab', { detail }));
	}

	it('leaves the active agent alone and asks for a background tab', async () => {
		const sessions = [createMockSession({ id: 'session-1', cwd: '/repo' })];
		const { setActiveSessionId, handleOpenFileTab } = setup(sessions);

		dispatch({ sessionId: 'session-1', filePath: '/repo/a.ts', background: true });
		await vi.waitFor(() => expect(handleOpenFileTab).toHaveBeenCalled());

		expect(setActiveSessionId).not.toHaveBeenCalled();
		expect(handleOpenFileTab.mock.calls[0][1]).toEqual({
			targetSessionId: 'session-1',
			background: true,
		});
	});

	it('still switches agents and activates the tab without the flag', async () => {
		const sessions = [createMockSession({ id: 'session-1', cwd: '/repo' })];
		const { setActiveSessionId, handleOpenFileTab } = setup(sessions);

		dispatch({ sessionId: 'session-1', filePath: '/repo/a.ts' });
		await vi.waitFor(() => expect(handleOpenFileTab).toHaveBeenCalled());

		expect(setActiveSessionId).toHaveBeenCalledWith('session-1');
		expect(handleOpenFileTab.mock.calls[0][1].background).toBeUndefined();
	});

	// --no-switch is deliberately weaker: it suppresses the agent switch and
	// still activates the tab inside that agent, which is why the two flags
	// coexist instead of one being folded into the other.
	it('does not turn --no-switch into a background open', async () => {
		const sessions = [createMockSession({ id: 'session-1', cwd: '/repo' })];
		const { setActiveSessionId, handleOpenFileTab } = setup(sessions);

		dispatch({ sessionId: 'session-1', filePath: '/repo/a.ts', switchToAgent: false });
		await vi.waitFor(() => expect(handleOpenFileTab).toHaveBeenCalled());

		expect(setActiveSessionId).not.toHaveBeenCalled();
		expect(handleOpenFileTab.mock.calls[0][1].background).toBeUndefined();
	});
});

describe('maestro:openTerminalTab --background', () => {
	function dispatch(detail: Record<string, unknown>) {
		window.dispatchEvent(new CustomEvent('maestro:openTerminalTab', { detail }));
	}

	it('creates the tab without focusing it or flipping the agent into terminal mode', () => {
		const sessions = [
			createMockSession({
				id: 'session-1',
				inputMode: 'ai',
				activeTerminalTabId: 'existing-term',
			}),
		];
		const { setActiveSessionId, setSessions } = setup(sessions);

		dispatch({ sessionId: 'session-1', config: { background: true }, responseChannel: 'ch' });

		expect(setActiveSessionId).not.toHaveBeenCalled();
		const [updated] = applyUpdate(setSessions, sessions);
		// The tab exists and is addressable...
		expect(updated.terminalTabs).toHaveLength(1);
		// ...but nothing the user is looking at moved. inputMode matters as much
		// as the tab pointer here: flipping it swaps the whole rendered surface.
		expect(updated.activeTerminalTabId).toBe('existing-term');
		expect(updated.inputMode).toBe('ai');
	});

	it('still focuses and switches to terminal mode without the flag', () => {
		const sessions = [
			createMockSession({
				id: 'session-1',
				inputMode: 'ai',
				activeTerminalTabId: 'existing-term',
			}),
		];
		const { setActiveSessionId, setSessions } = setup(sessions);

		dispatch({ sessionId: 'session-1', config: {}, responseChannel: 'ch' });

		expect(setActiveSessionId).toHaveBeenCalledWith('session-1');
		const [updated] = applyUpdate(setSessions, sessions);
		expect(updated.terminalTabs).toHaveLength(1);
		expect(updated.activeTerminalTabId).toBe(updated.terminalTabs![0].id);
		expect(updated.inputMode).toBe('terminal');
	});

	it('acks the tab id either way so send-terminal --tab works immediately', () => {
		const sessions = [createMockSession({ id: 'session-1' })];
		const { setSessions } = setup(sessions);

		dispatch({ sessionId: 'session-1', config: { background: true }, responseChannel: 'ch' });

		const ack = (window as any).maestro.process.sendRemoteOpenTerminalTabResponse as Mock;
		expect(ack).toHaveBeenCalledWith('ch', true, expect.any(String));
		// Created-but-unreachable would be a different bug wearing this flag's
		// name, so pin the acked id to a tab that really exists.
		const [updated] = applyUpdate(setSessions, sessions);
		expect(updated.terminalTabs![0].id).toBe(ack.mock.calls[0][2]);
	});
});

describe('maestro:remoteCreateSession --background', () => {
	function dispatch(detail: Record<string, unknown>) {
		window.dispatchEvent(new CustomEvent('maestro:remoteCreateSession', { detail }));
	}

	beforeEach(() => {
		(window as any).maestro.agents = { get: vi.fn().mockResolvedValue({ id: 'claude-code' }) };
		(window as any).maestro.stats = { recordSessionCreated: vi.fn() };
		(window as any).maestro.sessions = { setMany: vi.fn().mockResolvedValue(undefined) };
	});

	it('adds the agent to the Left Bar without selecting it', async () => {
		const { setActiveSessionId, setSessions } = setup([]);

		dispatch({
			name: 'Helper',
			toolType: 'claude-code',
			cwd: '/repo',
			responseChannel: 'ch',
			background: true,
		});

		await vi.waitFor(() =>
			expect(
				(window as any).maestro.process.sendRemoteCreateSessionResponse as Mock
			).toHaveBeenCalled()
		);
		// The agent really exists (the caller gets an id back and can dispatch to
		// it), the user's Left Bar selection just did not move.
		expect(setSessions).toHaveBeenCalled();
		expect(setActiveSessionId).not.toHaveBeenCalled();
	});

	it('still focuses the new agent without the flag', async () => {
		const { setActiveSessionId } = setup([]);

		dispatch({ name: 'Helper', toolType: 'claude-code', cwd: '/repo', responseChannel: 'ch' });

		await vi.waitFor(() => expect(setActiveSessionId).toHaveBeenCalled());
	});
});
