/**
 * Tests for collectActiveOperations.ts - the single source of truth for "is
 * Maestro busy right now?" shared by the quit-confirmation check and the
 * "Quit when idle" watcher. Covers each operation source independently, the
 * feedback-draft carve-out (reported but never counts as an operation), and
 * graceful degradation when the IPC probes fail.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BatchRunState, GroupChat } from '../../../renderer/types';

// Stub the IPC surface before importing the module under test. Per-test bodies
// reassign these mocks to shape process / Cue activity.
const mockGetActiveProcesses = vi.fn();
const mockGetActiveCueRuns = vi.fn();
vi.stubGlobal('window', {
	maestro: {
		process: { getActiveProcesses: mockGetActiveProcesses },
		cue: { getActiveRuns: mockGetActiveCueRuns },
	},
});

import { collectActiveOperations } from '../../../renderer/utils/collectActiveOperations';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useBatchStore } from '../../../renderer/stores/batchStore';
import { useGroupChatStore } from '../../../renderer/stores/groupChatStore';
import { useFeedbackDraftStore } from '../../../renderer/stores/feedbackDraftStore';
import { createMockSession } from '../../helpers/mockSession';

/** Minimal BatchRunState - the selector only reads isRunning + errorPaused. */
function runningBatch(overrides: Partial<BatchRunState> = {}): BatchRunState {
	return { isRunning: true, errorPaused: false, ...overrides } as BatchRunState;
}

beforeEach(() => {
	vi.clearAllMocks();
	// Default: every probe reports nothing running.
	mockGetActiveProcesses.mockResolvedValue([]);
	mockGetActiveCueRuns.mockResolvedValue([]);
	useSessionStore.setState({ sessions: [], activeSessionId: '' });
	useBatchStore.setState({ batchRunStates: {} });
	useGroupChatStore.setState({
		groupChats: [],
		activeGroupChatId: null,
		groupChatStates: new Map(),
		groupChatState: 'idle',
		participantStates: new Map(),
		allGroupChatParticipantStates: new Map(),
	});
	useFeedbackDraftStore.setState({ hasDraft: false });
});

describe('collectActiveOperations', () => {
	it('reports a fully idle app with no active operations', async () => {
		const ops = await collectActiveOperations();
		expect(ops.hasActiveOperations).toBe(false);
		expect(ops.busyAgentCount).toBe(0);
		expect(ops.activeBatchSessionIds).toEqual([]);
		expect(ops.activeTerminalTasks).toEqual([]);
		expect(ops.activeCueRunCount).toBe(0);
		expect(ops.activeGroupChatCount).toBe(0);
		expect(ops.hasFeedbackDraft).toBe(false);
	});

	it('counts thinking AI agents but excludes terminal-driven busy state', async () => {
		useSessionStore.setState({
			sessions: [
				createMockSession({ id: 'a', state: 'busy', busySource: 'ai', toolType: 'claude-code' }),
				// Busy because of a terminal command, not an AI turn -> not counted.
				createMockSession({ id: 'b', state: 'busy', busySource: 'ai', toolType: 'terminal' }),
				createMockSession({ id: 'c', state: 'idle' }),
			],
		});
		const ops = await collectActiveOperations();
		expect(ops.busyAgentCount).toBe(1);
		expect(ops.hasActiveOperations).toBe(true);
	});

	it('reports active Auto Run batches from the batch store', async () => {
		useBatchStore.setState({
			batchRunStates: {
				s1: runningBatch(),
				// error-paused batches are stopped, so they do not count as active.
				s2: runningBatch({ errorPaused: true }),
				s3: runningBatch({ isRunning: false }),
			},
		});
		const ops = await collectActiveOperations();
		expect(ops.activeBatchSessionIds).toEqual(['s1']);
		expect(ops.hasActiveOperations).toBe(true);
	});

	it('formats running terminal tasks as "agent: command"', async () => {
		useSessionStore.setState({
			sessions: [createMockSession({ id: 'sess', name: 'rc' })],
		});
		mockGetActiveProcesses.mockResolvedValue([
			{
				sessionId: 'sess-terminal-1',
				isTerminal: true,
				childProcesses: [{ pid: 1, command: '/usr/bin/npm test' }],
			},
			// No children -> nothing to report.
			{ sessionId: 'sess-terminal-2', isTerminal: true, childProcesses: [] },
		]);
		const ops = await collectActiveOperations();
		expect(ops.activeTerminalTasks).toEqual(['rc: npm test']);
		expect(ops.hasActiveOperations).toBe(true);
	});

	it('counts in-flight Maestro Cue runs', async () => {
		mockGetActiveCueRuns.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
		const ops = await collectActiveOperations();
		expect(ops.activeCueRunCount).toBe(2);
		expect(ops.hasActiveOperations).toBe(true);
	});

	it('counts every non-idle room the user still has', async () => {
		useGroupChatStore.setState({
			groupChats: [{ id: 'room-a' }, { id: 'room-b' }, { id: 'room-c' }] as GroupChat[],
			groupChatStates: new Map([
				['room-a', 'moderator-thinking'],
				['room-b', 'agent-working'],
				['room-c', 'idle'],
			]),
			groupChatState: 'idle',
		});
		const ops = await collectActiveOperations();
		expect(ops.activeGroupChatCount).toBe(2);
		expect(ops.hasActiveOperations).toBe(true);
	});

	it('uses the live active-room state rather than the mirrored map', async () => {
		// The active room's truth is `groupChatState`; every other room is
		// mirrored into `groupChatStates`. Reading the wrong one of the pair gets
		// the answer wrong for half the list.
		useGroupChatStore.setState({
			groupChats: [{ id: 'room-a' }] as GroupChat[],
			activeGroupChatId: 'room-a',
			groupChatStates: new Map(),
			groupChatState: 'agent-working',
		});
		const ops = await collectActiveOperations();
		expect(ops.activeGroupChatCount).toBe(1);
		expect(ops.hasActiveOperations).toBe(true);
	});

	// The state maps are keyed by every room ever seen and outlive a deleted
	// one. Counting their values reported chats that no longer exist as running,
	// so quitting warned about work that could not possibly be in flight.
	it('ignores a stale state entry for a room the user no longer has', async () => {
		useGroupChatStore.setState({
			groupChats: [],
			groupChatStates: new Map([['deleted-room', 'agent-working']]),
			groupChatState: 'idle',
		});
		const ops = await collectActiveOperations();
		expect(ops.activeGroupChatCount).toBe(0);
		expect(ops.hasActiveOperations).toBe(false);
	});

	// The mirror-image bug: the old loop read only the moderator state, so a
	// room whose moderator had finished while its agents were still working
	// counted as idle - and Quit When Idle would quit mid-turn.
	it('counts a room whose moderator is idle but whose participant is working', async () => {
		useGroupChatStore.setState({
			groupChats: [{ id: 'room-a' }] as GroupChat[],
			activeGroupChatId: null,
			groupChatStates: new Map([['room-a', 'idle']]),
			allGroupChatParticipantStates: new Map([['room-a', new Map([['Atlas', 'working']])]]),
			groupChatState: 'idle',
		});
		const ops = await collectActiveOperations();
		expect(ops.activeGroupChatCount).toBe(1);
		expect(ops.hasActiveOperations).toBe(true);
	});

	it('reports a feedback draft but never treats it as an active operation', async () => {
		useFeedbackDraftStore.setState({ hasDraft: true });
		const ops = await collectActiveOperations();
		expect(ops.hasFeedbackDraft).toBe(true);
		// A draft never finishes on its own, so it must not block an idle-quit.
		expect(ops.hasActiveOperations).toBe(false);
	});

	it('degrades to "nothing running" when the IPC probes reject', async () => {
		mockGetActiveProcesses.mockRejectedValue(new Error('process bridge down'));
		mockGetActiveCueRuns.mockRejectedValue(new Error('cue engine off'));
		const ops = await collectActiveOperations();
		expect(ops.activeTerminalTasks).toEqual([]);
		expect(ops.activeCueRunCount).toBe(0);
		expect(ops.hasActiveOperations).toBe(false);
	});
});
