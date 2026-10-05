/**
 * @file router.test.ts
 * @description The group chat engine, over fake ports and a real store on a temp dir.
 *
 * The desktop's binding of the engine is covered by
 * `src/__tests__/main/group-chat/group-chat-router.test.ts`. These tests pin what
 * is true of the engine itself, with no Electron and no process manager: what a
 * finished turn means (`turnEnded`), and the fixes that rode the move out of the
 * desktop (`Plans/maestro-tui-group-chat.md` GD23).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createGroupChatEngine } from '../router';
import { createGroupChatStore, type GroupChatStore } from '../storage';
import { createGroupChatTurnMetrics } from '../turn-metrics';
import { readLog } from '../log';
import { createSleepTracker } from '../../../sleepTracking';
import type {
	GroupChatEventSink,
	GroupChatLauncher,
	GroupChatSessionInfo,
	GroupChatSpawn,
} from '../types';

const NO_OUTPUT = { rawOutput: '', exitCode: 0 };

interface Harness {
	dir: string;
	store: GroupChatStore;
	engine: ReturnType<typeof createGroupChatEngine>;
	launcher: GroupChatLauncher;
	/** Every spawn the engine asked the runner to start, in order. */
	spawns: GroupChatSpawn[];
	/** Every id the engine asked the runner to stop. */
	stops: string[];
	messages: Array<{ chatId: string; from: string; content: string }>;
	/** Every participant whose Auto Run badge the engine asked the host to clear. */
	batchComplete: string[];
	states: Array<{ chatId: string; state: string }>;
	participantStates: Array<{ name: string; state: string }>;
	historyTypes: string[];
	power: { block: ReturnType<typeof vi.fn>; unblock: ReturnType<typeof vi.fn> };
	sessions: GroupChatSessionInfo[];
	/** Make the next `start` answer something other than success. */
	nextStart: { value: unknown };
}

function createHarness(dir: string): Harness {
	const store = createGroupChatStore({ groupChatsDir: () => dir });
	const messages: Harness['messages'] = [];
	const states: Harness['states'] = [];
	const participantStates: Harness['participantStates'] = [];
	const historyTypes: string[] = [];
	const batchComplete: string[] = [];
	const spawns: GroupChatSpawn[] = [];
	const stops: string[] = [];
	const sessions: GroupChatSessionInfo[] = [];
	const nextStart: Harness['nextStart'] = { value: undefined };
	const power = { block: vi.fn(), unblock: vi.fn() };
	const tracker = createSleepTracker();

	const events: GroupChatEventSink = {
		message: (chatId, m) => messages.push({ chatId, from: m.from, content: m.content }),
		stateChange: (chatId, state) => states.push({ chatId, state }),
		participantsChanged: vi.fn(),
		moderatorUsage: vi.fn(),
		historyEntry: (_chatId, entry) => historyTypes.push(entry.type),
		participantState: (_chatId, name, state) => participantStates.push({ name, state }),
		moderatorSessionIdChanged: vi.fn(),
		autoRunTriggered: vi.fn(),
		autoRunBatchComplete: (_chatId, name) => batchComplete.push(name),
		participantLiveOutput: vi.fn(),
	};

	const engine = createGroupChatEngine({
		store,
		events,
		agents: {
			list: () => sessions,
			providerConfig: () => ({}),
			providerEnvVars: () => undefined,
			conductorProfile: () => 'a conductor',
			sshStore: () => null,
		},
		prompts: {
			get: (id) =>
				`[${id}] {{PARTICIPANT_NAME}} {{GROUP_CHAT_NAME}} {{MESSAGE}} {{CONDUCTOR_PROFILE}}`,
		},
		power,
		metrics: createGroupChatTurnMetrics({
			spans: { begin: tracker.beginSpan, elapsedMs: tracker.elapsedMs },
		}),
	});

	const launcher: GroupChatLauncher = {
		runner: {
			start: async (spawn) => {
				spawns.push(spawn);
				if (nextStart.value !== undefined) {
					const answer = nextStart.value;
					nextStart.value = undefined;
					if (answer instanceof Error) throw answer;
					return answer as { success: boolean; error?: string };
				}
				return { success: true, pid: 4242 };
			},
			stop: (processId) => {
				stops.push(processId);
			},
		},
		resolveAgent: async (providerId) =>
			({
				id: providerId,
				name: 'Claude Code',
				binaryName: 'claude',
				command: 'claude',
				args: ['--print', '--verbose', '--output-format', 'stream-json'],
				available: true,
				path: '/usr/local/bin/claude',
				capabilities: {},
			}) as never,
	};

	return {
		dir,
		store,
		engine,
		launcher,
		spawns,
		stops,
		messages,
		batchComplete,
		states,
		participantStates,
		historyTypes,
		power,
		sessions,
		nextStart,
	};
}

describe('group chat engine', () => {
	let dir: string;
	let h: Harness;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'group-chat-engine-'));
		h = createHarness(dir);
	});

	afterEach(async () => {
		vi.useRealTimers();
		await fs.rm(dir, { recursive: true, force: true });
	});

	/** A chat with its moderator registered and the named participants added. */
	async function chatWith(...names: string[]) {
		const chat = await h.store.createGroupChat('Room', 'claude-code');
		await h.engine.spawnModerator(chat);
		for (const name of names) await h.engine.addParticipant(chat.id, name, 'claude-code');
		return chat;
	}

	/** Moderator hands off to the named participants; returns the process ids it started. */
	async function delegateTo(chatId: string, ...names: string[]) {
		const before = h.spawns.length;
		await h.engine.routeModeratorResponse(
			chatId,
			names.map((n) => `@${n}: please look at this`).join('\n'),
			h.launcher
		);
		return h.spawns.slice(before).map((s) => s.processId);
	}

	const moderatorSpawns = () => h.spawns.filter((s) => s.processId.includes('-moderator-'));
	const lastState = (chatId: string) => h.states.filter((s) => s.chatId === chatId).at(-1)?.state;

	describe('a participant turn ends', () => {
		it('counts a participant that exited non-zero after emitting text as responded (B1)', async () => {
			const chat = await chatWith('Alice');
			const [alice] = await delegateTo(chat.id, 'Alice');
			h.spawns.length = 0;

			await h.engine.turnEnded(
				{ processId: alice, text: 'Partial findings before the crash.', exitCode: 137 },
				h.launcher
			);

			// The text is the reply: logged under the participant's name...
			const log = await readLog(chat.logPath);
			expect(log.some((m) => m.from === 'Alice' && m.content.includes('Partial findings'))).toBe(
				true
			);
			expect(h.historyTypes).toContain('response');
			// ...and, as the only pending participant, it releases the synthesis
			expect(moderatorSpawns()).toHaveLength(1);
			expect(h.engine.markParticipantResponded(chat.id, 'Alice')).toBe(false);
		});

		it('never reads the exit code: the same text routes the same at exit 0 and exit 1', async () => {
			const chat = await chatWith('Alice', 'Bob');
			const [alice, bob] = await delegateTo(chat.id, 'Alice', 'Bob');

			await h.engine.turnEnded({ processId: alice, text: 'Alice done', exitCode: 0 }, h.launcher);
			await h.engine.turnEnded({ processId: bob, text: 'Bob done', exitCode: 1 }, h.launcher);

			const log = await readLog(chat.logPath);
			expect(log.filter((m) => m.from === 'Alice' || m.from === 'Bob')).toHaveLength(2);
		});

		it('closes out a participant that returned nothing without logging a reply (B2)', async () => {
			const chat = await chatWith('Alice');
			const [alice] = await delegateTo(chat.id, 'Alice');
			h.spawns.length = 0;
			h.historyTypes.length = 0;

			await h.engine.turnEnded({ processId: alice, ...NO_OUTPUT }, h.launcher);

			const log = await readLog(chat.logPath);
			expect(log.some((m) => m.from === 'Alice')).toBe(false);
			expect(h.historyTypes).not.toContain('response');
			// Synthesis proceeds without it
			expect(moderatorSpawns()).toHaveLength(1);
		});

		it('treats whitespace-only text as no reply', async () => {
			const chat = await chatWith('Alice');
			const [alice] = await delegateTo(chat.id, 'Alice');
			h.spawns.length = 0;

			await h.engine.turnEnded({ processId: alice, text: '  \n ', exitCode: 0 }, h.launcher);

			expect((await readLog(chat.logPath)).some((m) => m.from === 'Alice')).toBe(false);
			expect(moderatorSpawns()).toHaveLength(1);
		});

		it('starts the synthesis only when the LAST pending participant ends (B4)', async () => {
			const chat = await chatWith('Alice', 'Bob');
			const [alice, bob] = await delegateTo(chat.id, 'Alice', 'Bob');
			h.spawns.length = 0;

			await h.engine.turnEnded({ processId: alice, text: 'Alice done' }, h.launcher);
			expect(moderatorSpawns()).toHaveLength(0);
			expect(lastState(chat.id)).toBe('agent-working');

			await h.engine.turnEnded({ processId: bob, text: 'Bob done' }, h.launcher);
			expect(moderatorSpawns()).toHaveLength(1);
			expect(moderatorSpawns()[0].readOnlyMode).toBe(true);
			expect(lastState(chat.id)).toBe('moderator-thinking');
		});

		it('reads the text through readText with the participant provider once the chat loads', async () => {
			const chat = await chatWith('Alice');
			const [alice] = await delegateTo(chat.id, 'Alice');
			const readText = vi.fn(() => 'Reply read from the buffer');

			await h.engine.turnEnded(
				{ processId: alice, rawOutput: '{"type":"text"}', readText, exitCode: 0 },
				h.launcher
			);

			expect(readText).toHaveBeenCalledWith('claude-code');
			expect(
				(await readLog(chat.logPath)).some((m) => m.content === 'Reply read from the buffer')
			).toBe(true);
		});

		it('marks the participant done when the chat load fails, and still routes the reply (GD23 e)', async () => {
			const chat = await chatWith('Alice');
			const [alice] = await delegateTo(chat.id, 'Alice');
			h.spawns.length = 0;

			// Fail the engine's first load of this turn only; the fallback path routes normally
			const original = h.store.loadGroupChat;
			let failed = false;
			const failingStore = Object.assign(h.store, {
				loadGroupChat: async (id: string) => {
					if (!failed) {
						failed = true;
						throw new Error('EIO: transient');
					}
					return original(id);
				},
			});
			expect(failingStore).toBe(h.store);

			await h.engine.turnEnded(
				{ processId: alice, text: 'Reply despite the I/O error', exitCode: 0 },
				h.launcher
			);
			h.store.loadGroupChat = original;

			// Before GD23 e the load sat outside the error handling and the participant stayed
			// pending until its ten minute budget fired
			expect(moderatorSpawns()).toHaveLength(1);
			expect(
				(await readLog(chat.logPath)).some((m) => m.content === 'Reply despite the I/O error')
			).toBe(true);
		});

		it('settles the room to idle, releasing the power block, when it cannot start a synthesis', async () => {
			const chat = await chatWith('Alice');
			const [alice] = await delegateTo(chat.id, 'Alice');
			h.power.unblock.mockClear();

			await h.engine.turnEnded({ processId: alice, text: 'Done' }); // no launcher

			expect(lastState(chat.id)).toBe('idle');
			expect(h.power.unblock).toHaveBeenCalledWith(`groupchat:${chat.id}`);
		});

		it('flips the participant card back to idle', async () => {
			const chat = await chatWith('Alice');
			const [alice] = await delegateTo(chat.id, 'Alice');

			await h.engine.turnEnded({ processId: alice, text: 'Done' }, h.launcher);

			expect(h.participantStates.at(-1)).toEqual({ name: 'Alice', state: 'idle' });
		});
	});

	describe('session recovery (B5)', () => {
		const SESSION_GONE = 'Error: No conversation found with session ID: 1234';

		it('respawns the participant with a fresh session and does not mark it yet', async () => {
			const chat = await chatWith('Alice');
			const [alice] = await delegateTo(chat.id, 'Alice');
			h.spawns.length = 0;

			await h.engine.turnEnded({ processId: alice, rawOutput: SESSION_GONE, text: '' }, h.launcher);

			expect(h.spawns).toHaveLength(1);
			expect(h.spawns[0].processId).toMatch(/-participant-Alice-recovery-\d+$/);
			expect(h.messages.some((m) => m.content.includes('Creating a new session'))).toBe(true);
			// Still pending: no synthesis has started
			expect(moderatorSpawns()).toHaveLength(0);
		});

		it('marks the participant when the recovery turn itself ends, never recovering twice', async () => {
			const chat = await chatWith('Alice');
			const [alice] = await delegateTo(chat.id, 'Alice');
			await h.engine.turnEnded({ processId: alice, rawOutput: SESSION_GONE, text: '' }, h.launcher);
			const recovery = h.spawns.at(-1)!.processId;
			h.spawns.length = 0;

			// The recovery turn reports the same error: no infinite loop, the participant is done
			await h.engine.turnEnded(
				{ processId: recovery, rawOutput: SESSION_GONE, text: '' },
				h.launcher
			);

			expect(h.spawns.filter((s) => s.processId.includes('-recovery-'))).toHaveLength(0);
			expect(moderatorSpawns()).toHaveLength(1);
		});

		it('marks the participant when the respawn throws', async () => {
			const chat = await chatWith('Alice');
			const [alice] = await delegateTo(chat.id, 'Alice');
			h.spawns.length = 0;
			h.nextStart.value = new Error('spawn failed');

			await h.engine.turnEnded({ processId: alice, rawOutput: SESSION_GONE, text: '' }, h.launcher);

			expect(h.messages.some((m) => m.content.includes('Failed to create new session'))).toBe(true);
			expect(moderatorSpawns()).toHaveLength(1);
		});
	});

	describe('a moderator turn ends', () => {
		async function startModeratorTurn(chatId: string) {
			await h.engine.routeUserMessage(chatId, 'What do you think?', h.launcher);
			return moderatorSpawns().at(-1)!.processId;
		}

		it('routes the moderator text and hands off to a mentioned participant', async () => {
			const chat = await chatWith('Alice');
			const moderator = await startModeratorTurn(chat.id);
			h.spawns.length = 0;

			await h.engine.turnEnded(
				{ processId: moderator, text: '@Alice: please review the plan', exitCode: 0 },
				h.launcher
			);

			expect(h.spawns).toHaveLength(1);
			expect(h.spawns[0].processId).toMatch(/-participant-Alice-\d+$/);
			expect(lastState(chat.id)).toBe('agent-working');
			expect((await readLog(chat.logPath)).some((m) => m.from === 'moderator')).toBe(true);
		});

		it('records a final answer and goes idle when the text mentions nobody', async () => {
			const chat = await chatWith('Alice');
			const moderator = await startModeratorTurn(chat.id);
			h.power.unblock.mockClear();

			await h.engine.turnEnded({ processId: moderator, text: 'Here is the answer.' }, h.launcher);

			expect(lastState(chat.id)).toBe('idle');
			expect(h.historyTypes).toContain('response');
			expect(h.power.unblock).toHaveBeenCalledWith(`groupchat:${chat.id}`);
		});

		it('says so, and releases the power block, when the process wrote nothing at all (B3, GD23 b)', async () => {
			const chat = await chatWith('Alice');
			const moderator = await startModeratorTurn(chat.id);
			h.power.unblock.mockClear();

			await h.engine.turnEnded({ processId: moderator, ...NO_OUTPUT }, h.launcher);

			expect(
				h.messages.some((m) => m.content.includes('Moderator exited without producing output'))
			).toBe(true);
			expect(lastState(chat.id)).toBe('idle');
			// Before GD23 b this idle emit left the power block held until some later settle
			expect(h.power.unblock).toHaveBeenCalledWith(`groupchat:${chat.id}`);
		});

		it('says so when output exists but holds no visible text (B3)', async () => {
			const chat = await chatWith('Alice');
			const moderator = await startModeratorTurn(chat.id);

			await h.engine.turnEnded(
				{ processId: moderator, rawOutput: '{"type":"system"}', readText: () => '   ' },
				h.launcher
			);

			expect(
				h.messages.some((m) => m.content.includes('Moderator produced no visible output'))
			).toBe(true);
			expect(lastState(chat.id)).toBe('idle');
		});

		it('reads the moderator text with the moderator provider', async () => {
			const chat = await chatWith();
			const moderator = await startModeratorTurn(chat.id);
			const readText = vi.fn(() => 'Plain answer');

			await h.engine.turnEnded({ processId: moderator, rawOutput: 'raw', readText }, h.launcher);

			expect(readText).toHaveBeenCalledWith('claude-code');
		});

		it('disarms the moderator silence budget when its turn ends', async () => {
			vi.useFakeTimers();
			const chat = await chatWith();
			const moderator = await startModeratorTurn(chat.id);
			await h.engine.turnEnded({ processId: moderator, text: 'Final.' }, h.launcher);
			h.messages.length = 0;

			await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

			expect(h.messages.some((m) => m.content.includes('went silent'))).toBe(false);
		});
	});

	describe('stopping the moderator (GD23 a)', () => {
		async function runningModerator(chatId: string) {
			await h.engine.routeUserMessage(chatId, 'Start something', h.launcher);
			return moderatorSpawns().at(-1)!.processId;
		}

		it('kills the running turn by its FULL id, not the per-chat prefix', async () => {
			const chat = await chatWith('Alice');
			const moderator = await runningModerator(chat.id);
			const prefix = h.engine.getModeratorSessionId(chat.id)!;
			expect(moderator).not.toBe(prefix);

			await h.engine.killModerator(chat.id);

			expect(h.stops).toContain(moderator);
			expect(h.stops).not.toContain(prefix);
		});

		it('still hands the caller the registered prefix, as before', async () => {
			const chat = await chatWith('Alice');
			await runningModerator(chat.id);
			const prefix = h.engine.getModeratorSessionId(chat.id)!;
			const control = { kill: vi.fn(() => true) };

			await h.engine.killModerator(chat.id, control);

			expect(control.kill).toHaveBeenCalledWith(prefix);
			expect(h.engine.isModeratorActive(chat.id)).toBe(false);
		});

		it('drops the stopped turn when it finally reports, so Stop cannot dispatch participants', async () => {
			const chat = await chatWith('Alice');
			const moderator = await runningModerator(chat.id);
			await h.engine.killModerator(chat.id);
			h.spawns.length = 0;
			h.messages.length = 0;

			await h.engine.turnEnded(
				{ processId: moderator, text: '@Alice: go ahead and edit everything' },
				h.launcher
			);

			expect(h.spawns).toHaveLength(0);
			expect(h.messages).toHaveLength(0);
			expect((await readLog(chat.logPath)).some((m) => m.from === 'moderator')).toBe(false);
		});

		it('disarms the moderator budget so a stopped room is not told it went silent later', async () => {
			vi.useFakeTimers();
			const chat = await chatWith('Alice');
			await runningModerator(chat.id);
			await h.engine.killModerator(chat.id);
			h.messages.length = 0;

			await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

			expect(h.messages.some((m) => m.content.includes('went silent'))).toBe(false);
		});

		it('is a no-op for the running turn when none is running', async () => {
			const chat = await chatWith('Alice');

			await h.engine.killModerator(chat.id);

			expect(h.stops).toHaveLength(0);
			expect(h.engine.isModeratorActive(chat.id)).toBe(false);
		});
	});

	describe('a start that fails', () => {
		it('disarms the moderator budget when its start throws (GD23 c)', async () => {
			vi.useFakeTimers();
			const chat = await chatWith();
			h.nextStart.value = new Error('cannot spawn');

			await expect(h.engine.routeUserMessage(chat.id, 'Hello', h.launcher)).rejects.toThrow(
				'Failed to spawn moderator'
			);
			h.messages.length = 0;
			await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

			// Left armed, the budget told the room a moderator that never ran "went silent"
			expect(h.messages.some((m) => m.content.includes('went silent'))).toBe(false);
			expect(lastState(chat.id)).toBe('idle');
		});

		it('disarms the budget when the synthesis start throws (GD23 c)', async () => {
			vi.useFakeTimers();
			const chat = await chatWith('Alice');
			const [alice] = await delegateTo(chat.id, 'Alice');
			h.nextStart.value = new Error('cannot spawn synthesis');

			await h.engine.turnEnded({ processId: alice, text: 'Done' }, h.launcher);
			// the synthesis start rejects asynchronously; let it settle
			await vi.advanceTimersByTimeAsync(0);
			h.messages.length = 0;
			await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

			expect(h.messages.some((m) => m.content.includes('went silent'))).toBe(false);
			expect(h.historyTypes).toContain('error');
			expect(lastState(chat.id)).toBe('idle');
		});

		it('closes a participant out when its start is refused without throwing (GD23 d)', async () => {
			const chat = await chatWith('Alice');
			h.nextStart.value = { success: false, error: 'working directory does not exist' };

			await h.engine.routeModeratorResponse(chat.id, '@Alice: take a look', h.launcher);

			// The participant is not left pending for its ten minute budget
			expect(h.historyTypes).toContain('error');
			expect(h.participantStates.at(-1)).toEqual({ name: 'Alice', state: 'idle' });
			expect(lastState(chat.id)).toBe('idle');
			expect(h.engine.markParticipantResponded(chat.id, 'Alice')).toBe(false);
		});
	});

	describe('a participant’s Auto Run ends (GD12)', () => {
		const summary = 'Auto Run complete: 2/2 tasks finished across 1 document(s).';

		it('logs the summary as the participant’s reply and clears its card and badge', async () => {
			const chat = await chatWith('Alice', 'Bob');
			await delegateTo(chat.id, 'Alice', 'Bob');
			h.messages.length = 0;

			await h.engine.autoRunCompleted(chat.id, 'Alice', summary, h.launcher);

			const log = await readLog(chat.logPath);
			expect(log.some((m) => m.from === 'Alice' && m.content === summary)).toBe(true);
			expect(h.participantStates.at(-1)).toEqual({ name: 'Alice', state: 'idle' });
			expect(h.batchComplete).toEqual(['Alice']);
		});

		it('waits for the others, and releases the synthesis when the last one ends', async () => {
			const chat = await chatWith('Alice', 'Bob');
			const [, bob] = await delegateTo(chat.id, 'Alice', 'Bob');
			h.spawns.length = 0;

			await h.engine.autoRunCompleted(chat.id, 'Alice', summary, h.launcher);
			expect(moderatorSpawns()).toHaveLength(0);

			// Bob finishes as an ordinary process; the Auto Run closes the round out all the same.
			await h.engine.turnEnded({ processId: bob, text: 'Bob is done.', exitCode: 0 }, h.launcher);
			expect(moderatorSpawns()).toHaveLength(1);
		});

		it('starts the synthesis when the Auto Run is the last to finish', async () => {
			const chat = await chatWith('Alice');
			await delegateTo(chat.id, 'Alice');
			h.spawns.length = 0;

			await h.engine.autoRunCompleted(chat.id, 'Alice', summary, h.launcher);

			expect(moderatorSpawns()).toHaveLength(1);
			expect(h.historyTypes).toContain('response');
		});

		it('settles the room to idle when no launcher can run the synthesis, and releases the power block', async () => {
			const chat = await chatWith('Alice');
			await delegateTo(chat.id, 'Alice');

			await h.engine.autoRunCompleted(chat.id, 'Alice', summary);

			expect(lastState(chat.id)).toBe('idle');
			expect(h.power.unblock).toHaveBeenCalledWith(`groupchat:${chat.id}`);
		});
	});

	describe('containment', () => {
		it('drops a group-chat-shaped id that is neither a moderator nor a participant', async () => {
			const chat = await chatWith('Alice');
			h.messages.length = 0;

			await h.engine.turnEnded(
				{ processId: `group-chat-${chat.id}-something-else-123`, text: 'noise' },
				h.launcher
			);

			expect(h.messages).toHaveLength(0);
			expect(h.spawns).toHaveLength(0);
			expect(await readLog(chat.logPath)).toHaveLength(0);
		});
	});
});
