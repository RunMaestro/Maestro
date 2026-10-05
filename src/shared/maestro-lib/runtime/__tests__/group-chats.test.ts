/**
 * The runtime's group chats (GC-1 to GC-5): a whole round with no desktop, over a fake provider.
 *
 * The provider is `src/__tests__/fixtures/fake-agent.mjs` replaying a synthesized Claude Code
 * stream, so a turn is a real process on a real pipe: the runtime plans the real process spec
 * (SSH, Claude token source, pipe spec) and starts it through the real run layer; only the command
 * is swapped. The runtime, its repository, the engine, and the chat's storage are real and write
 * to a temp data directory.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	createFakeGroupChatProvider,
	type FakeGroupChatProvider,
	type FakeScript,
} from '../../../../__tests__/shared/maestro-lib/run/fakeGroupChatProvider';
import { DEFAULT_TAB_DEFAULTS } from '../../agents/rules';
import type { ClientResult } from '../../client/types';
import type { GroupChatEvent, GroupChatRecord } from '../../groupchat/chat';
import { createMaestroRuntime, type MaestroRuntime, type RuntimeDeps } from '../index';

const T0 = Date.parse('2026-10-04T12:00:00Z');
const BUNDLED_PROMPTS = path.resolve(__dirname, '../../../../prompts');

function value<T>(result: ClientResult<T>): T {
	if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
	return result.value;
}
function errorOf(result: ClientResult<unknown>) {
	if (result.ok) throw new Error('expected a failure');
	return result.error;
}

const agentRecord = (
	id: string,
	name: string,
	cwd: string,
	extra: Record<string, unknown> = {}
) => ({
	id,
	name,
	toolType: 'claude-code',
	cwd,
	projectRoot: cwd,
	aiTabs: [{ id: `${id}-t1`, agentSessionId: null, name: null, logs: [] }],
	activeTabId: `${id}-t1`,
	unifiedTabOrder: [{ type: 'ai', id: `${id}-t1` }],
	...extra,
});

/** The round every test starts from: the moderator addresses both, each answers, the moderator closes. */
const ROUND: FakeScript = (call) => {
	switch (call.role) {
		case 'moderator':
			return { text: '@Alpha @Beta please look at this and report back.' };
		case 'participant':
			return { text: `${call.participant} says: looks good.` };
		case 'synthesis':
			return { text: 'Both agree it is ready.' };
		default:
			return { text: 'unexpected' };
	}
};

describe('runtime group chats', () => {
	let dir: string;
	let work: string;
	let open: MaestroRuntime[];
	let provider: FakeGroupChatProvider;
	let binaryExists: boolean;

	function deps(): Partial<RuntimeDeps> {
		let id = 0;
		let now = 1_000;
		return {
			pid: 100,
			now: () => T0,
			bootTime: () => T0 - 3_600_000,
			isPidAlive: (pid) => pid === 100,
			hostname: () => 'testhost',
			rules: { newId: () => `id-${++id}`, now: () => ++now, random: () => 0 },
			checkCwd: () => null,
			readTabDefaults: async () => DEFAULT_TAB_DEFAULTS,
			watchDirectory: () => ({ close: () => undefined }),
			probeBinary: async (binaryName) =>
				binaryExists ? { exists: true, path: `/fake/bin/${binaryName}` } : { exists: false },
			background: { runTurn: provider.runTurn },
		};
	}

	async function start(
		script: FakeScript = ROUND,
		sessions: unknown[] = [
			agentRecord('a1', 'Alpha', work),
			agentRecord('a2', 'Beta', work),
			agentRecord('a3', 'Gamma', work),
			agentRecord('a4', 'Shell', work, { toolType: 'terminal' }),
		]
	): Promise<MaestroRuntime> {
		provider = createFakeGroupChatProvider(work, script);
		fs.writeFileSync(
			path.join(dir, 'maestro-sessions.json'),
			JSON.stringify({ sessions, activeSessionId: 'a1' }, null, '\t')
		);
		const started = await createMaestroRuntime({
			dataDir: dir,
			mode: 'tui',
			deps: deps(),
			turns: { bundledPromptsDir: BUNDLED_PROMPTS },
		});
		if (!started.ok) throw new Error(`refused: ${started.refusal.message}`);
		open.push(started.runtime);
		return started.runtime;
	}

	/** Collect a chat's events, and let a test wait for a state or a line. */
	function watch(runtime: MaestroRuntime) {
		const events: Array<{ chatId: string; event: GroupChatEvent }> = [];
		runtime.events.subscribe(
			(event) => {
				if (event.type === 'groupChat') events.push({ chatId: event.chatId, event: event.event });
			},
			{ types: ['groupChat'] }
		);
		const of = (kind: GroupChatEvent['kind']) =>
			events.filter((entry) => entry.event.kind === kind).map((entry) => entry.event);
		return {
			events,
			states: () => of('state').map((event) => (event.kind === 'state' ? event.state : '')),
			lines: () =>
				of('message').flatMap((event) =>
					event.kind === 'message' ? [`${event.line.from}: ${event.line.text}`] : []
				),
			working: () =>
				of('participant').flatMap((event) =>
					event.kind === 'participant' ? [`${event.name}:${event.working ? 'on' : 'off'}`] : []
				),
			/** Resolves once the n-th time the room went idle. */
			idle: (count = 1) =>
				vi.waitFor(
					() => {
						if (
							events.filter((e) => e.event.kind === 'state' && e.event.state === 'idle').length <
							count
						) {
							throw new Error(
								`room not idle yet: ${of('state').map((e) => (e.kind === 'state' ? e.state : ''))}`
							);
						}
					},
					{ timeout: 10_000, interval: 20 }
				),
		};
	}

	const startChat = async (runtime: MaestroRuntime, extra: { message?: string } = {}) =>
		value(
			await runtime.groupChats.create({
				name: 'Release review',
				participantIds: ['a1', 'a2'],
				...extra,
			})
		).chatId;

	const readChat = async (runtime: MaestroRuntime, chatId: string): Promise<GroupChatRecord> =>
		value(await runtime.groupChats.get(chatId));

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-runtime-gc-'));
		work = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-runtime-gc-work-'));
		open = [];
		binaryExists = true;
	});
	afterEach(async () => {
		for (const runtime of open) await runtime.connection.close();
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(work, { recursive: true, force: true });
	});

	describe('a round (GC-1, GC-2)', () => {
		it('routes the opening message, collects both replies, and posts the synthesis', async () => {
			const runtime = await start();
			const chat = watch(runtime);

			const chatId = await startChat(runtime);
			await chat.idle();

			// The room moved: the moderator read it, the participants worked, the moderator closed it.
			// The synthesis is the moderator thinking again, before the room is free.
			expect(chat.states()).toEqual([
				'moderator-thinking',
				'agent-working',
				'moderator-thinking',
				'idle',
			]);
			expect(new Set(chat.working())).toEqual(
				new Set(['Alpha:on', 'Beta:on', 'Alpha:off', 'Beta:off'])
			);
			expect(chat.lines()).toEqual(
				expect.arrayContaining([
					expect.stringContaining('user: '),
					expect.stringContaining('moderator: @Alpha @Beta please look at this'),
					'Alpha: Alpha says: looks good.',
					'Beta: Beta says: looks good.',
					'moderator: Both agree it is ready.',
				])
			);

			// The chat reads whole from the host: lines in order, both participants on its roster.
			const read = await readChat(runtime, chatId);
			expect(read.name).toBe('Release review');
			expect(read.state).toBe('idle');
			expect(read.participants.map((p) => p.name).sort()).toEqual(['Alpha', 'Beta']);
			expect(read.participants.every((p) => p.provider === 'claude-code')).toBe(true);
			expect(read.lines.map((line) => line.from)).toEqual(
				expect.arrayContaining(['user', 'moderator', 'Alpha', 'Beta'])
			);
			expect(read.lines.at(-1)).toMatchObject({
				from: 'moderator',
				text: 'Both agree it is ready.',
			});
			expect(provider.callsFor('moderator')).toHaveLength(1);
			expect(provider.callsFor('participant')).toHaveLength(2);
			expect(provider.callsFor('synthesis')).toHaveLength(1);
		});

		it('lands the chat in the desktop layout: group-chats/<id>/{metadata.json,chat.log,images}', async () => {
			const runtime = await start();
			const chat = watch(runtime);
			const chatId = await startChat(runtime);
			await chat.idle();

			const chatDir = path.join(dir, 'group-chats', chatId);
			expect(fs.existsSync(path.join(chatDir, 'metadata.json'))).toBe(true);
			expect(fs.existsSync(path.join(chatDir, 'chat.log'))).toBe(true);
			expect(fs.statSync(path.join(chatDir, 'images')).isDirectory()).toBe(true);
			const metadata = JSON.parse(fs.readFileSync(path.join(chatDir, 'metadata.json'), 'utf-8'));
			expect(metadata).toMatchObject({
				id: chatId,
				name: 'Release review',
				moderatorAgentId: 'claude-code',
			});
			expect(metadata.participants.map((p: { name: string }) => p.name).sort()).toEqual([
				'Alpha',
				'Beta',
			]);
			// The provider session ids of the turns were stored where the chat can resume them.
			expect(metadata.moderatorAgentSessionId).toMatch(/^session-/);
			expect(
				metadata.participants.every((p: { agentSessionId?: string }) => p.agentSessionId)
			).toBe(true);
		});

		it('starts each turn with the real launch: the probed binary, read-only for the moderator', async () => {
			const runtime = await start();
			const chat = watch(runtime);
			await startChat(runtime);
			await chat.idle();

			const [moderator] = provider.callsFor('moderator');
			expect(moderator.spec.command).toBe('/fake/bin/claude');
			expect(moderator.spec.args).toEqual(expect.arrayContaining(['--print', '--output-format']));
			// The moderator reads and routes; it never edits (B16).
			expect(moderator.spec.args.join(' ')).toContain('plan');
			// The agent's own working directory, not the runtime's.
			expect(moderator.spec.cwd).toBeTruthy();
		});

		it('counts a participant that exited non-zero after emitting text as responded (B1)', async () => {
			const runtime = await start((call) =>
				call.role === 'participant' && call.participant === 'Beta'
					? { text: 'Beta: partial findings before the crash.', exitCode: 137 }
					: ROUND(call)
			);
			const chat = watch(runtime);
			const chatId = await startChat(runtime);
			await chat.idle();

			const read = await readChat(runtime, chatId);
			expect(
				read.lines.some((line) => line.from === 'Beta' && /partial findings/.test(line.text))
			).toBe(true);
			// The synthesis still ran: the crash did not hold the room.
			expect(provider.callsFor('synthesis')).toHaveLength(1);
		});

		it('closes out a participant that says nothing, silently, so the round still ends (B2)', async () => {
			const runtime = await start((call) =>
				call.role === 'participant' && call.participant === 'Beta'
					? { text: '', exitCode: 1, stderr: 'boom' }
					: ROUND(call)
			);
			const chat = watch(runtime);
			const chatId = await startChat(runtime);
			await chat.idle();

			const read = await readChat(runtime, chatId);
			expect(read.lines.some((line) => line.from === 'Beta')).toBe(false);
			expect(read.lines.some((line) => line.from === 'Alpha')).toBe(true);
			expect(provider.callsFor('synthesis')).toHaveLength(1);
			expect(read.state).toBe('idle');
		});

		it("records each turn's usage on the participant's card, before the round moves on", async () => {
			const runtime = await start();
			const chat = watch(runtime);
			const chatId = await startChat(runtime);
			await chat.idle();

			const metadata = JSON.parse(
				fs.readFileSync(path.join(dir, 'group-chats', chatId, 'metadata.json'), 'utf-8')
			);
			for (const participant of metadata.participants) {
				// 1000 input + 200 cache read + 100 cache creation, of the agent's default window.
				expect(participant).toMatchObject({ totalCost: 0.01, tokenCount: 1300, contextUsage: 1 });
			}
			// The turn's own measurement rides its History entry: the chat knows what it cost.
			const history = fs
				.readFileSync(path.join(dir, 'group-chats', chatId, 'history.jsonl'), 'utf-8')
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line));
			const turns = history.filter((entry) => entry.type !== 'user');
			expect(turns.map((entry) => entry.type).sort()).toEqual([
				'delegation',
				'response',
				'response',
				'synthesis',
			]);
			expect(turns.every((entry) => entry.cost === 0.01 && entry.tokenCount === 1350)).toBe(true);
		});
	});

	describe('a message into a chat (GC-2)', () => {
		it('takes one round at a time: send is refused while the room works, and accepted when idle', async () => {
			let hold = true;
			const runtime = await start((call) =>
				call.role === 'participant' && call.participant === 'Alpha' && hold
					? { text: 'Alpha: still going.', hold: true }
					: ROUND(call)
			);
			const chat = watch(runtime);
			const chatId = await startChat(runtime);
			await vi.waitFor(() => expect(provider.callsFor('participant').length).toBeGreaterThan(0), {
				timeout: 10_000,
			});
			await vi.waitFor(async () =>
				expect((await readChat(runtime, chatId)).state).not.toBe('idle')
			);

			const refused = errorOf(await runtime.groupChats.send(chatId, 'Another thing'));
			expect(refused.code).toBe('rejected');
			expect(refused.message).toMatch(/still working/);

			// Stop ends the round; the room is free again.
			hold = false;
			value(await runtime.groupChats.stop(chatId));
			await chat.idle();
			expect((await readChat(runtime, chatId)).state).toBe('idle');

			value(await runtime.groupChats.send(chatId, 'Try again'));
			await chat.idle(2);
			expect(provider.callsFor('moderator').length).toBeGreaterThanOrEqual(2);
		});

		it('refuses an empty message and an unknown chat', async () => {
			const runtime = await start();
			expect(errorOf(await runtime.groupChats.send('nope', '   ')).code).toBe('invalid');
			expect(errorOf(await runtime.groupChats.send('nope', 'hello')).code).toBe('not-found');
		});

		it('hands an @participant message to that participant, and only that one (GC-5)', async () => {
			const runtime = await start((call) => {
				if (call.role !== 'moderator') return ROUND(call);
				// Round one routes to both. In round two the moderator names nobody at first; the user's
				// own @mention requires a handoff (B6), so the engine asks it once more and it names Beta.
				if (call.nth === 1) return ROUND(call);
				return call.nth === 2
					? { text: 'Understood.' }
					: { text: '@Beta please double-check the changelog.' };
			});
			const chat = watch(runtime);
			const chatId = await startChat(runtime);
			await chat.idle();
			const before = provider.callsFor('participant').length;

			value(await runtime.groupChats.send(chatId, '@Beta can you double-check the changelog?'));
			await chat.idle(2);

			const addressed = provider.callsFor('participant').slice(before);
			expect(addressed.map((call) => call.participant)).toEqual(['Beta']);
			const read = await readChat(runtime, chatId);
			expect(read.lines.filter((line) => line.from === 'Beta')).toHaveLength(2);
			expect(read.lines.filter((line) => line.from === 'Alpha')).toHaveLength(1);
		});

		it('adds an agent the user @mentions to the roster, and it takes its turn (B7)', async () => {
			const runtime = await start((call) => {
				if (call.role !== 'moderator' || call.nth === 1) return ROUND(call);
				return call.nth === 2 ? { text: 'Welcome.' } : { text: '@Gamma welcome, please weigh in.' };
			});
			const chat = watch(runtime);
			const chatId = await startChat(runtime);
			await chat.idle();

			value(await runtime.groupChats.send(chatId, '@Gamma join us and weigh in'));
			await chat.idle(2);

			const read = await readChat(runtime, chatId);
			expect(read.participants.map((p) => p.name)).toContain('Gamma');
			expect(provider.callsFor('participant').some((call) => call.participant === 'Gamma')).toBe(
				true
			);
		});
	});

	describe('stopping and deleting (GC-3)', () => {
		it('stops the round: the held participant ends, no synthesis runs, the room is idle', async () => {
			const runtime = await start((call) =>
				call.role === 'participant'
					? { text: `${call.participant}: working.`, hold: true }
					: ROUND(call)
			);
			const chat = watch(runtime);
			const chatId = await startChat(runtime);
			await vi.waitFor(() => expect(provider.callsFor('participant')).toHaveLength(2), {
				timeout: 10_000,
			});
			expect(runtime.roundsInFlight()).toBe(1);
			// The held processes are the chat's, not the agents': nothing reads busy because of them.
			expect(runtime.turnsInFlight()).toBe(0);

			value(await runtime.groupChats.stop(chatId));
			await chat.idle();

			expect(provider.callsFor('synthesis')).toHaveLength(0);
			expect(runtime.roundsInFlight()).toBe(0);
			await vi.waitFor(() =>
				expect(chat.working().filter((w) => w.endsWith(':off')).length).toBe(2)
			);
		});

		it('deletes a chat: its processes stop and its folder goes', async () => {
			const runtime = await start((call) =>
				call.role === 'participant' ? { text: 'working', hold: true } : ROUND(call)
			);
			const chatId = await startChat(runtime);
			await vi.waitFor(() => expect(provider.callsFor('participant')).toHaveLength(2), {
				timeout: 10_000,
			});

			value(await runtime.groupChats.remove(chatId));

			expect(fs.existsSync(path.join(dir, 'group-chats', chatId))).toBe(false);
			expect(errorOf(await runtime.groupChats.get(chatId)).code).toBe('not-found');
			expect(value(await runtime.groupChats.list()).map((c) => c.id)).not.toContain(chatId);
			expect(errorOf(await runtime.groupChats.remove(chatId)).code).toBe('not-found');
		});

		it('renames a chat, and lists it without its lines', async () => {
			const runtime = await start();
			const chat = watch(runtime);
			const chatId = await startChat(runtime);
			await chat.idle();

			value(await runtime.groupChats.rename(chatId, '  Shipping  '));
			const listed = value(await runtime.groupChats.list());
			expect(listed).toHaveLength(1);
			expect(listed[0]).toMatchObject({ id: chatId, name: 'Shipping', lines: [] });
			expect(errorOf(await runtime.groupChats.rename(chatId, '  ')).code).toBe('invalid');
			expect(errorOf(await runtime.groupChats.rename('nope', 'x')).code).toBe('not-found');
		});

		it('shutdown stops a round in flight and leaves the log written', async () => {
			const runtime = await start((call) =>
				call.role === 'participant' ? { text: 'working', hold: true } : ROUND(call)
			);
			const chatId = await startChat(runtime);
			await vi.waitFor(() => expect(provider.callsFor('participant')).toHaveLength(2), {
				timeout: 10_000,
			});

			await runtime.connection.close();

			const log = fs.readFileSync(path.join(dir, 'group-chats', chatId, 'chat.log'), 'utf-8');
			expect(log).toContain('please look at this');
		});
	});

	describe('creating a chat (GC-1)', () => {
		it('checks the request the way the desktop does: unknown agent, terminal, nobody', async () => {
			const runtime = await start();
			const create = (participantIds: string[], extra = {}) =>
				runtime.groupChats.create({ name: 'Room', participantIds, ...extra });

			expect(errorOf(await create(['zzz'])).code).toBe('not-found');
			expect(errorOf(await create(['a4'])).message).toMatch(/terminal agent/);
			expect(errorOf(await create([])).message).toMatch(/at least one participant/i);
			expect(errorOf(await create(['a1'], { moderatorAgentId: 'zzz' })).code).toBe('not-found');
			expect(
				errorOf(await runtime.groupChats.create({ name: ' ', participantIds: ['a1'] })).code
			).toBe('invalid');
			expect(value(await runtime.groupChats.list())).toEqual([]);
		});

		it('refuses a name two agents answer to, so a mention picks out one', async () => {
			const runtime = await start(ROUND, [
				agentRecord('a1', 'Review Bot', work),
				agentRecord('a2', 'review-bot', work),
			]);
			const error = errorOf(
				await runtime.groupChats.create({ name: 'Room', participantIds: ['a1'] })
			);
			expect(error.code).toBe('invalid');
			expect(error.message).toMatch(/2 agents answer to @Review Bot/);
		});

		it('moderates with the named provider, or the named agent, or the first participant', async () => {
			const runtime = await start((call) =>
				call.role === 'moderator' ? { text: 'Fine.' } : ROUND(call)
			);
			const chat = watch(runtime);
			const named = value(
				await runtime.groupChats.create({
					name: 'By provider',
					participantIds: ['a1'],
					moderatorProvider: 'claude-code',
				})
			).chatId;
			await chat.idle();
			expect((await readChat(runtime, named)).moderatorProvider).toBe('claude-code');

			const byAgent = value(
				await runtime.groupChats.create({
					name: 'By agent',
					participantIds: ['a1'],
					moderatorAgentId: 'a2',
				})
			).chatId;
			await chat.idle(2);
			expect((await readChat(runtime, byAgent)).moderatorProvider).toBe('claude-code');
		});

		it('says the chat exists but the opening message failed when the provider is not installed', async () => {
			binaryExists = false;
			const runtime = await start();
			const error = errorOf(
				await runtime.groupChats.create({ name: 'Room', participantIds: ['a1'] })
			);
			expect(error.code).toBe('failed');
			expect(error.message).toMatch(/created, but the opening message failed.*not available/);
			// The chat is there to read, and idle: nothing is stuck working.
			const [only] = value(await runtime.groupChats.list());
			expect(only.state).toBe('idle');
		});

		it('refuses to start work once the runtime is closed', async () => {
			const runtime = await start();
			await runtime.connection.close();
			expect(
				errorOf(await runtime.groupChats.create({ name: 'Room', participantIds: ['a1'] })).code
			).toBe('host-unavailable');
		});
	});
});
