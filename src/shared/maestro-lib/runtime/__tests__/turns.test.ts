/**
 * The runtime's turns: send, queue, stop, and swap-and-back, with a fake provider.
 *
 * The provider is `src/__tests__/fixtures/fake-agent.mjs` replaying a real recorded turn, so a
 * turn here is a real process on a real pipe, assembled by the real `assembleTurn` and started by
 * the real `runAgentTurn`; only the command is swapped for the fake agent. The runtime, its
 * repository, its queue, and its records are real and write to a temp data directory.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
import { DEFAULT_TAB_DEFAULTS } from '../../agents/rules';
import type { ClientResult, TurnEvent } from '../../client/types';
import { readHistory } from '../../store/read-history';
import { runAgentTurn } from '../../turns/run-agent-turn';
import { createMaestroRuntime, type MaestroRuntime, type RuntimeDeps } from '../index';
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
	let binaryExists: boolean;

	const watchDirectory: WatchDirectory = () => ({ close: () => undefined });

	const fakeProvider: RuntimeDeps['turns']['runAgentTurn'] = (turn, options) => {
		const argvOut = path.join(work, `argv-${argvFiles.length + 1}.json`);
		argvFiles.push(argvOut);
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

	async function start(sessions: unknown[] = [seedAgent()]): Promise<MaestroRuntime> {
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
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-runtime-turns-'));
		work = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-runtime-turns-work-'));
		open = [];
		hold = false;
		argvFiles = [];
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
		for (const runtime of open) await runtime.connection.close();
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(work, { recursive: true, force: true });
	});

	describe('send', () => {
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
			const runtime = await start();
			const turn = watch(runtime);

			value(await runtime.turns.send('a1', 't1', { text: 'on claude' }));
			await turn.outcome(1);
			expect((await tabOf(runtime)).agentSessionId).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);

			value(await runtime.agents.update('a1', { provider: 'opencode' }));
			expect((await tabOf(runtime)).agentSessionId).toBeNull();

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
});
