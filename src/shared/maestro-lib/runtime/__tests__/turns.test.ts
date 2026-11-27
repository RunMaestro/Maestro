/**
 * The runtime's turns: send, queue, stop, and swap-and-back, with a fake provider.
 *
 * The provider is `src/__tests__/fixtures/fake-agent.mjs` replaying a real recorded turn, so a
 * turn here is a real process on a real pipe, assembled by the real `assembleTurn` and started by
 * the real `runAgentTurn`; only the command is swapped for the fake agent. The runtime, its
 * repository, its queue, and its records are real and write to a temp data directory.
 */
import * as fs from 'fs';
import * as net from 'net';
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
import type { ClientResult, QueuedTurn, QueueExit, TurnEvent } from '../../client/types';
import { MAX_TURN_AGENT_TEXT_CHARS } from '../../client/types';
import type { HistoryEntry } from '../../../types';
import { parseSynopsis } from '../../../synopsis';
import { readHistory } from '../../store/read-history';
import { sharedHistoryDir, sharedHistoryFilename } from '../../store/shared-history';
import { runAgentTurn, type RunAgentTurnOptions } from '../../turns/run-agent-turn';
import { discoverClaudeSkills } from '../../agents/claude-skills';
import {
	formatClaudeSkillsMessage,
	HISTORY_COMMAND_TEXT,
} from '../../../maestroBuiltinCommandText';
import { buildSideQuestionPrompt } from '../../../sideQuestion';
import {
	createMaestroRuntime,
	type MaestroRuntime,
	type MaestroRuntimeOptions,
	type RuntimeDeps,
} from '../index';
import { RUNTIME_LOCK_FILE_NAME } from '../data-dir-lock';
import { MAX_WAITING_TURNS_PER_AGENT } from '../turns';
import type { WatchDirectory } from '../settings-watch';
import { foldLiveTurn } from '../../client/live-turn';

// Passes through: a test counts what the host folds for the transcript (P12).
vi.mock('../../client/live-turn', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../client/live-turn')>();
	return { ...actual, foldLiveTurn: vi.fn(actual.foldLiveTurn) };
});

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
	/** Run each turn as a maestro-p TUI turn, which opens its steering socket. */
	let tui: boolean;
	let argvFiles: string[];
	/** The options each turn was started with. */
	let turnOptions: RunAgentTurnOptions[];
	/** The assembled turns, in launch order: what each turn ran under. */
	let launched: Array<Parameters<typeof runAgentTurn>[0]>;
	let binaryExists: boolean;

	const watchDirectory: WatchDirectory = () => ({ close: () => undefined });

	const fakeProvider: RuntimeDeps['turns']['runAgentTurn'] = async (turn, options) => {
		const argvOut = path.join(work, `argv-${argvFiles.length + 1}.json`);
		argvFiles.push(argvOut);
		turnOptions.push(options);
		launched.push(turn);
		live.now += 1;
		live.max = Math.max(live.max, live.now);
		const started = await runAgentTurn(
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
						FAKE_AGENT_STDIN_OUT: argvOut.replace(/argv-(\d+)\.json$/, 'stdin-$1.txt'),
						...(hold ? { FAKE_AGENT_HOLD: '1' } : {}),
					},
				},
			},
			{ ...options, stopGraceMs: 200 }
		);
		if (!started.ok) live.now -= 1;
		else
			void started.run.result.finally(() => {
				live.now -= 1;
			});
		// A maestro-p TUI turn opens the socket it was given; the fake agent stands in for it.
		if (tui && started.ok && options.steeringSocketPath) {
			return { ...started, run: { ...started.run, steeringSocket: options.steeringSocketPath } };
		}
		return started;
	};
	/** How many provider processes run at once, and the most there ever were. */
	const live = { now: 0, max: 0 };

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
			turns: { runAgentTurn: fakeProvider, homeDir: () => path.join(work, 'home') },
		};
	}

	const seedAgent = (extra: Record<string, unknown> = {}) => ({
		id: 'a1',
		name: 'Alpha',
		toolType: 'claude-code',
		cwd: work,
		projectRoot: work,
		// A tab that saves to History follows each turn with a synopsis turn (P8), so only the tests
		// about History seed one (`savingAgent`); the rest count and read one process per turn.
		aiTabs: [
			{ id: 't1', agentSessionId: null, name: null, logs: [], saveToHistory: false },
			{ id: 't2', agentSessionId: null, name: null, logs: [], saveToHistory: false },
		],
		activeTabId: 't1',
		unifiedTabOrder: [
			{ type: 'ai', id: 't1' },
			{ type: 'ai', id: 't2' },
		],
		...extra,
	});

	/** `seedAgent` with tabs that save to History: each turn's entry comes from a synopsis turn. */
	const savingAgent = (extra: Record<string, unknown> = {}) =>
		seedAgent({
			aiTabs: [
				{ id: 't1', agentSessionId: null, name: null, logs: [] },
				{ id: 't2', agentSessionId: null, name: null, logs: [] },
			],
			...extra,
		});

	/** The agent's History once `count` entries are written (a turn's comes after its synopsis). */
	async function historyWritten(runtime: MaestroRuntime, count = 1): Promise<HistoryEntry[]> {
		let entries: HistoryEntry[] = [];
		await vi.waitFor(
			() => {
				const history = readHistory(runtime.paths, 'a1');
				entries = history.status === 'ok' ? history.entries : [];
				expect(entries).toHaveLength(count);
			},
			{ timeout: 8_000 }
		);
		return entries;
	}

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
		tui = false;
		argvFiles = [];
		live.now = 0;
		live.max = 0;
		turnOptions = [];
		launched = [];
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
			const runtime = await start([savingAgent()]);
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

			const [entry] = await historyWritten(runtime);
			expect(entry).toMatchObject({
				type: 'USER',
				sessionId: 'a1',
				tabId: 't1',
				agentSessionId: CAPTURED_CLAUDE_CODE_SESSION_ID,
			});
		});

		// P8: the host writes a turn's History entry as a desktop does on exit: from a synopsis turn
		// that resumes the turn's session, so the same reply gives the same summary in every mode.
		it("writes the turn's History entry from a synopsis turn, as a desktop does on exit", async () => {
			const runtime = await start([savingAgent()]);
			const turn = watch(runtime);
			value(await runtime.turns.send('a1', 't1', { text: 'what is the capital of France' }));
			await turn.outcome();
			const [entry] = await historyWritten(runtime);

			// One synopsis turn followed, on the turn's own conversation, under the synopsis prompt.
			expect(launched).toHaveLength(2);
			expect(launched[1].resumeSessionId).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);
			const synopsisPrompt = fs.readFileSync(
				path.join(BUNDLED_PROMPTS, 'autorun-synopsis.md'),
				'utf-8'
			);
			expect(launched[1].prompt).toContain(synopsisPrompt.trim().split('\n')[0]);
			// The entry is the synopsis' (the fake replays the same reply for it), not the answer's lines.
			const answer = (await transcript(runtime)).find((e) => e.source === 'stdout')!.text;
			const synopsis = parseSynopsis(answer);
			expect(entry).toMatchObject({
				type: 'USER',
				summary: synopsis.shortSummary,
				fullResponse: synopsis.fullSynopsis,
				agentSessionId: CAPTURED_CLAUDE_CODE_SESSION_ID,
				tabId: 't1',
			});
			// The synopsis wrote nothing to the tab, which reads as the turn left it.
			expect((await transcript(runtime)).map((e) => e.source)).toEqual(['user', 'stdout']);

			// The next turn's synopsis covers only the work since this one.
			value(await runtime.turns.send('a1', 't1', { text: 'and of Spain' }));
			await turn.outcome(2);
			await historyWritten(runtime, 2);
			expect(launched[3].prompt).toContain('Only synopsize work done since the last synopsis');
		});

		// P7: a 'sticky' tab keeps the turn's thinking and tool cards past the turn's end, as a local
		// tab's exit cleanup does; an 'on' tab drops them (`logsKeptAtTurnEnd()`). T2: a Claude reply
		// is a thinking chunk too (`partialTextRoute()`), so a sticky tab keeps its copy, as a local
		// and an SSH tab do.
		it.each([
			['sticky', ['user', 'thinking', 'tool', 'thinking', 'stdout']],
			['on', ['user', 'stdout']],
		])(
			'keeps what a %s tab keeps of the thinking and tool cards',
			async (showThinking, sources) => {
				const line = (obj: unknown) => JSON.stringify(obj) + '\n';
				const session = 'sess-sticky-1';
				recordings['claude-code'] = writeFakeTurn(work, {
					chunks: [
						line({ type: 'system', subtype: 'init', session_id: session }),
						line({
							type: 'assistant',
							message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Plan it.' }] },
						}),
						line({
							type: 'assistant',
							message: {
								role: 'assistant',
								content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }],
							},
						}),
						line({
							type: 'assistant',
							message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
						}),
						line({ type: 'result', result: 'Done.', session_id: session }),
					],
					close: { code: 0, signal: null },
				});
				const runtime = await start([
					seedAgent({
						aiTabs: [{ id: 't1', agentSessionId: null, name: null, logs: [], showThinking }],
					}),
				]);
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: 'read it' }));
				await turn.outcome();

				const entries = await transcript(runtime);
				expect(entries.map((entry) => entry.source)).toEqual(sources);
				if (showThinking === 'sticky') {
					expect(entries[1].text).toBe('Plan it.');
					expect(entries[2]).toMatchObject({ source: 'tool', text: 'Read' });
					expect(entries[3]).toMatchObject({ source: 'thinking', text: 'Done.' });
				}
				expect(entries.at(-1)?.text).toBe('Done.');
			}
		);

		// P12: the host folds the cards only a sticky tab keeps, never the answer text, and nothing
		// for any other tab. T2: each Claude text partial is a thinking chunk (`partialTextRoute()`),
		// said once, so the chunks of one block stay one card; the result's answer closes the block.
		it.each([
			['sticky', ['thinking', 'thinking', 'thinking', 'tool', 'thinking', 'thinking', 'text']],
			['on', []],
			['off', []],
		])('folds only what a %s tab keeps past the turn', async (showThinking, folded) => {
			const line = (obj: unknown) => JSON.stringify(obj) + '\n';
			const session = 'sess-fold-1';
			const say = (content: unknown[]) =>
				line({ type: 'assistant', message: { role: 'assistant', content } });
			recordings['claude-code'] = writeFakeTurn(work, {
				chunks: [
					line({ type: 'system', subtype: 'init', session_id: session }),
					say([{ type: 'thinking', thinking: 'Plan it.' }]),
					say([{ type: 'text', text: 'Reading. ' }]),
					say([{ type: 'text', text: 'Still reading. ' }]),
					say([{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }]),
					say([{ type: 'thinking', thinking: 'Now answer.' }]),
					say([{ type: 'text', text: 'Done.' }]),
					line({ type: 'result', result: 'Done.', session_id: session }),
				],
				close: { code: 0, signal: null },
			});
			const runtime = await start([
				seedAgent({
					aiTabs: [{ id: 't1', agentSessionId: null, name: null, logs: [], showThinking }],
				}),
			]);
			vi.mocked(foldLiveTurn).mockClear();
			const turn = watch(runtime);
			value(await runtime.turns.send('a1', 't1', { text: 'read it' }));
			await turn.outcome();

			expect(vi.mocked(foldLiveTurn).mock.calls.map(([, event]) => event.kind)).toEqual(folded);
			const sources = (await transcript(runtime)).map((entry) => entry.source);
			expect(sources).toEqual(
				showThinking === 'sticky'
					? ['user', 'thinking', 'tool', 'thinking', 'stdout']
					: ['user', 'stdout']
			);
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
			const ownEntries = (runtime: MaestroRuntime) => historyWritten(runtime);

			it('stamps the entry with the machine the send names, and copies it to the project', async () => {
				fs.mkdirSync(sharedHistoryDir(work), { recursive: true });
				const runtime = await start([savingAgent()], SHARED);
				const turn = watch(runtime);
				value(
					await runtime.turns.send('a1', 't1', { text: 'hello', originHost: '  laptop.local ' })
				);
				await turn.outcome();

				const [own] = await ownEntries(runtime);
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
				const runtime = await start([savingAgent()], SHARED);
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: 'hello', originHost: 'bad\u0007host' }));
				await turn.outcome();

				const [own] = await ownEntries(runtime);
				expect(own).not.toHaveProperty('hostname');
				expect(readShared()[0]).toMatchObject({ id: own.id, hostname: 'box' });
			});

			it('copies nothing for a project that does not share, or without a shared identity', async () => {
				const runtime = await start([savingAgent()], SHARED);
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: 'hello' }));
				await turn.outcome();
				expect(await ownEntries(runtime)).toHaveLength(1);
				expect(fs.existsSync(sharedHistoryDir(work))).toBe(false);
			});

			it('copies nothing without a shared identity, even where the project shares', async () => {
				fs.mkdirSync(sharedHistoryDir(work), { recursive: true });
				const runtime = await start([savingAgent()]);
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: 'hello' }));
				await turn.outcome();
				expect(await ownEntries(runtime)).toHaveLength(1);
				expect(fs.readdirSync(sharedHistoryDir(work))).toEqual([]);
			});

			it('lists the other writers entries with the agent own, newest first', async () => {
				fs.mkdirSync(sharedHistoryDir(work), { recursive: true });
				fs.writeFileSync(
					path.join(sharedHistoryDir(work), sharedHistoryFilename('laptop')),
					`${JSON.stringify({ id: 'from-laptop', type: 'USER', timestamp: 1, summary: 's', projectPath: work })}\n`
				);
				const runtime = await start([savingAgent()], SHARED);
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: 'hello' }));
				await turn.outcome();
				await historyWritten(runtime);
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
				message: 'Grok CLI cannot read images. Send the message without them.',
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
			expect(errorOf(await runtime.turns.send('nope', 't1', { text: 'x' })).code).toBe('not-found');
			expect(errorOf(await runtime.turns.send('a1', 'nope', { text: 'x' })).code).toBe('not-found');
			expect(argvFiles).toEqual([]);
		});

		describe('images (M1: a headless host takes a pasted image as a desktop host does)', () => {
			const PNG = 'data:image/png;base64,iVBORw0KGgo=';
			const JPEG = 'data:image/jpeg;base64,/9j/4AAQ';
			const stdinOf = (index: number) =>
				fs.readFileSync(argvFiles[index].replace(/argv-(\d+)\.json$/, 'stdin-$1.txt'), 'utf-8');

			it("hands the provider the message's images, and keeps them on the transcript's user entry", async () => {
				const runtime = await start();
				const turn = watch(runtime);

				expect(
					value(
						await runtime.turns.send('a1', 't1', { text: 'what is this?', images: [PNG, JPEG] })
					)
				).toEqual({ status: 'started' });
				await turn.outcome();

				expect(turn.outcomes()).toEqual(['completed']);
				const argv = JSON.parse(fs.readFileSync(argvFiles[0], 'utf-8')) as string[];
				expect(argv.slice(-2)).toEqual(['--input-format', 'stream-json']);
				const message = JSON.parse(stdinOf(0).trim());
				expect(message.message.content.map((block: { type: string }) => block.type)).toEqual([
					'image',
					'image',
					'text',
				]);
				expect(turn.events.find((event) => event.kind === 'user')).toMatchObject({
					entry: { text: 'what is this?', images: [PNG, JPEG] },
				});
				expect((await transcript(runtime))[0]).toMatchObject({
					source: 'user',
					text: 'what is this?',
					images: [PNG, JPEG],
				});
			});

			it('runs an image-only message, as the desktop does', async () => {
				const runtime = await start();
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: '', images: [PNG] }));
				await turn.outcome();
				expect(turn.outcomes()).toEqual(['completed']);
				expect((await transcript(runtime))[0]).toMatchObject({ source: 'user', images: [PNG] });
			});

			it.each([
				['a store ref from another machine', ['maestro-image://sha256/abc']],
				['a value that is not an image', ['data:text/plain;base64,aGk=']],
				['bytes that are not base64', ['data:image/png;base64,@@@@']],
				['more images than a message may carry', Array.from({ length: 21 }, () => PNG)],
				// M12: a malformed field refuses the send; it never becomes a text-only message.
				['images that are not a list', PNG],
				['a non-string entry beside a good image', [42, PNG]],
				// M11: only the types a provider reads (the desktop's own list).
				['an SVG', ['data:image/svg+xml;base64,PHN2Zy8+']],
			])('refuses %s, and starts nothing', async (_label, images) => {
				const runtime = await start();
				const error = errorOf(
					await runtime.turns.send('a1', 't1', { text: 'x', images: images as string[] })
				);
				expect(error.code).toBe('invalid');
				expect(error.message).toMatch(/image/i);
				expect(argvFiles).toEqual([]);
				expect(value(await runtime.turns.queue.list('a1'))).toEqual([]);
			});
		});

		describe("images in the host's image store (M10: refs in the store, bytes only on the wire)", () => {
			const PNG = 'data:image/png;base64,iVBORw0KGgo=';
			const imagesDir = () => path.join(dir, 'session-images');
			const sessionsText = () => fs.readFileSync(path.join(dir, 'maestro-sessions.json'), 'utf-8');
			const storedUserEntry = () =>
				(
					sessions().sessions[0].aiTabs[0].logs as Array<{ source: string; images?: string[] }>
				).find((entry) => entry.source === 'user');

			it('keeps a pasted image as a file and its ref on the stored entry, and hands out the bytes', async () => {
				const runtime = await start();
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: 'what is this?', images: [PNG] }));
				await turn.outcome();

				// The sessions file holds the ref, never the bytes.
				expect(sessionsText()).not.toContain('base64,');
				const [ref] = storedUserEntry()!.images!;
				expect(ref).toMatch(/^maestro-image:\/\/store\/[0-9a-f]{64}\.png$/);
				const file = path.join(imagesDir(), ref.slice('maestro-image://store/'.length));
				expect(fs.readFileSync(file).toString('base64')).toBe('iVBORw0KGgo=');

				// The provider still gets the bytes, and so do a transcript read and the live event.
				const stdin = fs.readFileSync(
					argvFiles[0].replace(/argv-(\d+)\.json$/, 'stdin-$1.txt'),
					'utf-8'
				);
				expect(JSON.parse(stdin.trim()).message.content[0].source.data).toBe('iVBORw0KGgo=');
				expect((await transcript(runtime))[0]).toMatchObject({ images: [PNG] });
				expect(turn.events.find((event) => event.kind === 'user')).toMatchObject({
					entry: { images: [PNG] },
				});
			});

			it('moves an inline image the store already held (an older host, an import) out on the next write', async () => {
				const runtime = await start([
					seedAgent({
						aiTabs: [
							{
								id: 't1',
								agentSessionId: null,
								name: null,
								logs: [{ id: 'old', timestamp: 1, source: 'user', text: 'old', images: [PNG] }],
							},
						],
					}),
				]);
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: 'next' }));
				await turn.outcome();

				expect(sessionsText()).not.toContain('base64,');
				expect(storedUserEntry()!.images![0]).toMatch(/^maestro-image:\/\/store\//);
				expect((await transcript(runtime))[0]).toMatchObject({ text: 'old', images: [PNG] });
			});

			it('keeps a waiting message on its refs, and lists the bytes on the card', async () => {
				hold = true;
				const runtime = await start();
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: 'first' }));
				await turn.started();
				const queued = value(await runtime.turns.send('a1', 't1', { text: 'look', images: [PNG] }));
				if (queued.status !== 'queued') throw new Error('expected queued');

				expect(fs.readdirSync(imagesDir())).toHaveLength(1);
				expect(value(await runtime.turns.queue.list('a1'))[0]).toMatchObject({ images: [PNG] });

				value(await runtime.turns.queue.remove('a1', queued.itemId));
				value(await runtime.turns.interrupt('a1', 't1'));
				await turn.outcome();
			});

			it(`refuses a send past ${MAX_WAITING_TURNS_PER_AGENT} waiting messages, with the reason`, async () => {
				hold = true;
				const runtime = await start();
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: 'first' }));
				await turn.started();
				for (let index = 0; index < MAX_WAITING_TURNS_PER_AGENT; index += 1) {
					expect(value(await runtime.turns.send('a1', 't1', { text: `m${index}` })).status).toBe(
						'queued'
					);
				}
				const refused = errorOf(await runtime.turns.send('a1', 't1', { text: 'one too many' }));
				expect(refused).toMatchObject({ code: 'rejected' });
				expect(refused.message).toContain(`${MAX_WAITING_TURNS_PER_AGENT} messages waiting`);
				expect(value(await runtime.turns.queue.list('a1'))).toHaveLength(
					MAX_WAITING_TURNS_PER_AGENT
				);

				for (const item of value(await runtime.turns.queue.list('a1'))) {
					value(await runtime.turns.queue.remove('a1', item.itemId));
				}
				value(await runtime.turns.interrupt('a1', 't1'));
				await turn.outcome();
			});
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

		// `/wizard` and `/btw` draw in the composer of the window that typed them, so a remote send
		// cannot run them anywhere; here they would reach the provider as a message, so they are
		// refused and nothing runs.
		it.each(['/wizard plan it', '/btw why?'])(
			'refuses Maestro command %s, which needs the typing window, and starts nothing',
			async (command) => {
				const runtime = await start([seedAgent({ toolType: 'claude-code' })]);
				const turn = watch(runtime);
				const error = errorOf(await runtime.turns.send('a1', 't1', { text: command }));
				expect(error).toMatchObject({
					code: 'unsupported',
					message: `${command.split(' ')[0]} runs in the composer of the window that typed it, so it cannot run from here.`,
				});
				expect(argvFiles).toEqual([]);
				expect(turn.events).toEqual([]);
				expect(value(await runtime.turns.queue.list('a1'))).toEqual([]);
			}
		);

		describe('/history and /skills (M5: a headless host runs them as a desktop host does)', () => {
			const transcriptLines = async (runtime: MaestroRuntime) =>
				(await transcript(runtime)).map((entry) => [entry.source, entry.text]);
			const settle = (runtime: MaestroRuntime, lines: number) =>
				vi.waitFor(async () => expect((await transcript(runtime)).length).toBe(lines), {
					timeout: 8_000,
				});

			it('lists the project and user skills on the tab, as the desktop does', async () => {
				const skill = (root: string, name: string, description: string) => {
					fs.mkdirSync(path.join(root, '.claude', 'skills', name), { recursive: true });
					fs.writeFileSync(
						path.join(root, '.claude', 'skills', name, 'SKILL.md'),
						`---\nname: ${name}\ndescription: ${description}\n---\nBody`
					);
				};
				skill(work, 'review', 'Reviews code');
				skill(path.join(work, 'home'), 'notes', 'Takes notes');
				const runtime = await start();
				const turn = watch(runtime);

				expect(value(await runtime.turns.send('a1', 't1', { text: '/skills' }))).toEqual({
					status: 'ran',
				});
				await settle(runtime, 2);

				const lines = await transcriptLines(runtime);
				expect(lines[0]).toEqual(['user', '/skills']);
				expect(lines[1][0]).toBe('system');
				expect(lines[1][1]).toBe(
					formatClaudeSkillsMessage(await discoverClaudeSkills(work, path.join(work, 'home')))
				);
				expect(lines[1][1]).toContain('| **review** |');
				expect(lines[1][1]).toContain('| **notes** |');
				expect(argvFiles).toEqual([]);
				// The clients are told to read the tab again; no turn started.
				expect(turn.kinds()).toEqual(['gap', 'gap']);
			});

			it('hands a busy tab its /skills rows as live entries of the running turn, not a re-read (M13)', async () => {
				hold = true;
				const runtime = await start();
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: 'first' }));
				await turn.started();

				expect(value(await runtime.turns.send('a1', 't1', { text: '/skills' }))).toEqual({
					status: 'ran',
				});
				await vi.waitFor(
					() => expect(turn.kinds().filter((kind) => kind === 'user')).toHaveLength(3),
					{ timeout: 8_000 }
				);
				const live = turn.events.flatMap((event) => (event.kind === 'user' ? [event.entry] : []));
				expect(live.slice(1).map((entry) => [entry.source, entry.text.split('\n')[0]])).toEqual([
					['user', '/skills'],
					['system', expect.stringContaining('Skills')],
				]);
				// A `gap` mid-turn would make a client drop the turn's live text.
				expect(turn.kinds()).not.toContain('gap');
				value(await runtime.turns.interrupt('a1', 't1'));
				await turn.outcome();
			});

			it('says there is no session yet, and writes no History', async () => {
				const runtime = await start();
				value(await runtime.turns.send('a1', 't1', { text: '/history' }));
				await settle(runtime, 1);
				expect(await transcriptLines(runtime)).toEqual([
					['system', HISTORY_COMMAND_TEXT.noSession],
				]);
				expect(argvFiles).toEqual([]);
			});

			it('resumes the tab session for a synopsis, writes the History entry, and says it saved', async () => {
				const runtime = await start();
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: 'hello' }));
				await turn.outcome();

				expect(value(await runtime.turns.send('a1', 't1', { text: '/history' }))).toEqual({
					status: 'ran',
				});
				await vi.waitFor(
					async () => expect((await transcript(runtime)).at(-1)?.text).toMatch(/^Synopsis saved/),
					{ timeout: 8_000 }
				);

				// One line per run, as on the desktop: the outcome replaced the progress line (M22).
				const lines = await transcriptLines(runtime);
				expect(lines).toHaveLength(3);
				expect(lines[2][0]).toBe('system');
				expect(lines[2][1]).toMatch(/^Synopsis saved to history: /);
				// The synopsis resumed the tab's own conversation.
				const argv = JSON.parse(fs.readFileSync(argvFiles[1], 'utf-8')) as string[];
				expect(argv).toContain(CAPTURED_CLAUDE_CODE_SESSION_ID);
				const history = readHistory(runtime.paths, 'a1');
				const auto = (history.status === 'ok' ? history.entries : []).filter(
					(entry) => entry.type === 'AUTO'
				);
				expect(auto).toHaveLength(1);
				expect(lines[2][1]).toBe(HISTORY_COMMAND_TEXT.saved(auto[0].summary));
			});

			it('never runs two writers on one provider session: /history twice and a send take turns', async () => {
				const runtime = await start([
					seedAgent({
						aiTabs: [
							{
								id: 't1',
								agentSessionId: CAPTURED_CLAUDE_CODE_SESSION_ID,
								name: null,
								logs: [],
								saveToHistory: false,
							},
						],
						unifiedTabOrder: [{ type: 'ai', id: 't1' }],
					}),
				]);
				const turn = watch(runtime);
				await Promise.all([
					runtime.turns.send('a1', 't1', { text: '/history' }),
					runtime.turns.send('a1', 't1', { text: '/history' }),
				]);
				value(await runtime.turns.send('a1', 't1', { text: 'hello' }));
				await turn.outcome();
				await vi.waitFor(
					async () =>
						expect(
							(await transcript(runtime)).filter((entry) =>
								entry.text.startsWith('Synopsis saved to history: ')
							)
						).toHaveLength(2),
					{ timeout: 8_000 }
				);
				expect(argvFiles).toHaveLength(3);
				expect(live.max).toBe(1);
			});

			it('holds a send behind a long synopsis without spending its retries, so it never pauses', async () => {
				hold = true;
				const base = deps();
				const runtime = await start(
					[
						seedAgent({
							aiTabs: [
								{
									id: 't1',
									agentSessionId: CAPTURED_CLAUDE_CODE_SESSION_ID,
									name: null,
									logs: [],
									saveToHistory: false,
								},
							],
							unifiedTabOrder: [{ type: 'ai', id: 't1' }],
						}),
					],
					// A 1 ms recheck: a send that collided with the hold would spend its six attempts at once.
					{ deps: { ...base, turns: { ...base.turns!, recheckMs: 1 } } }
				);
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: '/history' }));
				await vi.waitFor(() => expect(argvFiles).toHaveLength(1), { timeout: 8_000 });

				expect(value(await runtime.turns.send('a1', 't1', { text: 'hello' }))).toMatchObject({
					status: 'queued',
				});
				await new Promise((resolve) => setTimeout(resolve, 200));
				expect(value(await runtime.turns.queue.list('a1'))).toEqual([
					expect.objectContaining({ text: 'hello', paused: false }),
				]);
				expect(turn.kinds()).not.toContain('error');
				expect(argvFiles).toHaveLength(1);
			});

			it('summarizes the session the tab holds once its turn ends, not the one it had before', async () => {
				hold = true;
				const runtime = await start([
					seedAgent({
						aiTabs: [{ id: 't1', agentSessionId: 'session-before', name: null, logs: [] }],
						unifiedTabOrder: [{ type: 'ai', id: 't1' }],
					}),
				]);
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: 'hello' }));
				// The turn has moved the tab to the provider's new session before /history is typed.
				await vi.waitFor(() => expect(turn.kinds()).toContain('session'), { timeout: 8_000 });
				value(await runtime.turns.send('a1', 't1', { text: '/history' }));
				hold = false;
				value(await runtime.turns.interrupt('a1', 't1'));
				await turn.outcome();
				await vi.waitFor(() => expect(argvFiles).toHaveLength(2), { timeout: 8_000 });
				// The outcome takes the progress line's place, where /history was typed (M22).
				await vi.waitFor(
					async () =>
						expect(
							(await transcript(runtime)).some((entry) => /^Synopsis saved/.test(entry.text))
						).toBe(true),
					{ timeout: 8_000 }
				);
				expect((await transcript(runtime)).map((entry) => entry.text)).not.toContain(
					HISTORY_COMMAND_TEXT.pending
				);
				const argv = JSON.parse(fs.readFileSync(argvFiles[1], 'utf-8')) as string[];
				expect(argv).toContain(CAPTURED_CLAUDE_CODE_SESSION_ID);
				expect(argv).not.toContain('session-before');
			});

			it('goes ahead when the turn it waited for could not start, instead of waiting forever', async () => {
				const runtime = await start([
					seedAgent({
						aiTabs: [{ id: 't1', agentSessionId: 'session-1', name: null, logs: [] }],
						unifiedTabOrder: [{ type: 'ai', id: 't1' }],
					}),
				]);
				binaryExists = false;
				const sent = runtime.turns.send('a1', 't1', { text: 'hello' });
				value(await runtime.turns.send('a1', 't1', { text: '/history' }));
				expect(errorOf(await sent).code).toBe('failed');
				await vi.waitFor(
					async () =>
						expect((await transcript(runtime)).map((entry) => entry.text)).toEqual([
							HISTORY_COMMAND_TEXT.failed,
						]),
					{ timeout: 8_000 }
				);
			});

			it("stops a tab's synopsis when the tab closes, and when the host shuts down", async () => {
				const seeded = () =>
					seedAgent({
						aiTabs: [
							{ id: 't1', agentSessionId: 'session-1', name: null, logs: [] },
							{ id: 't2', agentSessionId: 'session-2', name: null, logs: [] },
						],
					});
				hold = true;
				const runtime = await start([seeded()]);
				value(await runtime.turns.send('a1', 't2', { text: '/history' }));
				await vi.waitFor(() => expect(live.now).toBe(1), { timeout: 8_000 });
				value(await runtime.tabs.close('a1', 't2'));
				await vi.waitFor(() => expect(live.now).toBe(0), { timeout: 8_000 });

				value(await runtime.turns.send('a1', 't1', { text: '/history' }));
				await vi.waitFor(() => expect(live.now).toBe(1), { timeout: 8_000 });
				await runtime.connection.close();
				await vi.waitFor(() => expect(live.now).toBe(0), { timeout: 8_000 });
			});

			it('queues a held /history as a message, as Queue Held does on a desktop', async () => {
				const runtime = await start();
				const held = value(await runtime.turns.send('a1', 't1', { text: '/history', held: true }));
				expect(held).toMatchObject({ status: 'queued' });
				expect(value(await runtime.turns.queue.list('a1'))).toEqual([
					expect.objectContaining({ text: '/history', paused: true }),
				]);
			});
		});

		describe('/btw side questions (M6: a headless host forks its tab, as a desktop host does)', () => {
			const ask = (runtime: MaestroRuntime, extra: Record<string, unknown> = {}) =>
				runtime.consults.ask({
					targetAgentId: 'a1',
					targetTabId: 't1',
					question: '  which file did we change?  ',
					sideQuestion: true,
					...extra,
				});
			const argvOf = (n: number) => JSON.parse(fs.readFileSync(argvFiles[n], 'utf-8')) as string[];

			it('answers from a read-only throwaway fork of the tab, tools off, and writes nothing anywhere', async () => {
				const runtime = await start([
					seedAgent({
						// A TUI token source still answers over --print: a fork never writes what maestro-p tails.
						enableMaestroP: true,
						maestroPMode: 'interactive',
						aiTabs: [
							{
								id: 't1',
								agentSessionId: CAPTURED_CLAUDE_CODE_SESSION_ID,
								name: null,
								logs: [],
								saveToHistory: false,
							},
						],
					}),
				]);
				const turn = watch(runtime);

				const answer = value(await ask(runtime));

				expect(answer.agentName).toBe('Alpha');
				expect(answer.answer).not.toBe('');
				const argv = argvOf(0);
				const resumeAt = argv.indexOf('--resume');
				expect(argv[resumeAt + 1]).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);
				expect(argv).toEqual(
					expect.arrayContaining(['--fork-session', '--no-session-persistence'])
				);
				expect(argv[argv.indexOf('--tools') + 1]).toBe('');
				expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('plan');
				expect(argv).not.toContain('--dangerously-skip-permissions');
				expect(argv.some((arg) => arg.startsWith('--append-system-prompt'))).toBe(false);
				expect(launched[0].prompt).toBe(buildSideQuestionPrompt('which file did we change?'));
				expect(turnOptions[0].claudeTokenSource).toBeUndefined();
				// Nothing lands in the tab, its History, or its live state.
				expect(await transcript(runtime)).toEqual([]);
				const history = readHistory(runtime.paths, 'a1');
				expect(history.status === 'ok' ? history.entries : []).toEqual([]);
				expect(turn.kinds()).toEqual([]);
			});

			it("forks the agent's active tab when none is named, and saves no session for a tab with none", async () => {
				const runtime = await start();
				value(await ask(runtime, { targetTabId: undefined }));
				const argv = argvOf(0);
				expect(argv).not.toContain('--resume');
				expect(argv).not.toContain('--fork-session');
				expect(argv).toContain('--no-session-persistence');
			});

			it("refuses what the desktop refuses, in the desktop's words, and starts nothing", async () => {
				const runtime = await start([
					seedAgent(),
					seedAgent({ id: 'a2', name: 'Beta', toolType: 'opencode' }),
				]);
				expect(errorOf(await ask(runtime, { question: '   ' })).message).toBe(
					'Type a question after /btw.'
				);
				expect(errorOf(await ask(runtime, { targetTabId: 'nope' })).message).toBe(
					'No AI tab nope on Alpha'
				);
				expect(errorOf(await ask(runtime, { targetAgentId: 'a2' })).message).toBe(
					'Beta cannot answer side questions (Claude Code agents only)'
				);
				expect(errorOf(await ask(runtime, { targetAgentId: 'zzz' })).code).toBe('not-found');
				expect(argvFiles).toEqual([]);
			});
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

		it('launches no provider once another process took the data directory, and holds the message', async () => {
			const runtime = await start();
			// Another process holds the lock now; the runtime learns it at its next fence check.
			fs.writeFileSync(
				path.join(dir, RUNTIME_LOCK_FILE_NAME),
				JSON.stringify({
					pid: 200,
					mode: 'host',
					startedAt: new Date(T0).toISOString(),
					heartbeatAt: new Date(T0).toISOString(),
					bootTime: T0 - 3_600_000,
				})
			);

			const failure = errorOf(await runtime.turns.send('a1', 't1', { text: 'do the thing' }));
			expect(failure.code).toBe('failed');
			expect(failure.message).toContain('held in the queue');
			expect(launched).toEqual([]);
			expect(value(await runtime.turns.queue.list('a1'))).toEqual([
				expect.objectContaining({ tabId: 't1', text: 'do the thing', paused: true }),
			]);
		});
	});

	describe("a sender's own tab choices (turn overrides)", () => {
		const historyEntries = (runtime: MaestroRuntime) => {
			const history = readHistory(runtime.paths, 'a1');
			return history.status === 'ok' ? history.entries : [];
		};
		const chipAgent = (tab: Record<string, unknown>) =>
			seedAgent({
				aiTabs: [
					{ id: 't1', agentSessionId: null, name: null, logs: [], ...tab },
					{ id: 't2', agentSessionId: null, name: null, logs: [] },
				],
			});

		it('runs one turn under them, and leaves the host tab and the next turn as they were', async () => {
			const runtime = await start([
				chipAgent({ customModel: 'sonnet', customEffort: 'low', saveToHistory: true }),
			]);
			const turn = watch(runtime);
			value(
				await runtime.turns.send('a1', 't1', {
					text: 'mine',
					overrides: { model: 'opus', effort: 'high', readOnly: true, saveToHistory: false },
				})
			);
			await turn.outcome();

			expect(launched[0].settings).toMatchObject({ model: 'opus', effort: 'high' });
			expect(launched[0].readOnly).toBe(true);
			expect(launched[0].permissionMode).toBe('readonly');
			// The sender kept this turn out of History.
			expect(historyEntries(runtime)).toHaveLength(0);
			// Nothing of it was written onto the tab.
			const tab = await tabOf(runtime);
			expect(tab).toMatchObject({
				customModel: 'sonnet',
				customEffort: 'low',
				saveToHistory: true,
			});
			expect(tab.readOnlyMode).not.toBe(true);
			const stored = sessions().sessions[0].aiTabs[0];
			expect(stored).toMatchObject({
				customModel: 'sonnet',
				customEffort: 'low',
				saveToHistory: true,
			});

			value(await runtime.turns.send('a1', 't1', { text: 'theirs' }));
			await turn.outcome(2);
			expect(launched[1].settings).toMatchObject({ model: 'sonnet', effort: 'low' });
			expect(launched[1].readOnly).toBe(false);
			expect(await historyWritten(runtime)).toHaveLength(1);
		});

		it("lets a sender's read-only off stand in for the tab's chip, but not for read-only permissions", async () => {
			const runtime = await start([chipAgent({ readOnlyMode: true })]);
			const turn = watch(runtime);
			value(
				await runtime.turns.send('a1', 't1', { text: 'write', overrides: { readOnly: false } })
			);
			await turn.outcome();
			expect(launched[0].readOnly).toBe(false);

			value(await runtime.turns.send('a1', 't1', { text: 'plain' }));
			await turn.outcome(2);
			expect(launched[1].readOnly).toBe(true);
		});

		it("saves a turn to History on the sender's word even when the tab does not", async () => {
			const runtime = await start([chipAgent({ saveToHistory: false })]);
			const turn = watch(runtime);
			value(
				await runtime.turns.send('a1', 't1', { text: 'keep', overrides: { saveToHistory: true } })
			);
			await turn.outcome();
			expect(await historyWritten(runtime)).toHaveLength(1);
			expect((await tabOf(runtime)).saveToHistory).toBe(false);
		});

		it('keeps them with a queued message until it runs', async () => {
			hold = true;
			const runtime = await start([chipAgent({ customModel: 'sonnet' })]);
			const turn = watch(runtime);
			value(await runtime.turns.send('a1', 't1', { text: 'first' }));
			await turn.started();

			hold = false;
			expect(
				value(
					await runtime.turns.send('a1', 't1', {
						text: 'second',
						overrides: { model: 'opus', saveToHistory: false },
					})
				)
			).toMatchObject({ status: 'queued' });
			expect(value(await runtime.turns.interrupt('a1', 't1'))).toEqual({ stopped: true });
			await turn.outcome(2);

			expect(launched[0].settings.model).toBe('sonnet');
			expect(launched[1].settings.model).toBe('opus');
			// The first turn was interrupted (no entry); the queued one kept its sender's choice.
			expect(historyEntries(runtime)).toHaveLength(0);
			expect((await tabOf(runtime)).customModel).toBe('sonnet');
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
			const runtime = await start([savingAgent()]);
			const turn = watch(runtime);
			value(await runtime.turns.send('a1', 't1', { text: 'first' }));
			await turn.started();

			hold = false;
			value(await runtime.turns.send('a1', 't1', { text: 'second', originHost: 'laptop.local' }));
			expect(value(await runtime.turns.interrupt('a1', 't1'))).toEqual({ stopped: true });
			await turn.outcome(2);

			// The interrupted first turn writes no entry; the queued one is stamped with its sender.
			const [entry] = await historyWritten(runtime);
			expect(entry.hostname).toBe('laptop.local');
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

		it('names how each item leaves the queue: a start or a removal, on that change only (M14)', async () => {
			hold = true;
			const runtime = await start();
			const turn = watch(runtime);
			const changes: Array<{ items: QueuedTurn[]; exit?: QueueExit; namesExits?: true }> = [];
			runtime.events.subscribe(
				(event) => {
					if (event.type === 'queue.changed') {
						changes.push({
							items: event.items,
							...(event.exit ? { exit: event.exit } : {}),
							...(event.namesExits ? { namesExits: event.namesExits } : {}),
						});
					}
				},
				{ types: ['queue.changed'], agentId: 'a1' }
			);
			value(await runtime.turns.send('a1', 't1', { text: 'first' }));
			await turn.started();
			hold = false;
			const queued = value(await runtime.turns.send('a1', 't1', { text: 'second' }));
			if (queued.status !== 'queued') throw new Error('expected queued');
			const removed = value(await runtime.turns.send('a1', 't1', { text: 'third' }));
			if (removed.status !== 'queued') throw new Error('expected queued');
			value(await runtime.turns.queue.remove('a1', removed.itemId));

			value(await runtime.turns.interrupt('a1', 't1'));
			await turn.outcome(2);
			// Added, added (no exit), the removal of `third`, then the start of `second`.
			expect(changes.map((change) => change.exit)).toEqual([
				undefined,
				undefined,
				{ itemId: removed.itemId, exit: 'removed' },
				{ itemId: queued.itemId, exit: 'started' },
			]);
			expect(changes.every((change) => change.namesExits === true)).toBe(true);
			expect(changes[3].items).toEqual([]);
		});

		it('stamps each user entry with the queue item it ran from, so a client that queued it finds its turn by id (M23)', async () => {
			hold = true;
			const runtime = await start();
			const turn = watch(runtime);
			value(await runtime.turns.send('a1', 't1', { text: 'same text' }));
			await turn.started();
			hold = false;
			// The same text twice: only the id tells the two turns apart.
			const queued = value(await runtime.turns.send('a1', 't1', { text: 'same text' }));
			if (queued.status !== 'queued') throw new Error('expected queued');
			value(await runtime.turns.interrupt('a1', 't1'));
			await turn.outcome(2);
			const users = (await transcript(runtime)).filter((entry) => entry.source === 'user');
			expect(users).toHaveLength(2);
			expect(users[0].queuedItemId).toEqual(expect.any(String));
			expect(users[0].queuedItemId).not.toBe(queued.itemId);
			expect(users[1].queuedItemId).toBe(queued.itemId);
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

		// Parity R13: the resend of a message a lost link cut names the entry the host already
		// wrote for it, so the message is one entry in the transcript, as an SSH resend is.
		describe('the entry a message already is (entryId, R13)', () => {
			const cutTab = (logs: unknown[]) =>
				seedAgent({ aiTabs: [{ id: 't1', agentSessionId: null, name: null, logs }] });
			const QUESTION = { id: 'u1', timestamp: 1, source: 'user', text: 'Summarize the docs' };

			it('writes no second entry for the resend of a message the tab already holds', async () => {
				const runtime = await start([cutTab([QUESTION])]);
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: 'Summarize the docs', entryId: 'u1' }));
				await turn.outcome();
				const entries = await transcript(runtime);
				expect(entries.filter((entry) => entry.source === 'user')).toEqual([
					expect.objectContaining({ id: 'u1', text: 'Summarize the docs' }),
				]);
				expect(entries.some((entry) => entry.source !== 'user')).toBe(true);
				expect(turn.events.find((event) => event.kind === 'user')).toMatchObject({
					entry: { id: 'u1' },
				});
			});

			// Parity R19: the resend of a message whose turn already answered (its sender lost the
			// link or restarted while it ran) never runs again; the sender is told it already ran.
			it('answers "already ran" and starts nothing for the resend of a message the tab answered', async () => {
				const ANSWER = { id: 'a1', timestamp: 2, source: 'stdout', text: 'The docs say...' };
				const runtime = await start([cutTab([QUESTION, ANSWER])]);
				const turn = watch(runtime);
				expect(
					value(await runtime.turns.send('a1', 't1', { text: 'Summarize the docs', entryId: 'u1' }))
				).toEqual({ status: 'answered' });
				expect(argvFiles).toHaveLength(0);
				expect(turn.events).toEqual([]);
				expect((await transcript(runtime)).map((entry) => entry.id)).toEqual(['u1', 'a1']);
				// Another message that names the entry (edited while kept) runs, as its own entry.
				value(
					await runtime.turns.send('a1', 't1', {
						text: 'Summarize the docs, briefly',
						entryId: 'u1',
					})
				);
				await turn.outcome();
				expect(argvFiles).toHaveLength(1);
			});

			// Parity R31: the turn ended on the provider's own error. It ran once; the error is its end.
			it('answers "already ran" for the resend of a message whose turn ended on a provider error', async () => {
				const FAILED = { id: 'e1', timestamp: 2, source: 'error', text: 'The provider failed.' };
				const runtime = await start([cutTab([QUESTION, FAILED])]);
				expect(
					value(await runtime.turns.send('a1', 't1', { text: 'Summarize the docs', entryId: 'u1' }))
				).toEqual({ status: 'answered' });
				expect(argvFiles).toHaveLength(0);
			});

			// Parity R31: the sender lost the link while the turn ran, and the turn still runs here.
			it('answers "already ran" for the resend of the message the tab is running now', async () => {
				hold = true;
				const runtime = await start([cutTab([])]);
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: 'Summarize the docs', entryId: 'u1' }));
				await turn.started();
				expect(
					value(await runtime.turns.send('a1', 't1', { text: 'Summarize the docs', entryId: 'u1' }))
				).toEqual({ status: 'answered' });
				expect(value(await runtime.turns.queue.list('a1'))).toEqual([]);
				hold = false;
				value(await runtime.turns.interrupt('a1', 't1'));
				await turn.outcome();
				expect(argvFiles).toHaveLength(1);
			});

			// Parity R23: an answer after a LATER message is that message's. The resend of a message
			// whose own turn died runs, though the tab holds an answer further down.
			it('runs the resend of a message when only a later message of the tab was answered', async () => {
				const LATER = { id: 'u2', timestamp: 3, source: 'user', text: 'And the tests?' };
				const LATER_ANSWER = { id: 'a2', timestamp: 4, source: 'stdout', text: 'The tests...' };
				const runtime = await start([cutTab([QUESTION, LATER, LATER_ANSWER])]);
				const turn = watch(runtime);
				expect(
					value(await runtime.turns.send('a1', 't1', { text: 'Summarize the docs', entryId: 'u1' }))
				).not.toEqual({ status: 'answered' });
				await turn.outcome();
				expect(argvFiles).toHaveLength(1);
			});

			it('gives a new message the id it names', async () => {
				const runtime = await start();
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: 'hello', entryId: 'drawn-1' }));
				await turn.outcome();
				expect((await transcript(runtime))[0]).toMatchObject({
					id: 'drawn-1',
					source: 'user',
					text: 'hello',
				});
			});

			it.each([
				['another message', { id: 'u1', timestamp: 1, source: 'user', text: 'something else' }],
				['an answer', { id: 'u1', timestamp: 1, source: 'ai', text: 'The docs say' }],
			])(
				'never hides or replaces %s whose id it names: the message gets its own entry',
				async (_what, held) => {
					const runtime = await start([cutTab([held])]);
					const turn = watch(runtime);
					value(
						await runtime.turns.send('a1', 't1', { text: 'Summarize the docs', entryId: 'u1' })
					);
					await turn.outcome();
					const entries = await transcript(runtime);
					expect(entries[0]).toMatchObject(held);
					const sent = entries.filter((entry) => entry.text === 'Summarize the docs');
					expect(sent).toHaveLength(1);
					expect(sent[0].id).not.toBe('u1');
				}
			);

			it('gives a message edited while it waited its own entry, keeping the one it repeated', async () => {
				const runtime = await start([cutTab([QUESTION])]);
				const turn = watch(runtime);
				const held = value(
					await runtime.turns.send('a1', 't1', {
						text: 'Summarize the docs',
						entryId: 'u1',
						held: true,
					})
				);
				if (held.status !== 'queued') throw new Error('expected queued');
				value(
					await runtime.turns.queue.edit('a1', held.itemId, { text: 'Summarize the docs, briefly' })
				);
				value(await runtime.turns.queue.setPaused('a1', held.itemId, false));
				await turn.outcome();
				const users = (await transcript(runtime)).filter((entry) => entry.source === 'user');
				expect(users.map((entry) => entry.text)).toEqual([
					'Summarize the docs',
					'Summarize the docs, briefly',
				]);
				expect(users[1].id).not.toBe('u1');
			});

			it('writes no second entry for the resend of a command, whose entry is its expanded prompt', async () => {
				const runtime = await start([
					seedAgent({
						agentCommands: [{ command: '/review', prompt: 'Review the changes' }],
						aiTabs: [{ id: 't1', agentSessionId: null, name: null, logs: [] }],
					} as never),
				]);
				const first = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: '/review' }));
				await first.outcome();
				const [written] = (await transcript(runtime)).filter((entry) => entry.source === 'user');
				expect(written.text).not.toBe('/review');

				const again = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: '/review', entryId: written.id }));
				await again.outcome();
				const users = (await transcript(runtime)).filter((entry) => entry.source === 'user');
				expect(users.map((entry) => entry.id)).toEqual([written.id]);
			});

			it('starts the turn with a new entry when the entry its id names holds malformed images', async () => {
				const runtime = await start([cutTab([{ ...QUESTION, images: '' }])]);
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: 'Summarize the docs', entryId: 'u1' }));
				await turn.outcome();
				const users = (await transcript(runtime)).filter((entry) => entry.source === 'user');
				expect(users).toHaveLength(2);
				expect(users[1].id).not.toBe('u1');
			});

			it('ignores an id it cannot take', async () => {
				const runtime = await start();
				const turn = watch(runtime);
				value(
					await runtime.turns.send('a1', 't1', { text: 'hello', entryId: 'no spaces/allowed' })
				);
				await turn.outcome();
				expect((await transcript(runtime))[0].id).not.toBe('no spaces/allowed');
			});
		});

		// Parity M7: a hosted agent's `@mention` runs on the desktop that sent it, and the turn
		// carries the mention's agent-only text here, as a local turn carries it.
		describe('agent-only text from an @mention (M7)', () => {
			const sentPrompt = (index: number): string => {
				const argv = (JSON.parse(fs.readFileSync(argvFiles[index], 'utf-8')) as string[]).join(
					'\n'
				);
				const stdin = argvFiles[index].replace(/argv-(\d+)\.json$/, 'stdin-$1.txt');
				return fs.existsSync(stdin) ? `${argv}\n${fs.readFileSync(stdin, 'utf-8')}` : argv;
			};

			it('puts the context ahead of the message and the notes after it, and records the message alone', async () => {
				const runtime = await start();
				const turn = watch(runtime);
				value(
					await runtime.turns.send('a1', 't1', {
						text: 'hello',
						agentContext: 'REPLIES FROM BACKEND',
						agentNotes: 'BACKEND IS CONSULTING',
					})
				);
				await turn.outcome();

				const prompt = sentPrompt(0);
				expect(prompt).toContain('REPLIES FROM BACKEND\n\n---\n\nhello');
				expect(prompt).toContain('\n\n---\n\nBACKEND IS CONSULTING');
				const entries = await transcript(runtime);
				expect(entries[0]).toMatchObject({ source: 'user', text: 'hello' });
				expect(JSON.stringify(entries)).not.toContain('BACKEND IS CONSULTING');
				expect(JSON.stringify(entries)).not.toContain('REPLIES FROM BACKEND');
			});

			it('keeps it on a message that waits, until the message runs', async () => {
				const runtime = await start();
				const turn = watch(runtime);
				const held = value(
					await runtime.turns.send('a1', 't1', {
						text: 'later',
						held: true,
						agentNotes: 'BACKEND IS CONSULTING',
					})
				);
				if (held.status !== 'queued') throw new Error('expected queued');
				value(await runtime.turns.queue.setPaused('a1', held.itemId, false));
				await turn.outcome();
				expect(sentPrompt(0)).toContain('BACKEND IS CONSULTING');
			});

			it('refuses text it cannot take instead of running the turn without it', async () => {
				const runtime = await start();
				const long = 'x'.repeat(MAX_TURN_AGENT_TEXT_CHARS + 1);
				const refused = errorOf(
					await runtime.turns.send('a1', 't1', { text: 'hello', agentContext: long })
				);
				expect(refused).toMatchObject({ code: 'invalid' });
				expect(refused.message).toContain('agentContext');
				const notText = errorOf(
					await runtime.turns.send('a1', 't1', {
						text: 'hello',
						agentNotes: 42 as unknown as string,
					})
				);
				expect(notText.message).toContain('agentNotes must be text');
				expect(argvFiles).toEqual([]);
			});

			it('refuses a /skills sent with text it cannot take, and runs nothing', async () => {
				const runtime = await start();
				const before = (await transcript(runtime)).length;
				const refused = errorOf(
					await runtime.turns.send('a1', 't1', {
						text: '/skills',
						agentNotes: 17 as unknown as string,
					})
				);
				expect(refused).toMatchObject({ code: 'invalid' });
				const tooLong = errorOf(
					await runtime.turns.send('a1', 't1', {
						text: '/skills',
						agentContext: 'x'.repeat(MAX_TURN_AGENT_TEXT_CHARS + 1),
					})
				);
				expect(tooLong).toMatchObject({ code: 'invalid' });
				await new Promise((resolve) => setTimeout(resolve, 50));
				expect((await transcript(runtime)).length).toBe(before);
			});
		});

		it('queues a held message paused on an idle tab, and runs it once resumed (M3)', async () => {
			const runtime = await start();
			const turn = watch(runtime);

			const held = value(await runtime.turns.send('a1', 't1', { text: 'later', held: true }));
			expect(held).toMatchObject({ status: 'queued', position: 1, queueLength: 1 });
			if (held.status !== 'queued') throw new Error('expected queued');
			expect(value(await runtime.turns.queue.list('a1'))).toEqual([
				expect.objectContaining({ itemId: held.itemId, text: 'later', paused: true }),
			]);
			// Nothing ran: the tab is idle and the message waits for a person.
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(argvFiles).toEqual([]);
			expect(turn.events).toEqual([]);

			expect(value(await runtime.turns.queue.setPaused('a1', held.itemId, false))).toEqual({
				found: true,
				paused: false,
			});
			await turn.outcome();
			expect(turn.outcomes()).toEqual(['completed']);
			expect(value(await runtime.turns.queue.list('a1'))).toEqual([]);
			expect((await transcript(runtime))[0]).toMatchObject({ source: 'user', text: 'later' });
		});

		it('merges a waiting message into the one above it, the way the queued card does', async () => {
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
			const upper = value(await runtime.turns.send('a1', 't1', { text: 'upper\n' }));
			const lower = value(await runtime.turns.send('a1', 't1', { text: 'lower' }));
			if (upper.status !== 'queued' || lower.status !== 'queued')
				throw new Error('expected queued');

			expect(value(await runtime.turns.queue.merge('a1', lower.itemId))).toEqual({
				merged: true,
				mergedIntoId: upper.itemId,
			});
			expect(value(await runtime.turns.queue.list('a1'))).toEqual([
				expect.objectContaining({ itemId: upper.itemId, text: 'upper\n\nlower' }),
			]);
			expect(changes[changes.length - 1]).toEqual([
				expect.objectContaining({ itemId: upper.itemId, text: 'upper\n\nlower' }),
			]);
			// Nothing waits above the head.
			expect(value(await runtime.turns.queue.merge('a1', upper.itemId))).toEqual({ merged: false });
			expect(errorOf(await runtime.turns.queue.merge('nope', upper.itemId)).code).toBe('not-found');

			value(await runtime.turns.queue.remove('a1', upper.itemId));
			value(await runtime.turns.interrupt('a1', 't1'));
			await turn.outcome();
		});

		it('steers a waiting message into the TUI turn running on its tab, over its socket (M4)', async () => {
			hold = true;
			tui = true;
			const runtime = await start();
			const turn = watch(runtime);
			value(await runtime.turns.send('a1', 't1', { text: 'first' }));
			await turn.started();
			const queued = value(await runtime.turns.send('a1', 't1', { text: 'go left instead' }));
			if (queued.status !== 'queued') throw new Error('expected queued');

			// maestro-p's end of the socket: it takes the frame and answers delivered.
			const socketPath = turnOptions[0].steeringSocketPath!;
			expect(socketPath).toBeTruthy();
			const frames: Array<{ id: string; text: string }> = [];
			const server = net.createServer((socket) => {
				socket.setEncoding('utf8');
				socket.on('data', (chunk: string) => {
					const frame = JSON.parse(chunk.trim()) as { id: string; text: string };
					frames.push(frame);
					socket.write(
						`${JSON.stringify({ type: 'steering', id: frame.id, verdict: 'delivered' })}\n`
					);
				});
			});
			await new Promise<void>((resolve) => server.listen(socketPath, resolve));
			try {
				expect(value(await runtime.turns.queue.steer('a1', queued.itemId))).toEqual({
					outcome: 'delivered',
					verdict: 'delivered',
				});
				expect(frames.map((frame) => frame.text)).toEqual(['go left instead']);
				expect(value(await runtime.turns.queue.list('a1'))).toEqual([]);
				// The steered message joins the live turn and the tab's transcript, marked as a steer.
				const steeredEntry = expect.objectContaining({
					source: 'user',
					text: 'go left instead',
					steered: true,
				});
				expect(turn.events).toContainEqual(
					expect.objectContaining({ kind: 'user', entry: steeredEntry })
				);
				expect(await transcript(runtime)).toContainEqual(steeredEntry);

				// The turn says later that it never took it: back in line, live, and the tab says so.
				turnOptions[0].onSteeringVerdict!({
					type: 'steering',
					id: frames[0].id,
					verdict: 'dropped',
				});
				expect(value(await runtime.turns.queue.list('a1'))).toEqual([
					expect.objectContaining({
						itemId: queued.itemId,
						text: 'go left instead',
						paused: false,
					}),
				]);
			} finally {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
			value(await runtime.turns.interrupt('a1', 't1'));
			await turn.outcome();
			expect(errorOf(await runtime.turns.queue.steer('nope', 'q1')).code).toBe('not-found');
		});

		it('answers not-steerable for a claude --print turn, and the message waits', async () => {
			hold = true;
			const runtime = await start();
			const turn = watch(runtime);
			value(await runtime.turns.send('a1', 't1', { text: 'first' }));
			await turn.started();
			const queued = value(await runtime.turns.send('a1', 't1', { text: 'later' }));
			if (queued.status !== 'queued') throw new Error('expected queued');

			expect(value(await runtime.turns.queue.steer('a1', queued.itemId))).toMatchObject({
				outcome: 'not-steerable',
				blockedReason: 'api-token-source',
				detail: expect.stringContaining('stays queued'),
			});
			expect(value(await runtime.turns.queue.list('a1'))).toHaveLength(1);
			value(await runtime.turns.interrupt('a1', 't1'));
			await turn.outcome();
		});

		it('edits a waiting message in place, the way the queued card does', async () => {
			hold = true;
			const runtime = await start();
			const turn = watch(runtime);
			value(await runtime.turns.send('a1', 't1', { text: 'first' }));
			await turn.started();
			const queued = value(
				await runtime.turns.send('a1', 't1', { text: 'draft', overrides: { model: 'm1' } })
			);
			if (queued.status !== 'queued') throw new Error('expected queued');
			expect(value(await runtime.turns.queue.list('a1'))).toEqual([
				expect.objectContaining({ itemId: queued.itemId, turnSettings: { model: 'm1' } }),
			]);

			// Text only: the item keeps its model.
			expect(value(await runtime.turns.queue.edit('a1', queued.itemId, { text: 'final' }))).toEqual(
				{ found: true }
			);
			expect(value(await runtime.turns.queue.list('a1'))).toEqual([
				expect.objectContaining({
					itemId: queued.itemId,
					text: 'final',
					turnSettings: { model: 'm1' },
				}),
			]);
			// Settings given: assigned whole.
			value(
				await runtime.turns.queue.edit('a1', queued.itemId, {
					text: 'final',
					turnSettings: { effort: 'high' },
				})
			);
			expect(value(await runtime.turns.queue.list('a1'))).toEqual([
				expect.objectContaining({ turnSettings: { effort: 'high' } }),
			]);
			// An image the edit carries is admitted as a send's is: a store ref is refused whole.
			expect(
				errorOf(
					await runtime.turns.queue.edit('a1', queued.itemId, {
						text: 'x',
						images: ['maestro-image://sha256/abc'],
					})
				).code
			).toBe('invalid');
			expect(value(await runtime.turns.queue.edit('a1', 'gone', { text: 'x' }))).toEqual({
				found: false,
			});
			expect(
				errorOf(await runtime.turns.queue.edit('nope', queued.itemId, { text: 'x' })).code
			).toBe('not-found');

			value(await runtime.turns.queue.remove('a1', queued.itemId));
			value(await runtime.turns.interrupt('a1', 't1'));
			await turn.outcome();
		});

		describe('images on a waiting message (M2)', () => {
			const PNG = 'data:image/png;base64,iVBORw0KGgo=';
			const JPEG = 'data:image/jpeg;base64,/9j/4AAQ';

			it('queues a message with its images, lists them on the card, and runs it with them', async () => {
				hold = true;
				const runtime = await start();
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: 'first' }));
				await turn.started();
				const queued = value(
					await runtime.turns.send('a1', 't1', { text: 'look', images: [PNG, JPEG] })
				);
				if (queued.status !== 'queued') throw new Error('expected queued');
				expect(value(await runtime.turns.queue.list('a1'))).toEqual([
					expect.objectContaining({ itemId: queued.itemId, text: 'look', images: [PNG, JPEG] }),
				]);

				hold = false;
				value(await runtime.turns.interrupt('a1', 't1'));
				await turn.outcome(2);
				const entries = await transcript(runtime);
				expect(entries.filter((entry) => entry.source === 'user').at(-1)).toMatchObject({
					text: 'look',
					images: [PNG, JPEG],
				});
				const argv = JSON.parse(fs.readFileSync(argvFiles[1], 'utf-8')) as string[];
				expect(argv.slice(-2)).toEqual(['--input-format', 'stream-json']);
			});

			it('adds, replaces, keeps, and removes images on an Edit, the way the queued card does', async () => {
				hold = true;
				const runtime = await start();
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: 'first' }));
				await turn.started();
				const queued = value(await runtime.turns.send('a1', 't1', { text: 'draft' }));
				if (queued.status !== 'queued') throw new Error('expected queued');
				const card = async () => value(await runtime.turns.queue.list('a1'))[0];

				value(await runtime.turns.queue.edit('a1', queued.itemId, { text: 'two', images: [PNG] }));
				expect(await card()).toMatchObject({ text: 'two', images: [PNG] });
				// No images given: the message keeps its own.
				value(await runtime.turns.queue.edit('a1', queued.itemId, { text: 'three' }));
				expect(await card()).toMatchObject({ text: 'three', images: [PNG] });
				value(
					await runtime.turns.queue.edit('a1', queued.itemId, { text: 'four', images: [JPEG, PNG] })
				);
				expect(await card()).toMatchObject({ images: [JPEG, PNG] });
				// An empty list removes them all.
				value(await runtime.turns.queue.edit('a1', queued.itemId, { text: 'five', images: [] }));
				expect((await card()).images).toBeUndefined();

				value(await runtime.turns.queue.remove('a1', queued.itemId));
				value(await runtime.turns.interrupt('a1', 't1'));
				await turn.outcome();
			});

			it('keeps an image-only message image-only through an Edit, and refuses an edit to nothing', async () => {
				hold = true;
				const runtime = await start();
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: 'first' }));
				await turn.started();
				const queued = value(await runtime.turns.send('a1', 't1', { text: '', images: [PNG] }));
				if (queued.status !== 'queued') throw new Error('expected queued');

				value(await runtime.turns.queue.edit('a1', queued.itemId, { text: '', images: [JPEG] }));
				expect(value(await runtime.turns.queue.list('a1'))[0]).toMatchObject({
					text: '',
					images: [JPEG],
				});
				expect(
					errorOf(await runtime.turns.queue.edit('a1', queued.itemId, { text: ' ', images: [] }))
						.code
				).toBe('invalid');
				expect(value(await runtime.turns.queue.list('a1'))[0]).toMatchObject({ images: [JPEG] });

				value(await runtime.turns.queue.remove('a1', queued.itemId));
				value(await runtime.turns.interrupt('a1', 't1'));
				await turn.outcome();
			});

			it('refuses a merge whose images together pass the bounds, and changes neither message', async () => {
				hold = true;
				const runtime = await start();
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: 'first' }));
				await turn.started();
				const eleven = Array.from({ length: 11 }, () => PNG);
				const upper = value(await runtime.turns.send('a1', 't1', { text: 'up', images: eleven }));
				const lower = value(await runtime.turns.send('a1', 't1', { text: 'down', images: eleven }));
				if (upper.status !== 'queued' || lower.status !== 'queued')
					throw new Error('expected queued');

				const refused = errorOf(await runtime.turns.queue.merge('a1', lower.itemId));
				expect(refused.code).toBe('invalid');
				expect(refused.message).toContain('20 images');
				expect(value(await runtime.turns.queue.list('a1')).map((item) => item.text)).toEqual([
					'up',
					'down',
				]);

				value(await runtime.turns.queue.remove('a1', upper.itemId));
				value(await runtime.turns.queue.remove('a1', lower.itemId));
				value(await runtime.turns.interrupt('a1', 't1'));
				await turn.outcome();
			});

			it("merges the lower message's images after the upper's, as the desktop's merge does", async () => {
				hold = true;
				const runtime = await start();
				const turn = watch(runtime);
				value(await runtime.turns.send('a1', 't1', { text: 'first' }));
				await turn.started();
				const upper = value(await runtime.turns.send('a1', 't1', { text: 'up', images: [PNG] }));
				const lower = value(await runtime.turns.send('a1', 't1', { text: 'down', images: [JPEG] }));
				if (upper.status !== 'queued' || lower.status !== 'queued')
					throw new Error('expected queued');

				value(await runtime.turns.queue.merge('a1', lower.itemId));
				expect(value(await runtime.turns.queue.list('a1'))).toEqual([
					expect.objectContaining({
						itemId: upper.itemId,
						text: 'up\n\ndown',
						images: [PNG, JPEG],
					}),
				]);

				value(await runtime.turns.queue.remove('a1', upper.itemId));
				value(await runtime.turns.interrupt('a1', 't1'));
				await turn.outcome();
			});
		});

		it('moves a waiting message, the way dragging its queued card does', async () => {
			hold = true;
			const runtime = await start();
			const turn = watch(runtime);
			value(await runtime.turns.send('a1', 't1', { text: 'first' }));
			await turn.started();
			const b = value(await runtime.turns.send('a1', 't1', { text: 'b' }));
			const c = value(await runtime.turns.send('a1', 't1', { text: 'c' }));
			if (b.status !== 'queued' || c.status !== 'queued') throw new Error('expected queued');

			expect(value(await runtime.turns.queue.move('a1', c.itemId, 0, 't1'))).toEqual({
				moved: true,
			});
			expect(value(await runtime.turns.queue.list('a1')).map((item) => item.text)).toEqual([
				'c',
				'b',
			]);
			expect(value(await runtime.turns.queue.move('a1', c.itemId, 5))).toEqual({ moved: false });
			expect(value(await runtime.turns.queue.move('a1', 'gone', 0))).toEqual({ moved: false });
			expect(errorOf(await runtime.turns.queue.move('nope', c.itemId, 0)).code).toBe('not-found');

			value(await runtime.turns.queue.remove('a1', b.itemId));
			value(await runtime.turns.queue.remove('a1', c.itemId));
			value(await runtime.turns.interrupt('a1', 't1'));
			await turn.outcome();
		});

		it('sends a waiting message now beside another tab, never over its own', async () => {
			hold = true;
			const runtime = await start();
			const first = watch(runtime, 't1');
			const second = watch(runtime, 't2');
			value(await runtime.turns.send('a1', 't1', { text: 'busy' }));
			await first.started();
			const own = value(await runtime.turns.send('a1', 't1', { text: 'own tab' }));
			hold = false;
			const other = value(await runtime.turns.send('a1', 't2', { text: 'other tab' }));
			if (own.status !== 'queued' || other.status !== 'queued') throw new Error('expected queued');

			// Its own tab is mid-turn.
			expect(value(await runtime.turns.queue.sendNow('a1', own.itemId))).toEqual({ sent: false });
			// Beside t1's turn, t2's message runs now.
			expect(value(await runtime.turns.queue.sendNow('a1', other.itemId))).toEqual({ sent: true });
			await second.outcome();
			expect(second.outcomes()).toEqual(['completed']);
			expect(value(await runtime.turns.queue.sendNow('a1', 'gone'))).toEqual({ sent: false });
			expect(errorOf(await runtime.turns.queue.sendNow('nope', own.itemId)).code).toBe('not-found');

			value(await runtime.turns.queue.remove('a1', own.itemId));
			value(await runtime.turns.interrupt('a1', 't1'));
			await first.outcome();
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
					const scoped = {
						...options,
						grokLaunchScope: {
							...options.grokLaunchScope!,
							local: { ...options.grokLaunchScope!.local, installationId: () => 'recording-host' },
						},
					};
					// The synopsis turn that writes the History entry (P8) resumes the recorded session.
					if (assembled.entry.text !== 'identity recording') return fakeProvider(assembled, scoped);
					expect(assembled.resumeSessionId).toBe(resume);
					const started = await fakeProvider(assembled, scoped);
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
				// The entry comes from a synopsis turn that resumes the recorded session (P8), and keeps
				// the turn's binding. None without a session to resume (the desktop's rule), none when
				// the agent left Grok since, and none when the session's ownership is unknown: a Grok
				// resume is refused then, as a chat turn's would be.
				if (refused || cancel || missingEnd || !observed || mutate || noReceipt) {
					expect(readHistory(runtime.paths, 'a1').status).toBe('missing');
				} else {
					const [entry] = await historyWritten(runtime);
					expect(entry.projectPath).toBe(fs.realpathSync(work));
					expect(entry.agentSessionId).toBe(observed);
					expect(entry.nativeSessionBinding).toEqual(binding);
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
