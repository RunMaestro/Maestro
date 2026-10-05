import { describe, expect, it } from 'vitest';

import { parseAutoRunProgress } from '../../autorun/progress';
import { parseProcessFrame } from '../../client/bridge-frames';
import type { MaestroEvent, TurnEvent } from '../../client/types';
import {
	makeGroupChatLine,
	parseGroupChatFrame,
	parseGroupChatRecord,
	type GroupChatEvent,
	type GroupChatRecord,
} from '../../groupchat/chat';
import {
	createFrameState,
	framesForEvent,
	groupChatToWire,
	progressToWire,
	tabProcessId,
	type Frame,
} from '../server-frames';

const turn = (event: TurnEvent): MaestroEvent => ({
	type: 'turn',
	agentId: 'a1',
	tabId: 't1',
	event,
});

/** Run a frame through the client's own parser, as the TUI would. */
function parsed(frame: Frame) {
	return parseProcessFrame(frame.channel as string, frame.args as unknown[]);
}

describe('progressToWire', () => {
	it('round-trips through the client parser', () => {
		const progress = parseAutoRunProgress({
			isRunning: true,
			isStopping: false,
			totalTasks: 3,
			completedTasks: 1,
			currentTaskIndex: 1,
			documents: ['one', 'two'],
			currentDocumentIndex: 1,
			currentDocTasksTotal: 3,
			currentDocTasksCompleted: 1,
			totalTasksAcrossAllDocs: 5,
			completedTasksAcrossAllDocs: 2,
			loopEnabled: true,
			loopIteration: 2,
			startTime: 99,
			worktreeBranch: 'wt',
			errorPaused: true,
			errorMessage: 'rate limited',
			errorType: 'rate_limit',
			errorRecoverable: true,
			errorTaskDescription: 'task',
			errorDocumentIndex: 1,
		});
		expect(progress).not.toBeNull();
		expect(parseAutoRunProgress(progressToWire(progress!))).toEqual(progress);
	});

	it('round-trips a goal run', () => {
		const progress = parseAutoRunProgress({
			isRunning: true,
			totalTasks: 0,
			completedTasks: 0,
			currentTaskIndex: 0,
			goalMode: true,
			goalProgress: 40,
			goalRationale: 'half way',
			goalIteration: 2,
		});
		expect(parseAutoRunProgress(progressToWire(progress!))).toEqual(progress);
	});
});

describe('framesForEvent', () => {
	it('sends a turn event as the process channel the client parses back', () => {
		const state = createFrameState();
		const id = tabProcessId('a1', 't1');
		const at = 1;

		const text = framesForEvent(turn({ kind: 'text', at, text: 'hello' }), state);
		expect(parsed(text[0])).toEqual({
			target: { kind: 'tab', agentId: 'a1', tabId: 't1' },
			frame: { kind: 'stream', event: { kind: 'text', text: 'hello' } },
		});

		const tool = framesForEvent(
			turn({
				kind: 'tool',
				at,
				tool: { id: 'c1', name: 'Read', status: 'completed', detail: { input: { path: 'x' } } },
			}),
			state
		);
		expect(parsed(tool[0])?.frame).toEqual({
			kind: 'stream',
			event: {
				kind: 'tool',
				tool: {
					name: 'Read',
					status: 'completed',
					id: 'c1',
					detail: { input: { path: 'x' }, status: 'completed' },
				},
			},
		});

		const session = framesForEvent(turn({ kind: 'session', at, providerSessionId: 'p1' }), state);
		expect(session[0]).toMatchObject({ channel: 'process:session-id', args: [id, 'p1'] });
	});

	it('ends a turn with an exit, and a stop reads as a signal', () => {
		const state = createFrameState();
		const done = framesForEvent(
			turn({ kind: 'outcome', at: 1, outcome: 'completed', exitCode: 0 }),
			state
		);
		expect(parsed(done[0])?.frame).toEqual({ kind: 'exit', exitCode: 0, signal: null });

		const stopped = framesForEvent(
			turn({ kind: 'outcome', at: 2, outcome: 'interrupted', exitCode: null }),
			state
		);
		expect(parsed(stopped[0])?.frame).toEqual({ kind: 'exit', exitCode: null, signal: 'SIGINT' });
	});

	it('reports an outcome error once', () => {
		const state = createFrameState();
		const error = { type: 'auth_expired', message: 'x', recoverable: true, timestamp: 1 } as never;
		const seen = framesForEvent(turn({ kind: 'error', at: 1, error }), state);
		expect(seen).toHaveLength(1);
		const ended = framesForEvent(
			turn({ kind: 'outcome', at: 2, outcome: 'crashed', exitCode: 1, error }),
			state
		);
		expect(ended.map((frame) => frame.channel)).toEqual(['process:exit']);

		// An error only the outcome carries is still said, before the exit.
		const lone = framesForEvent(
			turn({ kind: 'outcome', at: 3, outcome: 'crashed', exitCode: 1, error }),
			createFrameState()
		);
		expect(lone.map((frame) => frame.channel)).toEqual(['agent:error', 'process:exit']);
	});

	it('says nothing for a turn start, a gap, or a tab change', () => {
		const state = createFrameState();
		expect(framesForEvent(turn({ kind: 'started', at: 1 }), state)).toEqual([]);
		expect(framesForEvent(turn({ kind: 'gap', at: 1 }), state)).toEqual([]);
		expect(
			framesForEvent({ type: 'tab.updated', agentId: 'a1', tab: { id: 't1' } }, state)
		).toEqual([]);
	});

	it('pushes an agent as a lifecycle upsert and a removal as session_removed', () => {
		const state = createFrameState();
		const agent = { id: 'a1', name: 'Alpha', toolType: 'claude-code' };
		expect(framesForEvent({ type: 'agent.updated', agent }, state)).toEqual([
			{
				type: 'bridge.event',
				channel: 'sessions:lifecycleSync',
				args: [{ added: [agent], removedIds: [] }],
			},
		]);
		expect(framesForEvent({ type: 'agent.removed', agentId: 'a1' }, state)).toEqual([
			{ type: 'session_removed', sessionId: 'a1' },
		]);
	});

	it('pushes a run as autorun_state, output, and usage on its batch process', () => {
		const state = createFrameState();
		const progress = parseAutoRunProgress({
			isRunning: true,
			totalTasks: 1,
			completedTasks: 0,
			currentTaskIndex: 0,
		});
		const [frame] = framesForEvent(
			{ type: 'autorun', agentId: 'a1', event: { kind: 'state', at: 1, state: progress } },
			state
		);
		expect(frame).toMatchObject({ type: 'autorun_state', sessionId: 'a1' });
		expect(
			framesForEvent(
				{ type: 'autorun', agentId: 'a1', event: { kind: 'state', at: 2, state: null } },
				state
			)[0]
		).toEqual({ type: 'autorun_state', sessionId: 'a1', state: null });
		expect(
			framesForEvent(
				{
					type: 'autorun',
					agentId: 'a1',
					event: { kind: 'output', at: 3, processId: 'a1-batch-5', text: 'ticking' },
				},
				state
			)[0]
		).toEqual({ type: 'bridge.event', channel: 'process:data', args: ['a1-batch-5', 'ticking'] });
	});
});

describe('group chats', () => {
	const chat: GroupChatRecord = {
		id: 'c1',
		name: 'Release review',
		moderatorProvider: 'claude-code',
		participants: [{ sessionId: 's-a', name: 'Alpha', provider: 'codex' }],
		state: 'agent-working',
		working: ['Alpha'],
		archived: false,
		lines: [
			makeGroupChatLine('user', 'Ship it?', 1_000),
			makeGroupChatLine('Alpha', 'Yes.', 2_000),
		],
	};

	it('projects a chat the way the desktop bridge reports it, and the client reads it back', () => {
		const read = parseGroupChatRecord(groupChatToWire(chat));

		expect(read).toMatchObject({
			id: 'c1',
			name: 'Release review',
			moderatorProvider: 'claude-code',
			state: 'agent-working',
			archived: false,
			participants: chat.participants,
		});
		// The lines survive with the same identity, so a snapshot and a push of one line agree.
		expect(read?.lines.map((line) => line.id)).toEqual(chat.lines.map((line) => line.id));
	});

	it('marks the user’s lines as the user’s and everyone else’s as the assistant’s', () => {
		const wire = groupChatToWire(chat) as { messages: Array<{ role: string }> };
		expect(wire.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
	});

	/** Every event, as a frame, through the client's own parser. */
	const roundTrip = (event: GroupChatEvent): GroupChatEvent | undefined => {
		const [frame] = framesForEvent({ type: 'groupChat', chatId: 'c1', event }, createFrameState());
		if (!frame) return undefined;
		const parsed = parseGroupChatFrame(frame.channel as string, frame.args as unknown[], event.at);
		expect(parsed?.chatId).toBe('c1');
		return parsed?.event;
	};

	it.each<GroupChatEvent>([
		{ kind: 'message', at: 5_000, line: makeGroupChatLine('Beta', 'Looks fine.', 5_000) },
		{ kind: 'state', at: 5_000, state: 'moderator-thinking' },
		{ kind: 'participant', at: 5_000, name: 'Alpha', working: true },
		{ kind: 'participant', at: 5_000, name: 'Alpha', working: false },
		{
			kind: 'participants',
			at: 5_000,
			participants: [{ sessionId: 's-a', name: 'Alpha', provider: 'codex' }],
		},
	])('sends a $kind event the client reads as the same event', (event) => {
		expect(roundTrip(event)).toEqual(event);
	});

	it('sends nothing for a gap: that is the client’s own signal', () => {
		expect(
			framesForEvent(
				{ type: 'groupChat', chatId: 'c1', event: { kind: 'gap', at: 1 } },
				createFrameState()
			)
		).toEqual([]);
	});
});
