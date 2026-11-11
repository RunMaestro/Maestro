/**
 * The runtime's turns: send, queue, stop, and swap-and-back, with a fake provider.
 *
 * The provider is `src/__tests__/fixtures/fake-agent.mjs` replaying a real recorded turn, so a
 * turn here is a real process on a real pipe, assembled by the real `assembleTurn` and started by
 * the real `runAgentTurn`; only the command is swapped for the fake agent. The runtime, its
 * repository, its queue, and its records are real and write to a temp data directory.
 */
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	CAPTURED_RECORDINGS,
	CAPTURED_CLAUDE_CODE_SESSION_ID,
	CAPTURED_OPENCODE_SESSION_ID,
} from '../../../../__tests__/main/process-manager/recordings/captured';
import {
	FAKE_AGENT_PATH,
	fakeTurnFromRecording,
	writeFakeTurn,
} from '../../../../__tests__/shared/maestro-lib/run/fakeAgent';
import { nativeAccountRef } from '../../../agentAccountDir';
import * as repositories from '../../agents/repository';
import { DEFAULT_TAB_DEFAULTS } from '../../agents/rules';
import type { ClientResult, QueuedTurn, TurnEvent } from '../../client/types';
import { readHistory } from '../../store/read-history';
import { sharedHistoryDir, sharedHistoryFilename } from '../../store/shared-history';
import { runAgentTurn, type RunAgentTurnOptions } from '../../turns/run-agent-turn';
import {
	createMaestroRuntime,
	type MaestroRuntime,
	type MaestroRuntimeOptions,
	type RuntimeDeps,
} from '../index';
import type { WatchDirectory } from '../settings-watch';

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

describe('runtime turns', () => {
	let dir: string;
	let work: string;
	let open: MaestroRuntime[];
	/** The recording each provider replays, as a file the fake agent reads. */
	let recordings: Record<string, string>;
	/** Keep the fake agent running after its replay, until it is stopped. */
	let hold: boolean;
	let argvFiles: string[];
	/** The options each turn was started with. */
	let turnOptions: RunAgentTurnOptions[];
	let binaryExists: boolean;

	const watchDirectory: WatchDirectory = () => ({ close: () => undefined });

	const fakeProvider: RuntimeDeps['turns']['runAgentTurn'] = (turn, options) => {
		const argvOut = path.join(work, `argv-${argvFiles.length + 1}.json`);
		argvFiles.push(argvOut);
		turnOptions.push(options);
		return runAgentTurn(
			{
				...turn,
				launch: {
					...turn.launch,
					command: process.execPath,
					args: [FAKE_AGENT_PATH, ...turn.launch.args],
					sessionCustomEnvVars: {
						...turn.launch.sessionCustomEnvVars,
						FAKE_AGENT_RECORDING: recordings[turn.provider.id],
						FAKE_AGENT_ARGV_OUT: argvOut,
						...(hold ? { FAKE_AGENT_HOLD: '1' } : {}),
					},
				},
			},
			{ ...options, stopGraceMs: 200 }
		);
	};

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
			watchDirectory,
			probeBinary: async (binaryName) =>
				binaryExists ? { exists: true, path: `/fake/bin/${binaryName}` } : { exists: false },
			turns: { runAgentTurn: fakeProvider },
		};
	}

	const seedAgent = (extra: Record<string, unknown> = {}) => ({
		id: 'a1',
		name: 'Alpha',
		toolType: 'claude-code',
		cwd: work,
		projectRoot: work,
		aiTabs: [
			{ id: 't1', agentSessionId: null, name: null, logs: [] },
			{ id: 't2', agentSessionId: null, name: null, logs: [] },
		],
		activeTabId: 't1',
		unifiedTabOrder: [
			{ type: 'ai', id: 't1' },
			{ type: 'ai', id: 't2' },
		],
		...extra,
	});

	async function start(
		sessions: unknown[] = [seedAgent()],
		extra: Partial<MaestroRuntimeOptions> = {}
	): Promise<MaestroRuntime> {
		fs.writeFileSync(
			path.join(dir, 'maestro-sessions.json'),
			JSON.stringify({ sessions, activeSessionId: 'a1' }, null, '\t')
		);
		const started = await createMaestroRuntime({
			dataDir: dir,
			mode: 'tui',
			deps: deps(),
			turns: { bundledPromptsDir: BUNDLED_PROMPTS },
			...extra,
		});
		if (!started.ok) throw new Error(`refused: ${started.refusal.message}`);
		open.push(started.runtime);
		return started.runtime;
	}

	/** Collect a tab's turn events, and let a test wait for the n-th `outcome`. */
	function watch(runtime: MaestroRuntime, tabId = 't1') {
		const events: TurnEvent[] = [];
		const waiting: Array<{ count: number; resolve: () => void }> = [];
		runtime.turns.subscribe('a1', tabId, (event) => {
			events.push(event);
			if (event.kind !== 'outcome') return;
			const outcomes = events.filter((e) => e.kind === 'outcome').length;
			for (const waiter of waiting.filter((w) => w.count <= outcomes)) waiter.resolve();
		});
		return {
			events,
			kinds: () => events.map((event) => event.kind),
			outcomes: () => events.flatMap((event) => (event.kind === 'outcome' ? [event.outcome] : [])),
			outcome: (count = 1) =>
				new Promise<void>((resolve, reject) => {
					if (events.filter((e) => e.kind === 'outcome').length >= count) return resolve();
					const timer = setTimeout(
						() => reject(new Error(`no outcome ${count}; saw ${events.map((e) => e.kind)}`)),
						8_000
					);
					waiting.push({
						count,
						resolve: () => {
							clearTimeout(timer);
							resolve();
						},
					});
				}),
			started: () =>
				new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error('no turn started')), 8_000);
					const poll = setInterval(() => {
						if (events.some((event) => event.kind === 'started')) {
							clearInterval(poll);
							clearTimeout(timer);
							resolve();
						}
					}, 10);
				}),
		};
	}

	const transcript = async (runtime: MaestroRuntime, tabId = 't1') =>
		value(await runtime.tabs.transcript('a1', tabId));
	const tabOf = async (runtime: MaestroRuntime, tabId = 't1') =>
		value(await runtime.tabs.list('a1')).find((tab) => tab.id === tabId)!;
	const sessions = () =>
		JSON.parse(fs.readFileSync(path.join(dir, 'maestro-sessions.json'), 'utf-8'));

	beforeEach(() => {
		const fixtureRoot = path.resolve(__dirname, '../../../../../tmp');
		fs.mkdirSync(fixtureRoot, { recursive: true });
		dir = fs.mkdtempSync(path.join(fixtureRoot, 'maestro-runtime-turns-'));
		work = fs.mkdtempSync(path.join(fixtureRoot, 'maestro-runtime-turns-work-'));
		open = [];
		hold = false;
		argvFiles = [];
		turnOptions = [];
		binaryExists = true;
		recordings = {
			'claude-code': writeFakeTurn(
				work,
				fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-claude-code-normal'])
			),
			opencode: writeFakeTurn(
				work,
				fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal'])
			),
		};
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const runtime of open) await runtime.connection.close();
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(work, { recursive: true, force: true });
	});

	describe('send', () => {
		it('holds source-target turns when this host cannot prepare the endpoint', async () => {
			const runtime = await start([
				seedAgent({ runOn: { type: 'source', endpointId: 'local', model: 'qwen3' } }),
			]);
			const result = await runtime.turns.send('a1', 't1', { text: 'stay on the source' });
			expect(errorOf(result).message).toContain('cannot prepare a Local Models source');
			expect(argvFiles).toHaveLength(0);
		});

		it('never sends the Auto selection as a provider model when no router is installed', async () => {
			const runtime = await start([seedAgent({ customModel: 'auto' })]);
			const turn = watch(runtime);
			value(await runtime.turns.send('a1', 't1', { text: 'use the default' }));
			await turn.outcome();
			const argv = JSON.parse(fs.readFileSync(argvFiles[0], 'utf8')) as string[];
			expect(argv).not.toContain('auto');
		});

		it('launches a pinned tab provider and records its owner without changing the default', async () => {
			const runtime = await start([
				seedAgent({
					toolType: 'opencode',
					customModel: 'wrong-default',
					aiTabs: [
						{ id: 't1', tabProvider: 'claude-code', agentSessionId: null, name: null, logs: [] },
					],
					providerOverrides: { 'claude-code': { customModel: 'sonnet' } },
				}),
			]);
			const turn = watch(runtime);
			value(await runtime.turns.send('a1', 't1', { text: 'use the pinned harness' }));
			await turn.outcome();
			expect((await transcript(runtime)).find((entry) => entry.source === 'stdout')).toMatchObject({
				turnProvider: 'claude-code',
				turnModel: 'sonnet',
			});
			expect((await tabOf(runtime)).agentSessionId).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);
			expect(sessions().sessions[0].toolType).toBe('opencode');
			const argv = JSON.parse(fs.readFileSync(argvFiles[0], 'utf8')) as string[];
			expect(argv).toContain('sonnet');
			expect(argv).not.toContain('wrong-default');
		});

		it('runs a turn on an idle agent, streams it to the tab, and ends on the outcome', async () => {
			const runtime = await start();
			const turn = watch(runtime);

			expect(value(await runtime.turns.send('a1', 't1', { text: 'hello' }))).toEqual({
				status: 'started',
			});
			await turn.outcome();

			const kinds = turn.kinds();
			expect(kinds.slice(0, 2)).toEqual(['user', 'started']);
			expect(kinds[kinds.length - 1]).toBe('outcome');
			expect(kinds.filter((kind) => kind === 'outcome')).toHaveLength(1);
			expect(kinds.filter((kind) => kind === 'session')).toHaveLength(1);
			expect(turn.events.find((event) => event.kind === 'session')).toMatchObject({
				providerSessionId: CAPTURED_CLAUDE_CODE_SESSION_ID,
			});
			expect(turn.outcomes()).toEqual(['completed']);
		});

		it("lets the turn accept claude's folder trust, since it runs in the agent's own cwd (#1872)", async () => {
			const runtime = await start();
			const turn = watch(runtime);

			value(await runtime.turns.send('a1', 't1', { text: 'hello' }));
			await turn.outcome();

			expect(turnOptions[0]?.acceptWorkspaceTrust).toBe(true);
		});

		it('writes the message, the answer, the session id, and the folded usage the desktop will show', async () => {
			const runtime = await start();
			const turn = watch(runtime);
			value(await runtime.turns.send('a1', 't1', { text: 'what is the capital of France' }));
			await turn.outcome();

			const entries = await transcript(runtime);
			expect(entries.map((entry) => entry.source)).toEqual(['user', 'stdout']);
			expect(entries[0].text).toBe('what is the capital of France');
			// The answer was said to the client once, and is what the transcript holds.
			const streamed = turn.events.flatMap((event) => (event.kind === 'text' ? [event.text] : []));
			expect(entries[1].text).toBe(streamed.join(''));

			const tab = await tabOf(runtime);
			expect(tab.agentSessionId).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);
			expect(tab.turnProvider).toBe('claude-code');
			expect((tab.usageStats as { outputTokens: number }).outputTokens).toBeGreaterThan(0);

			const history = readHistory(runtime.paths, 'a1');
			if (history.status !== 'ok') throw new Error(`history ${history.status}`);
			expect(history.entries).toHaveLength(1);
			expect(history.entries[0]).toMatchObject({
				type: 'USER',
				sessionId: 'a1',
				tabId: 't1',
				agentSessionId: CAPTURED_CLAUDE_CODE_SESSION_ID,
			});
		});

		describe('History host and shared History', () => {
			const SHARED = { sharedHistory: { label: 'box.host', hostname: 'box' } };
			const sharedFile = () => path.join(sharedHistoryDir(work), sharedHistoryFilename('box.host'));
			const readShared = () =>
				fs
					.readFileSync(sharedFile(), 'utf-8')
					.split('\n')
					.filter(Boolean)
					.map((line) => JSON.parse(line));
			const ownEntries = (runtime: MaestroRuntime) => {
				const history = readHistory(runtime.paths, 'a1');
				if (history.status !== 'ok') throw new Error(`history ${history.status}`);
				return history.entries;
			};

			it('stamps the entry with the machine the send names, and copies it to the project', async () => {
				fs.mkdirSync(sharedHistoryDir(work), { recursive: true });
				const runtime = await start([seedAgent()], SHARED);
				const turn = watch(runtime);
				value(
					await runtime.turns.send('a1', 't1', { text: 'hello', originHost: '  laptop.local ' })
				);
				await turn.outcome();

				const [own] = ownEntries(runtime);
				expect(own.hostname).toBe('laptop.local');
				const shared = readShared();
				expect(shared).toHaveLength(1);
				expect(shared[0]).toMatchObject({ id: own.id, hostname: 'laptop.local', type: 'USER' });
				// The runtime's own shared file is not read back as another writer's.
				const listed = value(await runtime.history.list('a1'));
				expect(listed.map((e) => e.id)).toEqual([own.id]);
			});

			it("gives a copy with no origin the host's own hostname, and drops an origin that is not printable", async () => {
				fs.mkdirSync(sharedHistoryDir(work), { recursive: true });
				const runtime = await start([seedAgent()], SHARED);
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: 'hello', originHost: 'bad\u0007host' }));
				await turn.outcome();

				const [own] = ownEntries(runtime);
				expect(own).not.toHaveProperty('hostname');
				expect(readShared()[0]).toMatchObject({ id: own.id, hostname: 'box' });
			});

			it('copies nothing for a project that does not share, or without a shared identity', async () => {
				const runtime = await start([seedAgent()], SHARED);
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: 'hello' }));
				await turn.outcome();
				expect(ownEntries(runtime)).toHaveLength(1);
				expect(fs.existsSync(sharedHistoryDir(work))).toBe(false);
			});

			it('copies nothing without a shared identity, even where the project shares', async () => {
				fs.mkdirSync(sharedHistoryDir(work), { recursive: true });
				const runtime = await start();
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: 'hello' }));
				await turn.outcome();
				expect(ownEntries(runtime)).toHaveLength(1);
				expect(fs.readdirSync(sharedHistoryDir(work))).toEqual([]);
			});

			it('lists the other writers entries with the agent own, newest first', async () => {
				fs.mkdirSync(sharedHistoryDir(work), { recursive: true });
				fs.writeFileSync(
					path.join(sharedHistoryDir(work), sharedHistoryFilename('laptop')),
					`${JSON.stringify({ id: 'from-laptop', type: 'USER', timestamp: 1, summary: 's', projectPath: work })}\n`
				);
				const runtime = await start([seedAgent()], SHARED);
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: 'hello' }));
				await turn.outcome();
				const listed = value(await runtime.history.list('a1'));
				expect(listed).toHaveLength(2);
				expect(listed[1]).toMatchObject({ id: 'from-laptop', hostname: 'laptop' });
				expect(value(await runtime.history.list('a1', { limit: 1 }))).toHaveLength(1);
				expect(errorOf(await runtime.history.list('nope')).code).toBe('not-found');
			});
		});

		it('resumes the tab session on the next send, and does not announce the id it resumed', async () => {
			const runtime = await start();
			const turn = watch(runtime);
			value(await runtime.turns.send('a1', 't1', { text: 'one' }));
			await turn.outcome(1);
			value(await runtime.turns.send('a1', 't1', { text: 'two' }));
			await turn.outcome(2);

			const argv = JSON.parse(fs.readFileSync(argvFiles[1], 'utf-8')) as string[];
			expect(argv).toContain('--resume');
			expect(argv).toContain(CAPTURED_CLAUDE_CODE_SESSION_ID);
			expect(turn.kinds().filter((kind) => kind === 'session')).toHaveLength(1);
			expect((await transcript(runtime)).map((entry) => entry.source)).toEqual([
				'user',
				'stdout',
				'user',
				'stdout',
			]);
		});

		// The runtime's public port carries no host-admitted image bounds, so a Grok
		// message with attachments is refused whole at send: no turn, no queued item, no transcript
		// entry, and never the text alone in its place.
		it.each([
			{ name: 'fresh local', resume: null, ssh: false },
			{ name: 'resumed local', resume: 'grok-native-session', ssh: false },
			{ name: 'fresh SSH', resume: null, ssh: true },
		])('refuses Grok attachments at send, starting nothing: $name', async ({ resume, ssh }) => {
			recordings.grok = writeFakeTurn(work, { chunks: [], close: { code: 0, signal: null } });
			const runtime = await start([
				seedAgent({
					toolType: 'grok',
					customEnvVars: { GROK_HOME: work },
					aiTabs: [{ id: 't1', agentSessionId: resume, name: null, logs: [] }],
					unifiedTabOrder: [{ type: 'ai', id: 't1' }],
					...(ssh ? { sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' } } : {}),
				}),
			]);
			const turn = watch(runtime);

			const error = errorOf(
				await runtime.turns.send('a1', 't1', {
					text: 'describe these',
					images: ['data:image/png;base64,iVBORw0KGgo=', 'maestro-image://sha256/fixture'],
				})
			);

			expect(error).toMatchObject({
				code: 'unsupported',
				message:
					'Images cannot be sent from here yet. Send the message without them, or use the desktop.',
			});
			expect(argvFiles).toEqual([]);
			expect(turn.events).toEqual([]);
			expect(value(await runtime.turns.queue.list('a1'))).toEqual([]);
			expect(await transcript(runtime)).toEqual([]);
			expect(sessions().sessions[0].aiTabs[0]).toMatchObject({ agentSessionId: resume, logs: [] });
		});

		it('refuses what cannot run, and says which', async () => {
			const runtime = await start();
			expect(errorOf(await runtime.turns.send('a1', 't1', { text: '   ' })).code).toBe('invalid');
			expect(
				errorOf(
					await runtime.turns.send('a1', 't1', { text: 'x', images: ['data:image/png;base64,AA'] })
				).code
			).toBe('unsupported');
			expect(errorOf(await runtime.turns.send('nope', 't1', { text: 'x' })).code).toBe('not-found');
			expect(errorOf(await runtime.turns.send('a1', 'nope', { text: 'x' })).code).toBe('not-found');
			expect(argvFiles).toEqual([]);
		});

		it('refuses a lifted agent with a pointer at peer:agentId, and starts nothing', async () => {
			const runtime = await start([
				seedAgent({ liftedTo: { peer: 'build-box', agentId: 'host-1', at: 1 } }),
			]);
			const error = errorOf(await runtime.turns.send('a1', 't1', { text: 'hello' }));
			expect(error.code).toBe('rejected');
			expect(error.message).toContain('Send to build-box:host-1 instead.');
			expect(argvFiles).toEqual([]);
		});

		it('answers host-unavailable once the runtime is closed', async () => {
			const runtime = await start();
			await runtime.connection.close();
			expect(errorOf(await runtime.turns.send('a1', 't1', { text: 'x' })).code).toBe(
				'host-unavailable'
			);
		});
	});

	describe('a message that cannot start', () => {
		it('is held in the queue with the reason, never dropped and never written to the transcript', async () => {
			binaryExists = false;
			const runtime = await start();
			const turn = watch(runtime);

			const failure = errorOf(await runtime.turns.send('a1', 't1', { text: 'do the thing' }));
			expect(failure.code).toBe('failed');
			expect(failure.message).toContain('was not found');
			expect(failure.message).toContain('held in the queue');

			const held = value(await runtime.turns.queue.list('a1'));
			expect(held).toEqual([
				expect.objectContaining({ tabId: 't1', text: 'do the thing', paused: true }),
			]);
			expect(turn.events).toEqual([
				expect.objectContaining({
					kind: 'error',
					error: expect.objectContaining({
						message: expect.stringContaining('The message was not sent'),
					}),
				}),
			]);
			expect(await transcript(runtime)).toEqual([]);

			expect(value(await runtime.turns.queue.remove('a1', held[0].itemId))).toEqual({
				removed: true,
			});
			expect(value(await runtime.turns.queue.list('a1'))).toEqual([]);
		});
	});

	describe('the queue and stop', () => {
		it('queues a message for a busy tab, lists it, and runs it when the first turn is stopped', async () => {
			hold = true;
			const runtime = await start();
			const turn = watch(runtime);
			value(await runtime.turns.send('a1', 't1', { text: 'first' }));
			await turn.started();

			hold = false;
			const receipt = value(await runtime.turns.send('a1', 't1', { text: 'second' }));
			expect(receipt).toMatchObject({ status: 'queued', position: 1, queueLength: 1 });
			expect(value(await runtime.turns.queue.list('a1'))).toEqual([
				expect.objectContaining({ tabId: 't1', text: 'second', kind: 'message', paused: false }),
			]);

			expect(value(await runtime.turns.interrupt('a1', 't1'))).toEqual({ stopped: true });
			await turn.outcome(2);

			expect(turn.outcomes()).toEqual(['interrupted', 'completed']);
			expect(value(await runtime.turns.queue.list('a1'))).toEqual([]);
			const entries = await transcript(runtime);
			expect(entries.filter((entry) => entry.source === 'user').map((entry) => entry.text)).toEqual(
				['first', 'second']
			);
		});

		it('keeps the origin host on a queued message, so its History entry names the sender', async () => {
			hold = true;
			const runtime = await start();
			const turn = watch(runtime);
			value(await runtime.turns.send('a1', 't1', { text: 'first' }));
			await turn.started();

			hold = false;
			value(await runtime.turns.send('a1', 't1', { text: 'second', originHost: 'laptop.local' }));
			expect(value(await runtime.turns.interrupt('a1', 't1'))).toEqual({ stopped: true });
			await turn.outcome(2);

			const history = readHistory(runtime.paths, 'a1');
			if (history.status !== 'ok') throw new Error(`history ${history.status}`);
			// The interrupted first turn writes no entry; the queued one is stamped with its sender.
			expect(history.entries).toHaveLength(1);
			expect(history.entries[0].hostname).toBe('laptop.local');
		});

		it('holds a write on another tab while one runs, since the tabs share a working directory', async () => {
			hold = true;
			const runtime = await start();
			const first = watch(runtime, 't1');
			const second = watch(runtime, 't2');
			value(await runtime.turns.send('a1', 't1', { text: 'busy' }));
			await first.started();

			hold = false;
			expect(value(await runtime.turns.send('a1', 't2', { text: 'waits' }))).toMatchObject({
				status: 'queued',
			});
			value(await runtime.turns.interrupt('a1', 't1'));
			await second.outcome();
			expect(second.outcomes()).toEqual(['completed']);
		});

		it('drops a waiting message when it is removed, and reports a missing one as not removed', async () => {
			hold = true;
			const runtime = await start();
			const turn = watch(runtime);
			value(await runtime.turns.send('a1', 't1', { text: 'first' }));
			await turn.started();
			const queued = value(await runtime.turns.send('a1', 't1', { text: 'never sent' }));
			if (queued.status !== 'queued') throw new Error('expected queued');

			expect(value(await runtime.turns.queue.remove('a1', queued.itemId))).toEqual({
				removed: true,
			});
			expect(value(await runtime.turns.queue.remove('a1', queued.itemId))).toEqual({
				removed: false,
			});
			value(await runtime.turns.interrupt('a1', 't1'));
			await turn.outcome();
			expect(argvFiles).toHaveLength(1);
		});

		it('says what waits on every queue change, but not for a turn that never waited', async () => {
			hold = true;
			const runtime = await start();
			const turn = watch(runtime);
			const changes: QueuedTurn[][] = [];
			runtime.events.subscribe(
				(event) => {
					if (event.type === 'queue.changed') changes.push(event.items);
				},
				{ types: ['queue.changed'], agentId: 'a1' }
			);
			value(await runtime.turns.send('a1', 't1', { text: 'first' }));
			await turn.started();
			expect(changes).toEqual([]);

			hold = false;
			const queued = value(await runtime.turns.send('a1', 't1', { text: 'second' }));
			if (queued.status !== 'queued') throw new Error('expected queued');
			expect(changes).toEqual([
				[
					expect.objectContaining({
						itemId: queued.itemId,
						tabId: 't1',
						kind: 'message',
						text: 'second',
						paused: false,
					}),
				],
			]);

			value(await runtime.turns.interrupt('a1', 't1'));
			await turn.outcome(2);
			// The waiting message started: nothing waits now.
			expect(changes).toHaveLength(2);
			expect(changes[1]).toEqual([]);
		});

		it('holds and releases a waiting message, and says when none has that id', async () => {
			hold = true;
			const runtime = await start();
			const turn = watch(runtime);
			const changes: QueuedTurn[][] = [];
			runtime.events.subscribe(
				(event) => {
					if (event.type === 'queue.changed') changes.push(event.items);
				},
				{ types: ['queue.changed'] }
			);
			value(await runtime.turns.send('a1', 't1', { text: 'first' }));
			await turn.started();
			const queued = value(await runtime.turns.send('a1', 't1', { text: 'waits' }));
			if (queued.status !== 'queued') throw new Error('expected queued');

			expect(value(await runtime.turns.queue.setPaused('a1', queued.itemId, true))).toEqual({
				found: true,
				paused: true,
			});
			expect(value(await runtime.turns.queue.list('a1'))).toEqual([
				expect.objectContaining({ itemId: queued.itemId, paused: true }),
			]);
			expect(changes[changes.length - 1]).toEqual([expect.objectContaining({ paused: true })]);

			expect(value(await runtime.turns.queue.setPaused('a1', queued.itemId, false))).toEqual({
				found: true,
				paused: false,
			});
			expect(changes[changes.length - 1]).toEqual([expect.objectContaining({ paused: false })]);

			expect(value(await runtime.turns.queue.setPaused('a1', 'missing', true))).toEqual({
				found: false,
				paused: true,
			});
			expect(errorOf(await runtime.turns.queue.setPaused('nope', queued.itemId, true)).code).toBe(
				'not-found'
			);

			value(await runtime.turns.queue.remove('a1', queued.itemId));
			value(await runtime.turns.interrupt('a1', 't1'));
			await turn.outcome();
		});

		it('says nothing was stopped when the tab is idle', async () => {
			const runtime = await start();
			expect(value(await runtime.turns.interrupt('a1', 't1'))).toEqual({ stopped: false });
			expect(errorOf(await runtime.turns.queue.list('nope')).code).toBe('not-found');
		});

		it('stops a running turn and records it as interrupted when the runtime closes', async () => {
			hold = true;
			const runtime = await start();
			const turn = watch(runtime);
			value(await runtime.turns.send('a1', 't1', { text: 'long job' }));
			await turn.started();

			await runtime.connection.close();

			expect(turn.outcomes()).toEqual(['interrupted']);
			// The message was written before the provider ran, so the close cannot have lost it. (What
			// the agent had said by then depends on how far the replay got.)
			const stored = sessions().sessions[0].aiTabs[0].logs;
			expect(stored[0]).toMatchObject({ source: 'user', text: 'long job' });
		});
	});

	describe('swap and back', () => {
		it('resumes each provider on the conversation it left, with every tab and transcript intact', async () => {
			// Existing native slots exercise parking, independently of context translation.
			const runtime = await start([
				seedAgent({
					aiTabs: seedAgent().aiTabs.map((tab) => ({
						...tab,
						agentSessionId: CAPTURED_CLAUDE_CODE_SESSION_ID,
						providerSessions: { opencode: { agentSessionId: CAPTURED_OPENCODE_SESSION_ID } },
					})),
				}),
			]);
			const turn = watch(runtime);

			value(await runtime.turns.send('a1', 't1', { text: 'on claude' }));
			await turn.outcome(1);
			expect((await tabOf(runtime)).agentSessionId).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);

			value(await runtime.agents.update('a1', { provider: 'opencode' }));
			expect((await tabOf(runtime)).agentSessionId).toBe(CAPTURED_OPENCODE_SESSION_ID);

			value(await runtime.turns.send('a1', 't1', { text: 'on opencode' }));
			await turn.outcome(2);
			const onOpencode = await tabOf(runtime);
			expect(onOpencode.agentSessionId).toBe(CAPTURED_OPENCODE_SESSION_ID);
			expect(onOpencode.turnProvider).toBe('opencode');
			expect(
				(onOpencode.providerSessions as Record<string, { agentSessionId: string }>)['claude-code']
					.agentSessionId
			).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);

			value(await runtime.agents.update('a1', { provider: 'claude-code' }));
			const back = await tabOf(runtime);
			expect(back.agentSessionId).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);
			expect(
				(back.providerSessions as Record<string, { agentSessionId: string }>).opencode
					.agentSessionId
			).toBe(CAPTURED_OPENCODE_SESSION_ID);

			value(await runtime.turns.send('a1', 't1', { text: 'back on claude' }));
			await turn.outcome(3);

			// The third turn resumed the Claude conversation, not the OpenCode one.
			const argv = JSON.parse(fs.readFileSync(argvFiles[2], 'utf-8')) as string[];
			expect(argv).toContain('--resume');
			expect(argv).toContain(CAPTURED_CLAUDE_CODE_SESSION_ID);
			expect(argv).not.toContain(CAPTURED_OPENCODE_SESSION_ID);

			// Both tabs are still there and the transcript kept every message across both swaps.
			expect(value(await runtime.tabs.list('a1')).map((tab) => tab.id)).toEqual(['t1', 't2']);
			const entries = await transcript(runtime);
			expect(entries.filter((entry) => entry.source === 'user').map((entry) => entry.text)).toEqual(
				['on claude', 'on opencode', 'back on claude']
			);
			expect(entries.filter((entry) => entry.source === 'stdout')).toHaveLength(3);
		});
	});

	describe('Grok native session identity', () => {
		/** The argv files the fake agent actually wrote: one per process that ran. */
		const ran = () => argvFiles.filter((file) => fs.existsSync(file));

		async function startWith(extra: Partial<RuntimeDeps>, agent = seedAgent()) {
			fs.writeFileSync(
				path.join(dir, 'maestro-sessions.json'),
				JSON.stringify({ sessions: [agent], activeSessionId: 'a1' }, null, '\t')
			);
			const started = await createMaestroRuntime({
				dataDir: dir,
				mode: 'tui',
				deps: { ...deps(), ...extra },
				turns: { bundledPromptsDir: BUNDLED_PROMPTS },
			});
			if (!started.ok) throw new Error(`refused: ${started.refusal.message}`);
			open.push(started.runtime);
			return started.runtime;
		}

		/** Wait until the tab has emitted an event of this kind. */
		const saw = (turn: ReturnType<typeof watch>, kind: TurnEvent['kind']) =>
			new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`no ${kind}`)), 8_000);
				const poll = setInterval(() => {
					if (turn.events.some((event) => event.kind === kind)) {
						clearInterval(poll);
						clearTimeout(timer);
						resolve();
					}
				}, 10);
			});

		it.each([
			{ name: 'new allocation', early: ['native-new'], end: 'native-new' },
			{
				name: 'settings change during turn',
				early: ['native-new'],
				end: 'native-new',
				mutate: true,
			},
			{ name: 'end-only allocation', early: [], end: 'native-new' },
			{ name: 'allocation without terminal ID', early: ['native-new'], end: undefined },
			{
				name: 'allocation without end event',
				early: ['native-new'],
				end: undefined,
				missingEnd: true,
			},
			{ name: 'no allocation or end event', early: [], end: undefined, missingEnd: true },
			{ name: 'cancelled allocation', early: ['native-new'], end: undefined, cancel: true },
			{
				name: 'allocation after stop',
				early: ['native-new'],
				end: undefined,
				cancel: true,
				late: true,
			},
			{
				name: 'allocation without receipt',
				early: ['native-new'],
				end: undefined,
				noReceipt: true,
			},
			{
				name: 'resume without receipt',
				resume: 'original',
				early: ['original'],
				end: undefined,
				noReceipt: true,
				refused: true,
			},
			{ name: 'raw same-ID resume', resume: 'original', early: ['original'], end: undefined },
			{ name: 'unobserved resume', resume: 'original', early: [], end: undefined },
			{ name: 'unobserved new turn', early: [], end: undefined },
			{
				name: 'rejected allocation write',
				early: ['native-new'],
				end: undefined,
				refused: true,
				writeRefused: 'allocation',
			},
			{
				name: 'superseded same-ID write',
				resume: 'original',
				early: ['original'],
				end: undefined,
				refused: true,
				writeRefused: 'check',
			},
			{ name: 'invalid early ID', early: ['\u0000bad'], end: undefined, refused: true },
			{ name: 'blank early ID', early: ['   '], end: undefined, refused: true },
			{ name: 'empty end ID', early: [], end: '', refused: true },
			{ name: 'invalid end ID', early: [], end: 'bad\nend', refused: true },
			{
				name: 'replaced early ID',
				resume: 'original',
				early: ['replacement'],
				end: 'original',
				refused: true,
			},
			{
				name: 'replaced end ID',
				resume: 'original',
				early: ['original'],
				end: 'replacement',
				refused: true,
			},
			{
				name: 'conflicting allocation',
				early: ['native-new', 'replacement'],
				end: 'replacement',
				refused: true,
			},
		])(
			'records Grok identity honestly: $name',
			async ({
				resume,
				early,
				end,
				cancel,
				refused,
				writeRefused,
				mutate,
				late,
				noReceipt,
				missingEnd,
			}) => {
				// Exercise the real repository and recorder around controlled parsed ID observations.
				// The existing inert child still supplies the actual process and cancellation.
				hold = cancel === true;
				recordings.grok = writeFakeTurn(work, {
					chunks: [
						'{"type":"text","data":"answer"}\n',
						...(missingEnd
							? []
							: [
									JSON.stringify({
										type: 'end',
										stopReason: 'EndTurn',
										...(!early.length && end === 'native-new' ? { sessionId: end } : {}),
									}) + '\n',
								]),
					],
					close: { code: 0, signal: null },
				});
				let changeScope: () => void = () => undefined;
				const stopped = Promise.withResolvers<void>();
				const run: RuntimeDeps['turns']['runAgentTurn'] = async (assembled, options) => {
					expect(assembled.resumeSessionId).toBe(resume);
					const started = await fakeProvider(assembled, {
						...options,
						grokLaunchScope: {
							...options.grokLaunchScope!,
							local: { ...options.grokLaunchScope!.local, installationId: () => 'recording-host' },
						},
					});
					if (!started.ok) return started;
					return {
						ok: true,
						run: {
							...started.run,
							...(noReceipt ? { nativeLaunchReceipt: undefined } : {}),
							interrupt: () => {
								started.run.interrupt();
								stopped.resolve();
							},
							events: (async function* () {
								if (late) await stopped.promise;
								for (const sessionId of early) yield { type: 'system' as const, sessionId };
								if (mutate) {
									value(await runtime.agents.update('a1', { provider: 'codex' }));
									changeScope();
								}
								for await (const event of started.run.events) yield event;
							})(),
							result: started.run.result.then((completed) => ({
								...completed,
								sessionId: !early.length && end === 'native-new' ? completed.sessionId : end,
								usage: {
									inputTokens: 7,
									outputTokens: 3,
									cacheReadInputTokens: 0,
									cacheCreationInputTokens: 0,
									totalCostUsd: 0.01,
									contextWindow: 200_000,
								},
							})),
						},
					};
				};
				if (writeRefused || mutate) {
					const create = repositories.createAgentRepository;
					vi.spyOn(repositories, 'createAgentRepository').mockImplementationOnce((options) => {
						const repository = create(options);
						// A foreign settings snapshot can arrive outside the public busy edit guard.
						const get = repository.getAgent.bind(repository);
						changeScope = () => {
							vi.spyOn(repository, 'getAgent').mockImplementation((id) => {
								const agent = get(id);
								return (
									agent && {
										...agent,
										cwd: path.join(work, 'changed'),
										parentSessionId: 'changed-parent',
										sessionSshRemoteConfig: { enabled: true, remoteId: 'changed-host' },
									}
								);
							});
						};
						const record = repository.recordTabSession.bind(repository);
						vi.spyOn(repository, 'recordTabSession').mockImplementation((...args) => {
							if (writeRefused && args[3].agentSessionId) {
								// Queue a real successor ahead of the original guarded mutation.
								const successor = repository.beginTurn('a1', 't1', {
									turnId: 'successor',
									provider: 'grok',
									consumedMergedContext: false,
									userEntry: {
										id: 'successor-entry',
										source: 'user',
										text: 'successor',
										timestamp: T0,
									},
								});
								const pending = record(...args);
								return successor.then((result) => {
									value(result);
									return pending;
								});
							}
							return record(...args);
						});
						return repository;
					});
				}
				const unknownBinding = { version: 1, state: 'unknown', reason: 'unobserved' };
				const resumeBinding = {
					version: 1,
					state: 'bound',
					provider: 'grok',
					nativeSessionId: resume,
					cwd: fs.realpathSync(work),
					accountRef: nativeAccountRef('grok', fs.realpathSync(work)),
					host: { kind: 'local', identity: 'recording-host' },
				};
				const binding = noReceipt
					? unknownBinding
					: { ...resumeBinding, nativeSessionId: resume ?? 'native-new' };
				const runtime = await startWith(
					{ turns: { runAgentTurn: run } },
					seedAgent({
						toolType: 'grok',
						customEnvVars: { GROK_HOME: work },
						aiTabs: [
							{
								id: 't1',
								agentSessionId: resume ?? null,
								name: null,
								logs: [],
								...(resume ? { nativeSessionBinding: resumeBinding } : {}),
							},
						],
					})
				);
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: 'identity recording' }));
				if (cancel) {
					await saw(turn, late ? 'started' : 'session');
					if (late) expect((await tabOf(runtime)).agentSessionId).toBeNull();
					value(await runtime.turns.interrupt('a1', 't1'));
					await saw(turn, 'session');
					// A genuine allocation survives Stop, including one observed during drainage.
					expect(sessions().sessions[0].aiTabs[0]).toMatchObject({
						agentSessionId: 'native-new',
						nativeSessionBinding: binding,
					});
				}
				await turn.outcome();
				const retained =
					resume ??
					(writeRefused
						? null
						: early[0] === 'native-new'
							? 'native-new'
							: !refused
								? end
								: null) ??
					null;
				const observed = refused ? undefined : (end ?? early[0]);
				const current = await tabOf(runtime);
				const tab = mutate
					? (current.providerSessions as Record<string, typeof current>).grok
					: current;
				expect(tab.agentSessionId).toBe(retained);
				expect(current.runtimeTurnId).toEqual(writeRefused ? 'successor' : expect.any(String));
				if (retained) expect(tab.nativeSessionBinding).toEqual(resume ? resumeBinding : binding);
				else expect(tab.nativeSessionBinding).toBeUndefined();
				expect(turn.outcomes()).toEqual([
					refused || missingEnd ? 'crashed' : cancel ? 'interrupted' : 'completed',
				]);
				const sessionIds = turn.events.flatMap((event) =>
					event.kind === 'session' ? [event.providerSessionId] : []
				);
				expect(sessionIds).toEqual(
					!resume && !writeRefused && early[0] === 'native-new'
						? ['native-new']
						: !refused && end
							? [end]
							: []
				);
				const history = readHistory(runtime.paths, 'a1');
				if (refused || cancel || missingEnd) expect(history.status).toBe('missing');
				else {
					if (history.status !== 'ok') throw new Error(`history ${history.status}`);
					expect(history.entries).toHaveLength(1);
					expect(history.entries[0].projectPath).toBe(fs.realpathSync(work));
					expect(history.entries[0].agentSessionId).toBe(observed);
					expect(history.entries[0].nativeSessionBinding).toEqual(
						observed ? binding : unknownBinding
					);
				}
				if (writeRefused) {
					expect(await transcript(runtime)).toEqual([
						expect.objectContaining({ text: 'identity recording', source: 'user' }),
						expect.objectContaining({ id: 'successor-entry', text: 'successor' }),
					]);
					expect(sessions().sessions[0].aiTabs[0].runtimeTurnId).toBe('successor');
				}
				if (refused) {
					expect(tab.usageStats).toBeUndefined();
					expect(turn.events).toContainEqual(
						expect.objectContaining({
							kind: 'error',
							error: expect.objectContaining({ type: 'session_not_found', recoverable: false }),
						})
					);
				} else expect(tab.usageStats).toMatchObject({ inputTokens: 7, outputTokens: 3 });
			}
		);

		it.each([false, true])('fences pre-begin removal (recreate=%s)', async (recreate) => {
			let repository: repositories.AgentRepository;
			const create = repositories.createAgentRepository;
			vi.spyOn(repositories, 'createAgentRepository').mockImplementationOnce((options) => {
				repository = create(options);
				return repository;
			});
			recordings.grok = writeFakeTurn(work, { chunks: [], close: { code: 0, signal: null } });
			const runtime = await startWith(
				{
					rules: { ...deps().rules!, newId: () => 't1' },
					turns: {
						runAgentTurn: async (assembled, options) => {
							const started = await fakeProvider(assembled, options);
							expect(started.ok).toBe(true);
							value(await repository.closeTab('a1', 't1'));
							if (recreate) expect(value(await repository.createTab('a1')).tabId).toBe('t1');
							return started;
						},
					},
				},
				seedAgent({ toolType: 'grok', customEnvVars: { GROK_HOME: work } })
			);
			const events = watch(runtime);
			expect(errorOf(await runtime.turns.send('a1', 't1', { text: 'stale message' })).code).toBe(
				'failed'
			);
			expect(events.kinds()).not.toContain('user');
			expect(readHistory(runtime.paths, 'a1').status).toBe('missing');
			const stored = sessions().sessions[0].aiTabs.find((tab: { id: string }) => tab.id === 't1');
			if (recreate) {
				expect(stored.logs).toEqual([]);
				expect(stored.runtimeTurnId).toBeUndefined();
				expect(stored.usageStats).toBeUndefined();
			} else expect(stored).toBeUndefined();
		});

		it.each([
			{ stage: 'invalid', change: 'id', rawId: '' },
			{ stage: 'invalid', change: 'id', rawId: 7 },
			{ stage: 'launch', change: 'none' },
			...['context', 'launch'].flatMap((stage) =>
				['id', 'binding', 'account', 'ssh'].map((change) => ({ stage, change }))
			),
		])('refuses Grok resume without replacing history: $stage / $change', async (test) => {
			// Keep launch assembly valid so the native ownership guard supplies the refusal.
			recordings.grok = writeFakeTurn(work, { chunks: [], close: { code: 0, signal: null } });
			let repository: ReturnType<typeof repositories.createAgentRepository>;
			const create = repositories.createAgentRepository;
			vi.spyOn(repositories, 'createAgentRepository').mockImplementationOnce((options) => {
				repository = create(options);
				return repository;
			});
			const binding = { version: 1, state: 'unknown', reason: 'legacy' } as const;
			const changeSelection = () => {
				const tab = repository.getTab('a1', 't1')!;
				if (test.change === 'id') tab.agentSessionId = 'replacement';
				if (test.change === 'binding')
					Object.assign(tab.nativeSessionBinding!, { reason: 'unobserved' });
				if (test.change === 'account' || test.change === 'ssh') {
					const get = repository.getAgent.bind(repository);
					vi.spyOn(repository, 'getAgent').mockImplementation((id) => {
						const agent = get(id);
						return (
							agent && {
								...agent,
								...(test.change === 'account'
									? { customEnvVars: { GROK_HOME: path.join(work, 'other-account') } }
									: { sessionSshRemoteConfig: { enabled: true, remoteId: 'other-host' } }),
							}
						);
					});
				}
			};
			const launch = vi.fn<NonNullable<RuntimeDeps['turns']['runAgentTurn']>>(
				async (assembled, options) => {
					expect(assembled.resumeSessionId).toBe('original');
					expect(options.retainedNativeSessionBinding).toEqual(binding);
					expect(options.retainedNativeSessionBinding).not.toBe(
						repository.getTab('a1', 't1')!.nativeSessionBinding
					);
					expect(options.recheckNativeSelection?.()).toBe(true);
					if (test.stage === 'launch') changeSelection();
					expect(options.retainedNativeSessionBinding).toEqual(binding);
					expect(options.recheckNativeSelection?.()).toBe(test.change === 'none');
					const result = await fakeProvider(assembled, options);
					expect(result).toMatchObject({ ok: false, reason: 'grok-native-session-refused' });
					expect(result).not.toHaveProperty('run');
					return result;
				}
			);
			const oldLog = {
				id: 'original-answer',
				source: 'ai',
				text: 'retained answer',
				timestamp: T0,
			};
			const oldUsage = { inputTokens: 9, outputTokens: 4, totalCostUsd: 0.02 };
			const runtime = await startWith(
				{
					turns: {
						runAgentTurn: launch,
						probeBinary: async () => {
							if (test.stage === 'context') changeSelection();
							return { exists: true, path: process.execPath };
						},
					},
				},
				seedAgent({
					toolType: 'grok',
					customEnvVars: { GROK_HOME: work },
					aiTabs: [
						{
							id: 't1',
							agentSessionId: 'rawId' in test ? test.rawId : 'original',
							nativeSessionBinding: binding,
							logs: [oldLog],
							usageStats: oldUsage,
						},
					],
				})
			);
			const historyFile = path.join(runtime.paths.historyDir, 'a1.jsonl');
			fs.mkdirSync(runtime.paths.historyDir, { recursive: true });
			const oldHistory =
				JSON.stringify({
					id: 'old',
					type: 'USER',
					timestamp: T0,
					summary: 'old',
					sessionId: 'a1',
					agentSessionId: 'original',
					usageStats: oldUsage,
				}) + '\n';
			fs.writeFileSync(historyFile, oldHistory);
			const before = sessions().sessions[0].aiTabs[0];
			const turn = watch(runtime);
			const result = await runtime.turns.send('a1', 't1', { text: 'resume original' });
			expect(errorOf(result).message).toContain('Grok');
			expect(launch).toHaveBeenCalledTimes(test.stage === 'launch' ? 1 : 0);
			expect(ran()).toEqual([]);
			expect(await transcript(runtime)).toEqual([oldLog]);
			expect(
				turn.events.some((event) => ['started', 'session', 'outcome'].includes(event.kind))
			).toBe(false);
			expect(fs.readFileSync(historyFile, 'utf-8')).toBe(oldHistory);
			expect(sessions().sessions[0].aiTabs[0]).toEqual(before);
		});
	});
});
