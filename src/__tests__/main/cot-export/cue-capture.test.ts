/**
 * Tests for main/cot-export/cue-capture.ts and the Cue half of
 * main/cot-export/turn-assembler.ts (`decideCueRun`, `recordCompletedRun`).
 *
 * A Cue run is written once, when it has finished, from the raw stdout it
 * printed. Everything goes through the REAL writer into a fresh directory under
 * the OS temp dir and is read back from disk, and the raw stdout goes through
 * the real parsers, so a test sees what a person opening the log folder would
 * see. Every test writes to its own directory and builds paths with
 * `path.join`. None of them reads or writes the user's real data.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { createCueRunCapture } from '../../../main/cot-export/cue-capture';
import type { CotCueRunCapture } from '../../../main/cot-export/cue-capture';
import { listTurnFiles } from '../../../main/cot-export/layout';
import { decideCueRun, recordCompletedRun } from '../../../main/cot-export/turn-assembler';
import { verifyAgentChain } from '../../../main/cot-export/verify';
import { createCotWriter } from '../../../main/cot-export/writer';
import type { CueRunTranscript } from '../../../main/cue/cue-executor';
import { COT_GENESIS_CHAIN_SEQ, COT_GENESIS_HASH } from '../../../shared/cotExport/types';
import type { CotChainState, CotRecord } from '../../../shared/cotExport/types';
import { embedSystemPromptInPrompt } from '../../../shared/embeddedSystemPrompt';
import { ClaudeOutputParser } from '../../../shared/maestro-lib/parsers/claude-output-parser';
import { readTurnFiles } from './helpers';

// ============================================================================
// Fixtures
// ============================================================================

const AGENT = '11111111-2222-4333-8444-555555555555';

/** 09:30:15 on 10 October 2026, on the local clock. */
const START = new Date(2026, 9, 10, 9, 30, 15).getTime();
const DURATION_MS = 12_000;

const MSG = 'msg_01';

function assistant(block: unknown) {
	return {
		type: 'assistant',
		session_id: 'sess-1',
		message: { role: 'assistant', id: MSG, content: [block] },
	};
}

function user(block: unknown) {
	return { type: 'user', session_id: 'sess-1', message: { role: 'user', content: [block] } };
}

/** The stream of a Claude run: reasoning, a reply, two tool calls, and usage. */
const CLAUDE_LINES = [
	{ type: 'system', subtype: 'init', session_id: 'sess-1' },
	assistant({ type: 'thinking', thinking: 'The user wants a listing.', signature: 'sig-1' }),
	assistant({ type: 'text', text: 'I will list the files and read one.' }),
	assistant({ type: 'tool_use', id: 'toolu_ls', name: 'Bash', input: { command: 'ls' } }),
	assistant({ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/w/a' } }),
	user({ type: 'tool_result', tool_use_id: 'toolu_ls', content: 'a.txt\nb.txt' }),
	user({ type: 'tool_result', tool_use_id: 'toolu_read', content: 'Not found', is_error: true }),
	assistant({ type: 'text', text: 'There are two files.' }),
	{
		type: 'result',
		session_id: 'sess-1',
		result: 'There are two files.',
		modelUsage: {
			'claude-opus-5': {
				inputTokens: 7,
				outputTokens: 142,
				cacheReadInputTokens: 59482,
				cacheCreationInputTokens: 9677,
				contextWindow: 1000000,
			},
		},
		total_cost_usd: 0.5,
	},
];

const CLAUDE_STDOUT = CLAUDE_LINES.map((line) => JSON.stringify(line)).join('\n') + '\n';

/** The kinds a turn of `CLAUDE_STDOUT` must hold, in order. */
const CLAUDE_KINDS = [
	'turn-start',
	'thinking',
	'text',
	'tool-call',
	'tool-call',
	'tool-result',
	'tool-result',
	'text',
	'usage',
	'turn-end',
];

function transcript(overrides: Partial<CueRunTranscript> = {}): CueRunTranscript {
	return {
		agentId: AGENT,
		toolType: 'claude-code',
		prompt: 'List the files.',
		rawStdout: CLAUDE_STDOUT,
		cwd: '/work/project',
		startTime: START,
		exitCode: 0,
		durationMs: DURATION_MS,
		status: 'completed',
		providerSessionId: 'sess-1',
		...overrides,
	};
}

// ============================================================================
// Harness
// ============================================================================

describe('cot-export cue capture', () => {
	let root: string;
	let folder: string;
	/** Agents with export on, and the folder each writes to. */
	let enabled: Map<string, string>;
	let chains: Map<string, CotChainState>;
	let errors: Array<{ agentId: string | null; message: string }>;
	let turnIds: number;

	const chainIn = (dir: string): CotChainState => {
		let chain = chains.get(dir);
		if (!chain) {
			chain = { folder: dir, head: COT_GENESIS_HASH, chainSeq: COT_GENESIS_CHAIN_SEQ };
			chains.set(dir, chain);
		}
		return chain;
	};

	const makeWriter = () =>
		createCotWriter({
			getChainState: (_agentId, dir) => chainIn(dir),
			onHeadAdvanced: (_agentId, state) => {
				chains.set(state.folder, state);
			},
			onError: (agentId, error) => errors.push({ agentId, message: error.message }),
			now: () => START,
		});

	const makeDeps = (
		writer: Parameters<typeof createCueRunCapture>[0]['writer'] = makeWriter()
	) => ({
		isEnabled: (agentId: string) => enabled.has(agentId),
		getFolder: (agentId: string) => enabled.get(agentId) ?? null,
		writer,
		onError: (agentId: string | null, error: Error) =>
			errors.push({ agentId, message: error.message }),
		newTurnId: () => `${String(++turnIds).padStart(4, '0')}-turn`,
	});

	const makeCapture = (): CotCueRunCapture => createCueRunCapture(makeDeps());

	/** Every turn file under `dir`, oldest first, each as its records. */
	const readTurns = (dir: string = folder): Promise<CotRecord[][]> => readTurnFiles(dir);

	const kindsOf = (records: CotRecord[]): string[] => records.map((record) => record.kind);

	const ofKind = <K extends CotRecord['kind']>(
		records: CotRecord[],
		kind: K
	): Extract<CotRecord, { kind: K }>[] =>
		records.filter((record): record is Extract<CotRecord, { kind: K }> => record.kind === kind);

	/** Drives one run the way the executor does: dispatch, then the finished transcript. */
	const runOnce = async (
		capture: CotCueRunCapture,
		run: CueRunTranscript = transcript()
	): Promise<void> => {
		const callback = capture.begin(run.agentId);
		callback?.(run);
		await capture.whenIdle();
	};

	beforeEach(() => {
		// The real path, so the folder a file reports compares equal on macOS,
		// where the temp dir is reached through a symlink.
		root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cot-cue-')));
		folder = path.join(root, 'log');
		enabled = new Map([[AGENT, folder]]);
		chains = new Map();
		errors = [];
		turnIds = 0;
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	// ========================================================================
	// A whole run
	// ========================================================================

	describe('a finished Claude run', () => {
		it('writes one turn with origin cue whose chain verifies', async () => {
			await runOnce(makeCapture());

			const turns = await readTurns();
			expect(turns).toHaveLength(1);
			expect(kindsOf(turns[0])).toEqual(CLAUDE_KINDS);

			const [start] = ofKind(turns[0], 'turn-start');
			expect(start).toMatchObject({
				toolType: 'claude-code',
				origin: 'cue',
				querySource: 'cue',
				cwd: '/work/project',
				prompt: 'List the files.',
				providerSessionId: 'sess-1',
				imageCount: 0,
			});
			expect(start.tabId).toBeUndefined();

			const result = await verifyAgentChain(folder, chainIn(folder).head);
			expect(result).toMatchObject({ ok: true, headMatches: true, filesChecked: 1 });
			expect(result.recordsChecked).toBe(CLAUDE_KINDS.length);
			expect(errors).toEqual([]);
		});

		it('records the same blocks a live turn would for the same output', async () => {
			await runOnce(makeCapture());

			const [records] = await readTurns();
			expect(ofKind(records, 'thinking')[0].text).toBe('The user wants a listing.');
			expect(ofKind(records, 'text').map((r) => r.text)).toEqual([
				'I will list the files and read one.',
				'There are two files.',
			]);
			expect(ofKind(records, 'tool-call').map((r) => r.toolName)).toEqual(['Bash', 'Read']);
			expect(ofKind(records, 'tool-result').map((r) => r.status)).toEqual(['completed', 'failed']);
		});

		it('ends the turn with the run duration, exit code, and outcome', async () => {
			await runOnce(makeCapture());

			const [records] = await readTurns();
			const [end] = ofKind(records, 'turn-end');
			expect(end).toMatchObject({
				exitCode: 0,
				outcome: 'completed',
				durationMs: DURATION_MS,
				recordCount: CLAUDE_KINDS.length,
			});
		});

		it('stamps the start at the run start and every later record at the run end', async () => {
			await runOnce(makeCapture());

			const [records] = await readTurns();
			const startedAt = new Date(START).toISOString();
			const endedAt = new Date(START + DURATION_MS).toISOString();
			expect(records[0].ts).toBe(startedAt);
			expect(new Set(records.slice(1).map((record) => record.ts))).toEqual(new Set([endedAt]));
		});

		it('files the turn under the hour the run started', async () => {
			await runOnce(makeCapture());

			const [file] = await listTurnFiles(folder);
			expect(path.relative(folder, file).split(path.sep).slice(0, 4)).toEqual([
				'2026',
				'10',
				'10',
				'09',
			]);
		});
	});

	// ========================================================================
	// What a run's output can hold
	// ========================================================================

	describe('what the stream holds', () => {
		it('skips blank lines and lines that are not JSON, as the live path does', async () => {
			const rawStdout = [
				'Reading additional input from stdin...',
				'',
				JSON.stringify(CLAUDE_LINES[1]),
				'not json at all',
				JSON.stringify(CLAUDE_LINES[2]),
				JSON.stringify(CLAUDE_LINES[CLAUDE_LINES.length - 1]),
			].join('\n');

			await runOnce(makeCapture(), transcript({ rawStdout }));

			const [records] = await readTurns();
			// The result line carries a reply the stream did not show before it, so it
			// is recorded as a second `text`.
			expect(kindsOf(records)).toEqual([
				'turn-start',
				'thinking',
				'text',
				'text',
				'usage',
				'turn-end',
			]);
			expect(errors).toEqual([]);
		});

		it('records an empty stream as a turn with a start and an end', async () => {
			await runOnce(makeCapture(), transcript({ rawStdout: '' }));

			const [records] = await readTurns();
			expect(kindsOf(records)).toEqual(['turn-start', 'turn-end']);
			expect(ofKind(records, 'turn-end')[0].recordCount).toBe(2);
		});

		it('keeps the rest of the turn when the parser throws on one line, and says so', async () => {
			// The first line of the stream is the one the parser fails on.
			const spy = vi
				.spyOn(ClaudeOutputParser.prototype, 'parseJsonObject')
				.mockImplementationOnce(() => {
					throw new Error('parser fault');
				});
			try {
				await runOnce(makeCapture());
			} finally {
				spy.mockRestore();
			}

			const [records] = await readTurns();
			expect(kindsOf(records)).toEqual(['turn-start', 'capture-gap', ...CLAUDE_KINDS.slice(1)]);
			expect(ofKind(records, 'capture-gap')[0].reason).toBe('unparsed-lines:1');
			expect(ofKind(records, 'turn-end')[0].recordCount).toBe(CLAUDE_KINDS.length);
			expect(errors).toEqual([]);
		});

		it('writes a gap for a provider with no output parser, and counts it as no record', async () => {
			await runOnce(makeCapture(), transcript({ toolType: 'terminal', rawStdout: 'plain text\n' }));

			const [records] = await readTurns();
			expect(kindsOf(records)).toEqual(['turn-start', 'capture-gap', 'turn-end']);
			expect(ofKind(records, 'capture-gap')[0].reason).toBe('output-not-captured:no-parser');
			expect(ofKind(records, 'turn-end')[0].recordCount).toBe(2);
			await expect(verifyAgentChain(folder, chainIn(folder).head)).resolves.toMatchObject({
				ok: true,
			});
		});

		it('reads Copilot objects that follow each other with no newline between them', async () => {
			const objects = [
				{ type: 'assistant.turn_start' },
				{ type: 'assistant.reasoning_delta', data: { deltaContent: 'Need the file list. ' } },
				{ type: 'assistant.message_delta', data: { deltaContent: 'One ' } },
				{ type: 'assistant.message_delta', data: { deltaContent: 'file.' } },
				{ type: 'assistant.message', data: { content: 'One file.' } },
			];
			const rawStdout = 'Starting up\n' + objects.map((o) => JSON.stringify(o)).join('');

			await runOnce(makeCapture(), transcript({ toolType: 'copilot-cli', rawStdout }));

			const [records] = await readTurns();
			expect(kindsOf(records)).toEqual(['turn-start', 'thinking', 'text', 'turn-end']);
			expect(ofKind(records, 'text')[0].text).toBe('One file.');
			expect(ofKind(records, 'thinking')[0].text).toBe('Need the file list. ');
		});

		it('keeps a prompt that merely contains the system prompt marker whole', async () => {
			// Cue puts no system prompt in front of its prompt, so a marker in it is the
			// subscription author's own text and must not be cut out of the record.
			const prompt = embedSystemPromptInPrompt('Be careful.', 'Review the diff.');

			await runOnce(makeCapture(), transcript({ toolType: 'codex', prompt, rawStdout: '' }));

			const [records] = await readTurns();
			const [start] = ofKind(records, 'turn-start');
			expect(start.prompt).toBe(prompt);
			expect(start.systemPromptSha256).toBeUndefined();
		});

		it('names the SSH remote of a run that ran on one', async () => {
			await runOnce(makeCapture(), transcript({ sshRemoteId: 'remote-1' }));

			const [records] = await readTurns();
			expect(ofKind(records, 'turn-start')[0].sshRemoteId).toBe('remote-1');
		});
	});

	// ========================================================================
	// How a run ended
	// ========================================================================

	describe('how the run ended', () => {
		it.each([
			['completed', 0, 'completed'],
			['failed', 1, 'crashed'],
			['stopped', 0, 'interrupted'],
			['timeout', null, 'interrupted'],
		] as const)('maps a %s run to the outcome %s', async (status, exitCode, outcome) => {
			await runOnce(makeCapture(), transcript({ status, exitCode }));

			const [records] = await readTurns();
			expect(ofKind(records, 'turn-end')[0]).toMatchObject({ exitCode, outcome });
		});
	});

	// ========================================================================
	// Which runs are recorded
	// ========================================================================

	describe('which runs are recorded', () => {
		it('gives no callback, and writes nothing, for an agent with export off', async () => {
			enabled.clear();
			const capture = makeCapture();

			expect(capture.begin(AGENT)).toBeUndefined();
			await capture.whenIdle();

			expect(await listTurnFiles(folder)).toEqual([]);
			expect(errors).toEqual([]);
		});

		it('writes nothing for an agent with no folder', async () => {
			const deps = { ...makeDeps(), getFolder: () => null };

			expect(createCueRunCapture(deps).begin(AGENT)).toBeUndefined();
		});

		it('records a run that was dispatched with export on, whatever happens during it', async () => {
			const capture = makeCapture();
			const callback = capture.begin(AGENT);
			expect(callback).toBeDefined();

			enabled.clear();
			callback?.(transcript());
			await capture.whenIdle();

			expect(await readTurns()).toHaveLength(1);
		});

		it('does not pick up a run that was dispatched with export off', async () => {
			enabled.clear();
			const capture = makeCapture();
			const callback = capture.begin(AGENT);

			enabled.set(AGENT, folder);
			callback?.(transcript());
			await capture.whenIdle();

			expect(callback).toBeUndefined();
			expect(await listTurnFiles(folder)).toEqual([]);
		});

		it('writes to the folder chosen at dispatch, not the one chosen after', async () => {
			const capture = makeCapture();
			const callback = capture.begin(AGENT);
			const other = path.join(root, 'elsewhere');
			enabled.set(AGENT, other);

			callback?.(transcript());
			await capture.whenIdle();

			expect(await readTurns(folder)).toHaveLength(1);
			expect(await listTurnFiles(other)).toEqual([]);
		});

		it('chains two runs of one agent into one chain that verifies', async () => {
			const capture = makeCapture();
			await runOnce(capture);
			await runOnce(capture, transcript({ startTime: START + 60_000 }));

			expect(await readTurns()).toHaveLength(2);
			await expect(verifyAgentChain(folder, chainIn(folder).head)).resolves.toMatchObject({
				ok: true,
				filesChecked: 2,
				recordsChecked: CLAUDE_KINDS.length * 2,
			});
		});
	});

	// ========================================================================
	// Failure
	// ========================================================================

	describe('failure', () => {
		it('keeps a failed check of the switch as an error and gives no callback', () => {
			const deps = {
				...makeDeps(),
				isEnabled: () => {
					throw new Error('store unavailable');
				},
			};

			expect(decideCueRun(AGENT, deps)).toBeNull();
			expect(errors).toEqual([{ agentId: AGENT, message: 'store unavailable' }]);
		});

		it('keeps a writer that throws as an error and never throws into the caller', async () => {
			const writer = {
				append: vi.fn(() => {
					throw new Error('disk gone');
				}),
			};
			const capture = createCueRunCapture(makeDeps(writer as never));
			const callback = capture.begin(AGENT);

			expect(() => callback?.(transcript())).not.toThrow();
			await capture.whenIdle();

			expect(writer.append).toHaveBeenCalled();
			expect(errors.length).toBeGreaterThan(0);
			expect(errors.every((e) => e.agentId === AGENT && e.message === 'disk gone')).toBe(true);
		});

		it('recordCompletedRun resolves when the parser is given a stream it cannot read', async () => {
			const writer = makeWriter();
			const decision = { agentId: AGENT, folder };

			await expect(
				recordCompletedRun(
					decision,
					{
						toolType: 'claude-code',
						cwd: '/work/project',
						prompt: 'p',
						rawStdout: '{"type":"assistant","message":42}\n[1,2,3]\n"text"\n7\nnull\n',
						startTime: START,
						durationMs: 0,
						exitCode: 0,
					},
					{ writer, onError: () => undefined }
				)
			).resolves.toBeUndefined();
			await expect(verifyAgentChain(folder, chainIn(folder).head)).resolves.toMatchObject({
				ok: true,
			});
		});
	});
});
