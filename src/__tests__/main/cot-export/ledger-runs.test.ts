/**
 * Tests for main/cot-export/ledger-runs.ts.
 *
 * WHAT THEY PIN
 * - A run the command line reports becomes one turn of the agent's log, with
 *   `origin: 'cli'`: its start, a gap that says the output was never captured,
 *   and its end.
 * - Which runs are taken: reported by the command line, finished, for an
 *   agent that is recorded, started after export was turned on, and not
 *   taken before. Everything else is left alone.
 * - A run is taken once, however often the ledger changes, through a restart
 *   and through a crash right after the write, because a run always lands in
 *   the same file. A run that reaches the ledger late is not lost behind one
 *   that reached it early.
 * - With export off for everyone the ledger is not even read.
 *
 * The writer is the real one, over a fresh folder in the OS temp dir, and the
 * chain it leaves is checked with the real verifier.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listTurnFiles, turnFilePath } from '../../../main/cot-export/layout';
import { cliTurnId, createCotLedgerRecorder } from '../../../main/cot-export/ledger-runs';
import type {
	CotLedgerRecorder,
	CotLedgerRecorderDeps,
} from '../../../main/cot-export/ledger-runs';
import { verifyAgentChain } from '../../../main/cot-export/verify';
import { createCotWriter } from '../../../main/cot-export/writer';
import type { AgentRun } from '../../../shared/agent-run';
import { COT_GENESIS_CHAIN_SEQ, COT_GENESIS_HASH } from '../../../shared/cotExport/types';
import type { CotChainState, CotRecord } from '../../../shared/cotExport/types';
import { readTurnFiles } from './helpers';

const AGENT = '11111111-2222-4333-8444-555555555555';
const OTHER_AGENT = '99999999-2222-4333-8444-555555555555';

/** 09:30:00 on 10 October 2026, on the local clock: when export was turned on. */
const SINCE = new Date(2026, 9, 10, 9, 30, 0).getTime();
const MINUTE = 60_000;

/** A finished run of the command line, as `captureCliRun` leaves it in the ledger. */
function run(overrides: Partial<AgentRun> & { endedAfterMs?: number } = {}): AgentRun {
	const { endedAfterMs = 4000, ...rest } = overrides;
	const createdAt = rest.createdAt ?? SINCE + MINUTE;
	return {
		id: 'run_cli-send_1',
		createdAt,
		updatedAt: createdAt + endedAfterMs,
		provider: 'claude-code',
		status: 'completed',
		artifacts: [],
		touchedFiles: [],
		checks: [],
		reviews: [],
		cwd: '/work/project',
		source: 'cli:send',
		agentId: AGENT,
		sessionId: AGENT,
		prompt: 'List the files.',
		metadata: { durationMs: endedAfterMs, exitCode: 0 },
		...rest,
	};
}

describe('cot-export ledger runs', () => {
	let root: string;
	let folder: string;
	/** Agents with export on, and the folders of each: the current one first. */
	let enabled: Map<string, string[]>;
	/** When export was turned on for each agent. */
	let since: Map<string, number>;
	let chains: Map<string, CotChainState>;
	let errors: Array<{ agentId: string | null; message: string }>;
	let toolTypes: Map<string, string>;

	const chainIn = (dir: string): CotChainState => {
		let chain = chains.get(dir);
		if (!chain) {
			chain = { folder: dir, head: COT_GENESIS_HASH, chainSeq: COT_GENESIS_CHAIN_SEQ };
			chains.set(dir, chain);
		}
		return chain;
	};

	const makeRecorder = (overrides: Partial<CotLedgerRecorderDeps> = {}): CotLedgerRecorder =>
		createCotLedgerRecorder({
			listEnabledAgents: () => [...enabled.keys()],
			getFolders: (agentId) => enabled.get(agentId) ?? [],
			getToolType: (agentId) => toolTypes.get(agentId) ?? null,
			getSince: (agentId) => since.get(agentId) ?? null,
			writer: createCotWriter({
				getChainState: (_agentId, dir) => chainIn(dir),
				onHeadAdvanced: (_agentId, state) => {
					chains.set(state.folder, state);
				},
				onError: (agentId, error) => errors.push({ agentId, message: error.message }),
				now: () => SINCE,
			}),
			onError: (agentId, error) => errors.push({ agentId, message: error.message }),
			...overrides,
		});

	const readTurns = (dir: string = folder): Promise<CotRecord[][]> => readTurnFiles(dir);
	const kindsOf = (records: CotRecord[]): string[] => records.map((record) => record.kind);
	/** The prompts of the turns in the folder, oldest file first. */
	const promptsIn = async (dir: string = folder): Promise<string[]> =>
		(await readTurns(dir)).map((records) =>
			records[0].kind === 'turn-start' ? records[0].prompt : ''
		);

	beforeEach(() => {
		root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cot-ledger-')));
		folder = path.join(root, 'logs');
		enabled = new Map([[AGENT, [folder]]]);
		since = new Map([[AGENT, SINCE]]);
		chains = new Map();
		errors = [];
		toolTypes = new Map([
			[AGENT, 'claude-code'],
			[OTHER_AGENT, 'codex'],
		]);
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	// ========================================================================
	// What a run becomes
	// ========================================================================

	describe('what a run becomes', () => {
		it('writes its start, a gap for the output nobody captured, and its end', async () => {
			const reported = run();
			await makeRecorder().recordPending(() => [reported]);

			const [records] = await readTurns();
			expect(kindsOf(records)).toEqual(['turn-start', 'capture-gap', 'turn-end']);
			expect(records[0]).toMatchObject({
				agentId: AGENT,
				origin: 'cli',
				cliRunId: 'run_cli-send_1',
				turnId: cliTurnId('run_cli-send_1'),
				toolType: 'claude-code',
				cwd: '/work/project',
				prompt: 'List the files.',
				imageCount: 0,
			});
			expect(records[0]).not.toHaveProperty('querySource');
			expect(records[1]).toMatchObject({ reason: 'output-not-captured:outside-app' });
			expect(records[2]).toMatchObject({
				exitCode: 0,
				durationMs: 4000,
				outcome: 'completed',
				// The gap is Maestro's note about the log, not a record of the turn.
				recordCount: 2,
			});
			expect(errors).toEqual([]);
		});

		it('files the turn under the hour the run started, and leaves a chain that verifies', async () => {
			await makeRecorder().recordPending(() => [run()]);

			const started = new Date(SINCE + MINUTE);
			const hourDir = path.join(
				folder,
				String(started.getFullYear()),
				String(started.getMonth() + 1).padStart(2, '0'),
				String(started.getDate()).padStart(2, '0'),
				String(started.getHours()).padStart(2, '0')
			);
			expect(fs.readdirSync(hourDir)).toHaveLength(1);
			await expect(verifyAgentChain(folder, chainIn(folder).head)).resolves.toMatchObject({
				ok: true,
				recordsChecked: 3,
			});
		});

		it("takes the provider from Maestro's own agent list, not from the ledger", async () => {
			toolTypes.set(AGENT, 'qwen3-coder');
			await makeRecorder().recordPending(() => [run({ provider: 'qwen-coder' })]);

			const [records] = await readTurns();
			expect(records[0]).toMatchObject({ toolType: 'qwen3-coder' });
		});

		it.each([
			['cancelled', 130, 'interrupted'],
			['failed', 1, 'crashed'],
		] as const)('says how a %s run ended', async (status, exitCode, outcome) => {
			await makeRecorder().recordPending(() => [
				run({ status, metadata: { durationMs: 900, exitCode } }),
			]);

			const [records] = await readTurns();
			expect(records[2]).toMatchObject({ exitCode, outcome, durationMs: 900 });
		});

		it('keeps the prompt as it was given, marker and all', async () => {
			// The command line reports the prompt from before any system prompt
			// is put in front of it, so a marker in it is the writer's own text.
			const prompt = 'Context\n\n---\n\n# User Request\n\nWhat does this heading mean?';
			toolTypes.set(AGENT, 'codex');
			await makeRecorder().recordPending(() => [run({ prompt })]);

			const [records] = await readTurns();
			expect(records[0]).toMatchObject({ prompt });
			expect(records[0]).not.toHaveProperty('systemPromptSha256');
		});

		it('says so when the ledger holds no prompt, and makes do with a ledger that was written by hand', async () => {
			const bare = run({ metadata: { durationMs: 'soon', exitCode: '0' } });
			delete bare.prompt;
			delete bare.cwd;
			await makeRecorder().recordPending(() => [bare]);

			const [records] = await readTurns();
			expect(kindsOf(records)).toEqual(['turn-start', 'capture-gap', 'capture-gap', 'turn-end']);
			expect(records[0]).toMatchObject({ prompt: '', cwd: '' });
			expect(records[1]).toMatchObject({ reason: 'prompt-not-captured' });
			expect(records[2]).toMatchObject({ reason: 'output-not-captured:outside-app' });
			// A duration and an exit code that are not numbers are not believed.
			expect(records[3]).toMatchObject({ exitCode: null, durationMs: 4000 });
		});
	});

	// ========================================================================
	// Which runs are taken
	// ========================================================================

	describe('which runs are taken', () => {
		it.each([
			['a run the app started itself', { source: 'desktop' }],
			['a run with no source', { source: undefined }],
			['a synopsis of a playbook run', { source: 'cli:autorun-synopsis' }],
			['a synopsis of a goal run', { source: 'cli:goal-synopsis' }],
			['a run that is still going', { status: 'running' as const }],
			['a run that names no agent', { agentId: undefined }],
			['a run of an agent that is not recorded', { agentId: OTHER_AGENT }],
			['a run that started before export was turned on', { createdAt: SINCE - 1 }],
		])('leaves %s alone', async (_name, overrides) => {
			await makeRecorder().recordPending(() => [run(overrides)]);

			expect(await readTurns()).toEqual([]);
			expect(errors).toEqual([]);
		});

		it.each(['cli:send', 'cli:autorun', 'cli:goal'])('takes a %s run', async (source) => {
			await makeRecorder().recordPending(() => [run({ source })]);
			expect(await promptsIn()).toEqual(['List the files.']);
		});

		it('takes a run that started at the very moment export was turned on', async () => {
			await makeRecorder().recordPending(() => [run({ createdAt: SINCE })]);
			expect(await readTurns()).toHaveLength(1);
		});

		it('leaves the runs of an agent Maestro no longer has', async () => {
			toolTypes.delete(AGENT);
			await makeRecorder().recordPending(() => [run()]);
			expect(await readTurns()).toEqual([]);
		});

		it('writes each agent into its own folder', async () => {
			const otherFolder = path.join(root, 'other-logs');
			enabled.set(OTHER_AGENT, [otherFolder]);
			since.set(OTHER_AGENT, SINCE);

			await makeRecorder().recordPending(() => [
				run({ id: 'a', prompt: 'For the first agent.' }),
				run({ id: 'b', agentId: OTHER_AGENT, prompt: 'For the second agent.' }),
			]);

			expect(await promptsIn(folder)).toEqual(['For the first agent.']);
			expect(await promptsIn(otherFolder)).toEqual(['For the second agent.']);
			expect((await readTurns(otherFolder))[0][0]).toMatchObject({ toolType: 'codex' });
		});
	});

	// ========================================================================
	// Once, and in order
	// ========================================================================

	describe('once, and in order', () => {
		it('takes a run once, however often the ledger changes', async () => {
			const recorder = makeRecorder();
			const ledger = [run()];

			await recorder.recordPending(() => ledger);
			await recorder.recordPending(() => ledger);
			// A later write to the ledger moves `updatedAt` and nothing else.
			await recorder.recordPending(() => [{ ...ledger[0], updatedAt: SINCE + 10 * MINUTE }]);

			expect(await readTurns()).toHaveLength(1);
		});

		it('looks at the disk once for a run, not at every change of the ledger', async () => {
			const recorder = makeRecorder();
			const ledger = [run()];
			await recorder.recordPending(() => ledger);
			const access = vi.spyOn(fs.promises, 'access');

			await recorder.recordPending(() => ledger);
			await recorder.recordPending(() => ledger);

			expect(access).not.toHaveBeenCalled();
			access.mockRestore();
		});

		it('does not take a run again after a restart, with nothing saved in between', async () => {
			const ledger = [run()];
			await makeRecorder().recordPending(() => ledger);
			const before = await readTurns();

			// A new recorder, as after a start of the app, or after a crash right
			// behind the write. It remembers nothing: the file is what says so.
			await makeRecorder().recordPending(() => ledger);

			expect(await readTurns()).toEqual(before);
		});

		it('always gives one run the same turn, and two runs different ones', () => {
			expect(cliTurnId('run_cli-send_1')).toBe(cliTurnId('run_cli-send_1'));
			expect(cliTurnId('run_cli-send_1')).toMatch(/^[0-9a-f]{32}$/);
			expect(cliTurnId('run_cli-send_2')).not.toBe(cliTurnId('run_cli-send_1'));
		});

		it('does not take a run again that lies in a folder the agent used before', async () => {
			const ledger = [run()];
			await makeRecorder().recordPending(() => ledger);

			// The person chose another folder, and the app started again.
			const newFolder = path.join(root, 'new-logs');
			enabled.set(AGENT, [newFolder, folder]);
			await makeRecorder().recordPending(() => ledger);

			expect(await readTurns(newFolder)).toEqual([]);
			expect(await readTurns(folder)).toHaveLength(1);
		});

		it.each([
			['a few hours away, as after a flight', 7 * 60 * MINUTE],
			['on the date before', -24 * 60 * MINUTE],
			['two dates away, the furthest two zones can be apart', 2 * 24 * 60 * MINUTE],
		])('does not take a run again that is filed %s', async (_name, shiftMs) => {
			const ledger = [run()];
			await makeRecorder().recordPending(() => ledger);
			// The file as another time zone would have filed it: under another
			// hour, or another date, and under another time in its name.
			const [written] = await listTurnFiles(folder);
			const filedAs = turnFilePath(
				folder,
				new Date(ledger[0].createdAt + shiftMs),
				undefined,
				cliTurnId(ledger[0].id)
			);
			expect(filedAs).not.toBe(written);
			fs.mkdirSync(path.dirname(filedAs), { recursive: true });
			fs.renameSync(written, filedAs);

			// The app starts again in the new zone.
			await makeRecorder().recordPending(() => ledger);

			expect(await listTurnFiles(folder)).toEqual([filedAs]);
		});

		it('still takes a run when a file of another run only carries a name like its own', async () => {
			const reported = run();
			// A turn file of some other run, on the date before, whose name ends in
			// the same characters. A name holds only the start of a turn id.
			const lookalike = turnFilePath(
				folder,
				new Date(reported.createdAt - 24 * 60 * MINUTE),
				undefined,
				cliTurnId(reported.id)
			);
			fs.mkdirSync(path.dirname(lookalike), { recursive: true });
			fs.writeFileSync(
				lookalike,
				`${JSON.stringify({ kind: 'turn-start', cliRunId: 'some-other-run' })}\nnot a record\n`
			);

			await makeRecorder().recordPending(() => [reported]);

			expect(await listTurnFiles(folder)).toHaveLength(2);
			expect(errors).toEqual([]);
		});

		it('writes a new run into the folder the agent uses now', async () => {
			const newFolder = path.join(root, 'new-logs');
			enabled.set(AGENT, [newFolder, folder]);

			await makeRecorder().recordPending(() => [run()]);

			expect(await readTurns(newFolder)).toHaveLength(1);
			expect(await readTurns(folder)).toEqual([]);
		});

		it('writes the runs in the order they started', async () => {
			await makeRecorder().recordPending(() => [
				run({ id: 'later', createdAt: SINCE + 2 * MINUTE, prompt: 'second' }),
				run({ id: 'earlier', createdAt: SINCE + MINUTE, prompt: 'first' }),
			]);

			const byChain = (await readTurns())
				.map((records) => records[0])
				.sort((a, b) => a.chainSeq - b.chainSeq)
				.map((start) => (start.kind === 'turn-start' ? start.prompt : ''));
			expect(byChain).toEqual(['first', 'second']);
		});

		it('still takes a run that reaches the ledger after one that ended later', async () => {
			// Two runs of the command line. The one that ended first had to wait
			// for the ledger, so the one that ended later is written to it first.
			const recorder = makeRecorder();
			const endedLater = run({ id: 'ended-later', endedAfterMs: 9000, prompt: 'Ended later.' });
			const endedFirst = run({ id: 'ended-first', endedAfterMs: 2000, prompt: 'Ended first.' });

			await recorder.recordPending(() => [endedLater]);
			await recorder.recordPending(() => [endedLater, endedFirst]);

			expect((await promptsIn()).sort()).toEqual(['Ended first.', 'Ended later.']);
		});

		it('still takes a run that started first and ended after one already taken', async () => {
			const recorder = makeRecorder();
			const long = run({ id: 'long', createdAt: SINCE + MINUTE, endedAfterMs: 60_000 });
			const short = run({
				id: 'short',
				createdAt: SINCE + MINUTE + 1000,
				endedAfterMs: 2000,
				prompt: 'The short one.',
			});

			// The long run is still going when the short one ends.
			await recorder.recordPending(() => [{ ...long, status: 'running' as const }, short]);
			expect(await promptsIn()).toEqual(['The short one.']);

			await recorder.recordPending(() => [long, short]);
			expect(await readTurns()).toHaveLength(2);
		});

		it('takes two runs that started and ended in the same millisecond, each once', async () => {
			const recorder = makeRecorder();
			const first = run({ id: 'tie-a', prompt: 'a' });
			const second = run({ id: 'tie-b', prompt: 'b' });

			await recorder.recordPending(() => [first]);
			await recorder.recordPending(() => [first, second]);
			await recorder.recordPending(() => [first, second]);

			expect((await promptsIn()).sort()).toEqual(['a', 'b']);
		});

		it('runs one call at a time, so two changes at once do not write a run twice', async () => {
			const recorder = makeRecorder();
			const ledger = [run()];

			await Promise.all([
				recorder.recordPending(() => ledger),
				recorder.recordPending(() => ledger),
				recorder.recordPending(() => ledger),
			]);

			expect(await readTurns()).toHaveLength(1);
		});

		it('forgets a run the ledger no longer holds, and is not confused when it does', async () => {
			const recorder = makeRecorder();
			const old = run({ id: 'old', prompt: 'old' });
			const next = run({ id: 'next', createdAt: SINCE + 5 * MINUTE, prompt: 'next' });

			await recorder.recordPending(() => [old]);
			// The ledger dropped the old run to make room.
			await recorder.recordPending(() => [next]);
			await recorder.recordPending(() => [next]);

			expect((await promptsIn()).sort()).toEqual(['next', 'old']);
		});
	});

	// ========================================================================
	// What it costs, and what it does when something fails
	// ========================================================================

	describe('what it costs, and what a failure does', () => {
		it('does not read the ledger while nobody is recorded', async () => {
			enabled.clear();
			const readRuns = vi.fn(() => [run()]);

			await makeRecorder().recordPending(readRuns);

			expect(readRuns).not.toHaveBeenCalled();
			expect(await readTurns()).toEqual([]);
		});

		it('never rejects when the ledger cannot be read, and says so', async () => {
			await expect(
				makeRecorder().recordPending(() => {
					throw new Error('The ledger is not JSON.');
				})
			).resolves.toBeUndefined();

			expect(errors).toEqual([{ agentId: null, message: 'The ledger is not JSON.' }]);
		});

		it('goes on to the next agent when one fails', async () => {
			const otherFolder = path.join(root, 'other-logs');
			enabled.set(OTHER_AGENT, [otherFolder]);
			since.set(OTHER_AGENT, SINCE);
			const recorder = makeRecorder({
				getFolders: (agentId) => {
					if (agentId === AGENT) throw new Error('The store is closed.');
					return enabled.get(agentId) ?? [];
				},
			});

			await recorder.recordPending(() => [run({ id: 'b', agentId: OTHER_AGENT })]);

			expect(errors).toEqual([{ agentId: AGENT, message: 'The store is closed.' }]);
			expect(await readTurns(otherFolder)).toHaveLength(1);
		});

		it('does nothing for an agent that was never turned on, or that has no folder', async () => {
			since.delete(AGENT);
			await makeRecorder().recordPending(() => [run()]);
			expect(await readTurns()).toEqual([]);

			since.set(AGENT, SINCE);
			enabled.set(AGENT, []);
			await makeRecorder().recordPending(() => [run()]);
			expect(await readTurns()).toEqual([]);
			expect(errors).toEqual([]);
		});
	});
});
