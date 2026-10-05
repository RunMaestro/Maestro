/**
 * Auto Run in the runtime: launch, progress, controls, holds, and the records a run leaves, with a
 * fake provider.
 *
 * The provider is `src/__tests__/fixtures/fake-agent.mjs`, so every task is a real process on a real
 * pipe, assembled by the real `assembleAutoRunTurn`, started by the real `runAgentTurn`, and driven
 * by the real engine. Only the command is swapped: the fake agent ticks the first unchecked task of
 * the document it is told to and replays a Claude Code stream saying what a script says. The
 * runtime, its repository, its queue, its history writer, and `cli-activity.json` are real and live
 * in a temp data directory.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	CAPTURED_RECORDINGS,
	CAPTURED_CLAUDE_CODE_SESSION_ID,
} from '../../../../__tests__/main/process-manager/recordings/captured';
import {
	FAKE_AGENT_PATH,
	fakeTurnFromRecording,
	writeFakeTurn,
	type FakeTurn,
} from '../../../../__tests__/shared/maestro-lib/run/fakeAgent';
import type { HistoryEntry } from '../../../types';
import { DEFAULT_TAB_DEFAULTS } from '../../agents/rules';
import type { AutoRunRunEvent } from '../../autorun/run-tracker';
import type { ClientResult, MaestroEvent } from '../../client/types';
import { readHistory } from '../../store/read-history';
import { AUTO_RUN_SESSION_COLUMNS, AUTO_RUN_TASK_COLUMNS } from '../../stats/auto-run-insert';
import { QUERY_EVENT_COLUMNS } from '../../stats/query-event-insert';
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

/** The line Claude Code ends a turn on when the API refused it: an expired key, classified `auth_expired`. */
const AUTH_FAILURE =
	'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';

/**
 * One Claude Code turn that says `text`: what the fake agent replays for a task or an iteration.
 * With `failure`, the turn ends on that error and exits 1.
 */
function claudeTurn(text: string, sessionId: string, failure?: string): FakeTurn {
	const usage = {
		input_tokens: 10,
		output_tokens: 5,
		cache_read_input_tokens: 0,
		cache_creation_input_tokens: 0,
	};
	const line = (object: unknown) => `${JSON.stringify(object)}\n`;
	return {
		chunks: [
			line({ type: 'system', subtype: 'init', session_id: sessionId }),
			line({
				type: 'assistant',
				message: { role: 'assistant', content: [{ type: 'text', text }], usage },
				session_id: sessionId,
			}),
			line({
				type: 'result',
				subtype: failure ? 'error_during_execution' : 'success',
				is_error: failure !== undefined,
				result: failure ?? text,
				session_id: sessionId,
				total_cost_usd: 0.01,
				usage,
			}),
		],
		close: { code: failure ? 1 : 0, signal: null },
	};
}

/** What the fake agent does for one Auto Run turn, in the order the run starts them. */
interface Step {
	text: string;
	/** The document the agent ticks a task in. Absent: it changes no file (a synopsis, a handoff). */
	tick?: string;
	/** The turn ends on this API error instead of an answer. */
	failure?: string;
	/** The agent says nothing more and stays running, as a hung agent does. */
	hang?: boolean;
}

describe('runtime Auto Run', () => {
	let dir: string;
	let work: string;
	let docs: string;
	let open: MaestroRuntime[];
	let script: Step[];
	let chatRecording: string;
	let envFiles: string[];
	/** The SQL the fake stats connection was asked to run, with its bind values. */
	let statsWrites: Array<{ sql: string; params: unknown[] }>;

	const watchDirectory: WatchDirectory = () => ({ close: () => undefined });

	const fakeProvider: RuntimeDeps['turns']['runAgentTurn'] = (turn, options) => {
		const isRun = turn.launch.querySource === 'auto';
		const step = isRun ? script.shift() : undefined;
		if (isRun && !step) throw new Error('The script has no step left for this Auto Run turn.');
		const recording = step
			? writeFakeTurn(work, claudeTurn(step.text, `provider-${envFiles.length + 1}`, step.failure))
			: chatRecording;
		const envOut = path.join(work, `env-${envFiles.length + 1}.json`);
		envFiles.push(envOut);
		return runAgentTurn(
			{
				...turn,
				launch: {
					...turn.launch,
					command: process.execPath,
					args: [FAKE_AGENT_PATH, ...turn.launch.args],
					sessionCustomEnvVars: {
						...turn.launch.sessionCustomEnvVars,
						FAKE_AGENT_RECORDING: recording,
						FAKE_AGENT_ENV_OUT: envOut,
						...(step?.tick ? { FAKE_AGENT_TICK_FILE: step.tick } : {}),
						...(step?.hang ? { FAKE_AGENT_HOLD: '1' } : {}),
					},
				},
			},
			{ ...options, stopGraceMs: 200 }
		);
	};

	/** A stats.db stand-in: it has every column the recorder checks for, and records what it is asked to run. */
	class FakeDatabase {
		pragma(source: string): unknown {
			const table = /^table_info\((\w+)\)$/.exec(source)?.[1];
			const columns: Record<string, readonly string[]> = {
				query_events: QUERY_EVENT_COLUMNS,
				auto_run_sessions: AUTO_RUN_SESSION_COLUMNS,
				auto_run_tasks: AUTO_RUN_TASK_COLUMNS,
			};
			return table ? (columns[table] ?? []).map((name) => ({ name })) : undefined;
		}
		prepare(sql: string) {
			return { run: (...params: unknown[]) => void statsWrites.push({ sql, params }) };
		}
		close() {}
	}

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
			probeBinary: async (binaryName) => ({ exists: true, path: `/fake/bin/${binaryName}` }),
			turns: { runAgentTurn: fakeProvider },
		};
	}

	const seedAgent = (extra: Record<string, unknown> = {}) => ({
		id: 'a1',
		name: 'Alpha',
		toolType: 'claude-code',
		cwd: work,
		projectRoot: work,
		autoRunFolderPath: docs,
		aiTabs: [{ id: 't1', agentSessionId: null, name: null, logs: [] }],
		activeTabId: 't1',
		unifiedTabOrder: [{ type: 'ai', id: 't1' }],
		...extra,
	});

	async function start(agent: Record<string, unknown> = seedAgent()): Promise<MaestroRuntime> {
		fs.writeFileSync(
			path.join(dir, 'maestro-sessions.json'),
			JSON.stringify({ sessions: [agent], activeSessionId: 'a1' }, null, '\t')
		);
		const started = await createMaestroRuntime({
			dataDir: dir,
			mode: 'tui',
			deps: deps(),
			turns: {
				bundledPromptsDir: BUNDLED_PROMPTS,
				loadSqlite: () => FakeDatabase as never,
			},
		});
		if (!started.ok) throw new Error(`refused: ${started.refusal.message}`);
		open.push(started.runtime);
		return started.runtime;
	}

	const doc = (name: string, text: string): string => {
		const file = path.join(docs, `${name}.md`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text);
		return file;
	};
	const tasks = (count: number, checked = 0): string =>
		Array.from({ length: count }, (_, i) => `- [${i < checked ? 'x' : ' '}] task ${i + 1}`).join(
			'\n'
		);
	const read = (file: string): string => fs.readFileSync(file, 'utf-8');

	/** Watch a run: every `autorun` event, and a way to wait for a frame or for the end. */
	function watchRun(runtime: MaestroRuntime, agentId = 'a1') {
		const events: AutoRunRunEvent[] = [];
		const waiting: Array<{ test: (events: AutoRunRunEvent[]) => boolean; resolve: () => void }> =
			[];
		runtime.events.subscribe(
			(event: MaestroEvent) => {
				if (event.type !== 'autorun') return;
				events.push(event.event);
				for (const waiter of waiting.filter((w) => w.test(events))) waiter.resolve();
			},
			{ types: ['autorun'], agentId }
		);
		const until = (test: (events: AutoRunRunEvent[]) => boolean, label: string) =>
			new Promise<void>((resolve, reject) => {
				if (test(events)) return resolve();
				const timer = setTimeout(
					() => reject(new Error(`${label}; saw ${events.map((e) => e.kind).join(',')}`)),
					15_000
				);
				waiting.push({
					test,
					resolve: () => {
						clearTimeout(timer);
						resolve();
					},
				});
			});
		return {
			events,
			frames: () =>
				events.flatMap((event) => (event.kind === 'state' && event.state ? [event.state] : [])),
			ended: () =>
				until(
					(all) => all.some((e) => e.kind === 'state' && e.state === null),
					'the run did not end'
				),
			paused: () =>
				until(
					(all) => all.some((e) => e.kind === 'state' && e.state?.pause !== undefined),
					'the run did not pause'
				),
		};
	}

	const auto = (runtime: MaestroRuntime): HistoryEntry[] => {
		const history = readHistory(runtime.paths, 'a1', { limit: 1000 });
		if (history.status !== 'ok') throw new Error(`history ${history.status}`);
		return history.entries.filter((entry) => entry.type === 'AUTO').reverse();
	};
	const activityFile = () => path.join(dir, 'cli-activity.json');

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-runtime-autorun-'));
		work = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-runtime-autorun-work-'));
		docs = path.join(work, 'docs');
		fs.mkdirSync(docs);
		open = [];
		script = [];
		envFiles = [];
		statsWrites = [];
		chatRecording = writeFakeTurn(
			work,
			fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-claude-code-normal'])
		);
		// `stats.db` exists, so the recorder tries to write; the connection behind it is the fake.
		fs.writeFileSync(path.join(dir, 'stats.db'), '');
	});
	afterEach(async () => {
		for (const runtime of open) await runtime.connection.close();
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(work, { recursive: true, force: true });
	});

	describe('a spec-driven run', () => {
		it('works through every task, reports its progress, and leaves the rows the desktop counts', async () => {
			const file = doc('tasks', tasks(3));
			script = [1, 2, 3].map((n) => ({
				text: `Finished task number ${n} of the list. More detail follows.`,
				tick: file,
			}));
			const runtime = await start();
			const run = watchRun(runtime);

			expect(value(await runtime.autoRun.launch('a1', { documents: [{ file }] }))).toBeUndefined();
			await run.ended();

			// Every box is ticked and the run is no longer registered as working.
			expect(read(file)).toBe(tasks(3, 3));
			expect(runtime.runs.activeRuns()).toEqual([]);
			expect(runtime.runs.latestState('a1')).toBeUndefined();
			expect(JSON.parse(read(activityFile())).activities).toEqual([]);

			// Progress: the bars moved with the files, and the last frame is `null`.
			const frames = run.frames();
			expect(frames[0]).toMatchObject({ isRunning: true, tasksTotal: 3, tasksDone: 0 });
			expect(frames[frames.length - 1]).toMatchObject({ tasksTotal: 3, tasksDone: 3 });
			expect(run.events[run.events.length - 1]).toMatchObject({ kind: 'state', state: null });
			// The agent's words and usage reach the output stream.
			expect(run.events.some((e) => e.kind === 'output' && e.text.includes('Finished task'))).toBe(
				true
			);
			expect(run.events.some((e) => e.kind === 'usage')).toBe(true);

			// History: three per-task rows with their synopsis from the answer (no extra turn per
			// task), and one final row that is the run boundary.
			const rows = auto(runtime);
			expect(rows).toHaveLength(4);
			const taskRows = rows.filter((row) => row.completedTaskCount !== undefined);
			expect(taskRows).toHaveLength(3);
			expect(taskRows.map((row) => row.completedTaskCount)).toEqual([1, 1, 1]);
			expect(taskRows[0].summary).toBe('Finished task number 1 of the list.');
			expect(taskRows.every((row) => row.projectPath === work && row.sessionId === 'a1')).toBe(
				true
			);
			expect(rows[3].summary).toBe('Auto Run completed: 3 tasks in 1 loop');
			expect(envFiles).toHaveLength(3);

			// Each turn is automation, not someone typing.
			const env = JSON.parse(read(envFiles[0]));
			expect(env.MAESTRO_QUERY_SOURCE).toBe('auto');
		});

		it('writes the usage rows the Usage Dashboard counts', async () => {
			const file = doc('tasks', tasks(3));
			script = [1, 2, 3].map(() => ({ text: 'Done with this task. Details.', tick: file }));
			const runtime = await start();
			const run = watchRun(runtime);

			value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
			await run.ended();

			const into = (table: string) =>
				statsWrites.filter((write) => write.sql.includes(`INSERT INTO ${table}`));
			// One run, three tasks, and one `query_events` row per turn marked as automation.
			expect(into('auto_run_sessions')).toHaveLength(1);
			expect(into('auto_run_sessions')[0].params).toContain('tasks');
			expect(into('auto_run_tasks')).toHaveLength(3);
			const queries = into('query_events');
			expect(queries).toHaveLength(3);
			expect(queries.every((write) => write.params[1] === 'a1' && write.params[3] === 'auto')).toBe(
				true
			);
			// The run is closed with its duration and the tasks it finished.
			const closing = statsWrites.filter((write) =>
				write.sql.startsWith('UPDATE auto_run_sessions')
			);
			expect(closing).toHaveLength(1);
			expect(closing[0].params[1]).toBe(3);
		});

		it('refuses before anything starts, with the reason', async () => {
			const open1 = doc('open', tasks(2));
			const done = doc('done', tasks(2, 2));
			const halted = doc('halted', `${tasks(1)}\n<!-- maestro:halt: a person must look -->\n`);
			const outside = path.join(work, 'elsewhere.md');
			fs.writeFileSync(outside, tasks(1));
			const runtime = await start();

			expect(errorOf(await runtime.autoRun.launch('a1', { documents: [] })).code).toBe('invalid');
			expect(
				errorOf(await runtime.autoRun.launch('ghost', { documents: [{ file: open1 }] })).code
			).toBe('not-found');
			expect(
				errorOf(await runtime.autoRun.launch('a1', { documents: [{ file: outside }] }))
			).toMatchObject({
				code: 'invalid',
			});
			expect(
				errorOf(await runtime.autoRun.launch('a1', { documents: [{ file: done }] }))
			).toMatchObject({
				code: 'rejected',
				message: expect.stringContaining('no unchecked tasks'),
			});
			expect(
				errorOf(await runtime.autoRun.launch('a1', { documents: [{ file: halted }] }))
			).toMatchObject({
				code: 'rejected',
			});
			// Nothing started: no process, no History, no activity entry.
			expect(envFiles).toHaveLength(0);
			expect(runtime.runs.activeRuns()).toEqual([]);
			expect(fs.existsSync(activityFile())).toBe(false);
		});

		it('refuses when Auto Run is turned off, or the agent works on an SSH remote', async () => {
			const file = doc('tasks', tasks(1));
			fs.writeFileSync(
				path.join(dir, 'maestro-settings.json'),
				JSON.stringify({ autoRunDisabled: true })
			);
			const runtime = await start();
			expect(errorOf(await runtime.autoRun.launch('a1', { documents: [{ file }] }))).toMatchObject({
				code: 'rejected',
				message: expect.stringContaining('turned off'),
			});

			fs.writeFileSync(path.join(dir, 'maestro-settings.json'), JSON.stringify({}));
			const remote = await start(
				seedAgent({ sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } })
			);
			expect(errorOf(await remote.autoRun.launch('a1', { documents: [{ file }] }))).toMatchObject({
				code: 'rejected',
				message: expect.stringContaining('SSH'),
			});
		});
	});

	describe('a run that waits on a person', () => {
		const gated = () =>
			`- [ ] before the gate\n<!-- MAESTRO:HITL reason="Approve the migration" -->\n- [ ] after the gate\n`;

		it('parks at a gate, holds the agent, and goes on when resumed', async () => {
			const file = doc('gated', gated());
			script = [
				{ text: 'Did the first task. Done.', tick: file },
				{ text: 'Did the second task. Done.', tick: file },
			];
			const runtime = await start();
			const run = watchRun(runtime);

			value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
			await run.paused();

			// Parked: the frame says why, the run is listed as paused, and the agent is held.
			const parked = run
				.frames()
				.filter((frame) => frame.pause)
				.pop();
			expect(parked?.pause).toMatchObject({ type: 'hitl_gate', message: 'Approve the migration' });
			expect(runtime.runs.activeRuns()).toMatchObject([
				{ agentId: 'a1', kind: 'playbook', paused: true },
			]);
			expect(runtime.runs.latestState('a1')).toMatchObject({ isRunning: true, errorPaused: true });
			expect(errorOf(await runtime.autoRun.launch('a1', { documents: [{ file }] }))).toMatchObject({
				code: 'rejected',
				message: expect.stringContaining('busy'),
			});

			// A chat message that would write waits behind the run (AE17).
			const chatEnded = new Promise<void>((resolve) => {
				runtime.turns.subscribe('a1', 't1', (event) => {
					if (event.kind === 'outcome') resolve();
				});
			});
			const chat = value(await runtime.turns.send('a1', 't1', { text: 'hello there' }));
			expect(chat).toMatchObject({ status: 'queued', position: 1 });
			expect(envFiles).toHaveLength(1);

			// A second answer is refused: nothing is pending any more once resumed, and `skip` of a
			// run that is not paused is a stale click.
			value(await runtime.autoRun.resume('a1'));
			await run.ended();
			expect(read(file)).toContain('- [x] before the gate');
			expect(read(file)).toContain('- [x] after the gate');
			expect(errorOf(await runtime.autoRun.skip('a1')).code).toBe('not-found');

			// The run ended, so the held message starts and finishes.
			await chatEnded;
			expect(value(await runtime.turns.queue.list('a1'))).toEqual([]);
			const tab = value(await runtime.tabs.list('a1'))[0];
			expect(tab.agentSessionId).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);
		});

		it('lets one of two launches that race start, and refuses the other as busy', async () => {
			const file = doc('gated', gated());
			script = [{ text: 'Did the first task. Done.', tick: file }];
			const runtime = await start();
			const run = watchRun(runtime);

			const [first, second] = await Promise.all([
				runtime.autoRun.launch('a1', { documents: [{ file }] }),
				runtime.autoRun.launch('a1', { documents: [{ file }] }),
			]);

			expect([first.ok, second.ok].sort()).toEqual([false, true]);
			expect(errorOf(first.ok ? second : first)).toMatchObject({
				code: 'rejected',
				message: expect.stringContaining('busy'),
			});
			await run.paused();
			expect(runtime.runs.activeRuns()).toHaveLength(1);
		});

		it('ends a parked run, and records it, when the runtime is closed', async () => {
			const file = doc('gated', gated());
			script = [{ text: 'Did the first task. Done.', tick: file }];
			const runtime = await start();
			const run = watchRun(runtime);

			value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
			await run.paused();
			await runtime.connection.close();

			// Nothing is left running, and History says how the run ended.
			expect(runtime.runs.activeRuns()).toEqual([]);
			const rows = auto(runtime);
			expect(rows[rows.length - 1].summary).toMatch(/^Auto Run stopped:/);
			expect(JSON.parse(read(activityFile())).activities).toEqual([]);
		});

		it('ends the run when a person aborts it, and records that', async () => {
			const file = doc('gated', gated());
			script = [{ text: 'Did the first task. Done.', tick: file }];
			const runtime = await start();
			const run = watchRun(runtime);

			value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
			await run.paused();
			value(await runtime.autoRun.abort('a1'));
			await run.ended();

			expect(read(file)).toContain('- [x] before the gate');
			expect(read(file)).toContain('- [ ] after the gate');
			const rows = auto(runtime);
			expect(rows[rows.length - 1].summary).toBe('Auto Run stopped: aborted by operator');
		});

		it('answers a stop with an abort while parked, and refuses a control when no run exists', async () => {
			const file = doc('gated', gated());
			script = [{ text: 'Did the first task. Done.', tick: file }];
			const runtime = await start();
			const run = watchRun(runtime);

			expect(errorOf(await runtime.autoRun.stop('a1')).code).toBe('not-found');
			expect(errorOf(await runtime.autoRun.resume('a1')).code).toBe('not-found');

			value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
			await run.paused();
			value(await runtime.autoRun.stop('a1'));
			await run.ended();

			const rows = auto(runtime);
			expect(rows[rows.length - 1].summary).toMatch(/^Auto Run stopped:/);
		});
	});

	describe('when the agent fails', () => {
		it('parks on a classified error, and retries the same task when resumed', async () => {
			const file = doc('tasks', tasks(1));
			script = [
				{ text: 'The key was refused.', failure: AUTH_FAILURE },
				{ text: 'Did the task this time. Done.', tick: file },
			];
			const runtime = await start();
			const run = watchRun(runtime);

			value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
			await run.paused();
			expect(
				run
					.frames()
					.filter((frame) => frame.pause)
					.pop()?.pause
			).toMatchObject({
				type: 'auth_expired',
			});
			// The pause explains itself in History, and the document is untouched.
			expect(auto(runtime).map((row) => row.summary)).toContain(
				'Auto Run error: Authentication Required (tasks)'
			);
			expect(read(file)).toBe(tasks(1));

			value(await runtime.autoRun.resume('a1'));
			await run.ended();
			expect(read(file)).toBe(tasks(1, 1));
		});

		it('leaves the document, not the run, when a person skips the failing document', async () => {
			const first = doc('first', tasks(1));
			const second = doc('second', tasks(1));
			script = [
				{ text: 'Refused.', failure: AUTH_FAILURE },
				{ text: 'Did the second document. Done.', tick: second },
			];
			const runtime = await start();
			const run = watchRun(runtime);

			value(await runtime.autoRun.launch('a1', { documents: [{ file: first }, { file: second }] }));
			await run.paused();
			value(await runtime.autoRun.skip('a1'));
			await run.ended();

			expect(read(first)).toBe(tasks(1));
			expect(read(second)).toBe(tasks(1, 1));
		});

		it('kills a hung agent, trips the stall guard at once, and says so in History', async () => {
			const file = doc('tasks', tasks(2));
			// 0.01 minutes of silence is 600 ms: long enough for the agent to start, short for a test.
			fs.writeFileSync(
				path.join(dir, 'maestro-settings.json'),
				JSON.stringify({ autoRunInactivityTimeoutMin: 0.01 })
			);
			script = [{ text: 'Working on it.', hang: true }];
			const runtime = await start();
			const run = watchRun(runtime);

			value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
			await run.ended();

			// One dispatch only: a watchdog failure is a dead run, not a slow one.
			expect(envFiles).toHaveLength(1);
			expect(read(file)).toBe(tasks(2));
			const summaries = auto(runtime).map((row) => row.summary);
			expect(summaries).toContain('[tasks] Task failed');
			expect(summaries).toContain('Document stalled: tasks (2 tasks remaining)');
		});
	});

	describe('a goal-driven run', () => {
		it('iterates until the agent reports the goal met, and writes the rows the desktop does', async () => {
			script = [
				{ text: 'Made a start on it.\n<!-- maestro:progress 40 | halfway there -->' },
				// The handoff note the engine asks the first iteration for before the next one starts.
				{ text: 'Left the parser half done.' },
				{
					text: 'All finished.\n<!-- maestro:progress 100 | done -->\n<!-- maestro:goal-complete -->',
				},
			];
			const runtime = await start();
			const run = watchRun(runtime);

			expect(
				value(await runtime.autoRun.launchGoal('a1', { goal: 'Ship the parser', maxIterations: 5 }))
			).toEqual({});
			await run.ended();

			const frames = run.frames();
			expect(frames[0]).toMatchObject({ goal: { iteration: 0 }, tasksTotal: 100 });
			expect(frames.some((frame) => frame.goal?.percent === 40)).toBe(true);
			expect(frames.some((frame) => frame.goal?.percent === 100)).toBe(true);

			const rows = auto(runtime);
			expect(rows.map((row) => row.summary)).toEqual([
				'Goal-Driven Auto Run started',
				'Goal progress: 40% - halfway there',
				'Goal progress: 100% - done',
				'Goal completed (100%)',
			]);
			expect(rows[3].success).toBe(true);
			expect(envFiles).toHaveLength(3);
			expect(JSON.parse(read(activityFile())).activities).toEqual([]);
			// The run shows in the Usage Dashboard as a goal run on the 0 to 100 scale.
			const sessions = statsWrites.filter((write) =>
				write.sql.includes('INSERT INTO auto_run_sessions')
			);
			expect(sessions[0].params).toContain('Goal: Ship the parser');
		});

		it('refuses an empty goal', async () => {
			const runtime = await start();
			expect(errorOf(await runtime.autoRun.launchGoal('a1', { goal: '   ' })).code).toBe('invalid');
		});
	});
});
