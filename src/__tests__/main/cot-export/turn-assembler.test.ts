/**
 * Tests for main/cot-export/turn-assembler.ts.
 *
 * The assembler is driven the way the process manager drives it: a spawn, the
 * parsed lines of the process, an exit. Everything it writes goes through the
 * REAL writer into a fresh directory under the OS temp dir, and is read back
 * from disk, so a test sees what a person opening the log folder would see.
 * Claude lines go through the real parser first.
 *
 * Every test writes to its own directory and builds paths with `path.join`.
 * None of them reads or writes the user's real data.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { sha256Hex } from '../../../main/cot-export/hash-chain';
import { listTurnFiles } from '../../../main/cot-export/layout';
import { createCotTurnAssembler } from '../../../main/cot-export/turn-assembler';
import type {
	CotSpawnConfig,
	CotTurnAssembler,
	CotTurnAssemblerDeps,
} from '../../../main/cot-export/turn-assembler';
import type { CotTarget } from '../../../main/cot-export/resolve-agent';
import { verifyAgentChain } from '../../../main/cot-export/verify';
import { createCotWriter } from '../../../main/cot-export/writer';
import type { ParsedEvent } from '../../../main/parsers/agent-output-parser';
import { ClaudeOutputParser } from '../../../main/parsers/claude-output-parser';
import { COT_GENESIS_CHAIN_SEQ, COT_GENESIS_HASH } from '../../../shared/cotExport/types';
import type { CotChainState, CotRecord } from '../../../shared/cotExport/types';
import { embedSystemPromptInPrompt } from '../../../shared/embeddedSystemPrompt';
import { readTurnFiles } from './helpers';

// ============================================================================
// Fixtures
// ============================================================================

const AGENT = '11111111-2222-4333-8444-555555555555';
const OTHER_AGENT = '66666666-7777-4888-8999-000000000000';
const TAB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PROCESS = `${AGENT}-ai-${TAB}`;

/** 09:30:15 on 10 October 2026, on the local clock. */
const START = new Date(2026, 9, 10, 9, 30, 15).getTime();

const MSG = 'msg_01';

/** An `assistant` line of the Claude CLI: one content block for each line. */
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

const CLAUDE_LINES = [
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

/** The kinds a turn of `CLAUDE_LINES` must hold, in order. */
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

/** The lines as the real parser turns them into events. One parser for each turn. */
function claudeEvents(lines: unknown[] = CLAUDE_LINES): ParsedEvent[] {
	const parser = new ClaudeOutputParser();
	const events: ParsedEvent[] = [];
	for (const line of lines) {
		const event = parser.parseJsonLine(JSON.stringify(line));
		if (event) events.push(event);
	}
	return events;
}

/**
 * A piece of streamed text, built by hand. No one parser emits every sequence
 * these tests need, and joining has to hold for any provider that streams.
 */
function piece(text: string, isReasoning = false): ParsedEvent {
	return { type: 'text', text, isPartial: true, ...(isReasoning ? { isReasoning } : {}) };
}

function toolRunning(toolCallId: string): ParsedEvent {
	return {
		type: 'tool_use',
		toolName: 'run',
		toolCallId,
		toolState: { status: 'running', input: { command: 'ls' } },
	};
}

function spawnConfig(overrides: Partial<CotSpawnConfig> = {}): CotSpawnConfig {
	return {
		sessionId: PROCESS,
		toolType: 'claude-code',
		cwd: '/work/project',
		prompt: 'List the files.',
		querySource: 'user',
		...overrides,
	};
}

/** A promise a test settles by hand, to hold the agent lookup open. */
function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

// ============================================================================
// Harness
// ============================================================================

describe('cot-export turn assembler', () => {
	let root: string;
	let folder: string;
	let clock: number;
	/** Agents with export on, and the folder each writes to. */
	let enabled: Map<string, string>;
	/** One chain for each folder, as the store would hold them. */
	let chains: Map<string, CotChainState>;
	let errors: Array<{ agentId: string | null; message: string }>;
	let following: boolean[];
	let turnIds: number;

	const chainIn = (dir: string): CotChainState => {
		let chain = chains.get(dir);
		if (!chain) {
			chain = { folder: dir, head: COT_GENESIS_HASH, chainSeq: COT_GENESIS_CHAIN_SEQ };
			chains.set(dir, chain);
		}
		return chain;
	};

	/** What `peekAgentId` and `resolveTarget` answer for the ids these tests use. */
	const targetOf = (processSessionId: string): CotTarget | null => {
		for (const agentId of [AGENT, OTHER_AGENT]) {
			if (processSessionId.startsWith(`${agentId}-ai-`)) {
				return {
					agentId,
					origin: 'interactive',
					tabId: processSessionId.slice(agentId.length + 4),
				};
			}
			if (processSessionId.startsWith(`${agentId}-batch-`)) return { agentId, origin: 'auto-run' };
		}
		return null;
	};

	const makeAssembler = (overrides: Partial<CotTurnAssemblerDeps> = {}): CotTurnAssembler => {
		const writer = createCotWriter({
			getChainState: (_agentId, dir) => chainIn(dir),
			onHeadAdvanced: (_agentId, state) => {
				chains.set(state.folder, state);
			},
			onError: (agentId, error) => errors.push({ agentId, message: error.message }),
			now: () => clock,
		});
		return createCotTurnAssembler({
			peekAgentId: (id) => targetOf(id)?.agentId ?? null,
			resolveTarget: async (id) => targetOf(id),
			isEnabled: (agentId) => enabled.has(agentId),
			getFolder: (agentId) => enabled.get(agentId) ?? null,
			isProcessRunning: () => true,
			writer,
			onError: (agentId, error) => errors.push({ agentId, message: error.message }),
			onFollowingChange: (value) => following.push(value),
			now: () => clock,
			newTurnId: () => `${String(++turnIds).padStart(4, '0')}-turn`,
			...overrides,
		});
	};

	/** Every turn file under `dir`, oldest first, each as its records. */
	const readTurns = (dir: string = folder): Promise<CotRecord[][]> => readTurnFiles(dir);

	const kindsOf = (records: CotRecord[]): string[] => records.map((record) => record.kind);

	const ofKind = <K extends CotRecord['kind']>(
		records: CotRecord[],
		kind: K
	): Extract<CotRecord, { kind: K }>[] =>
		records.filter((record): record is Extract<CotRecord, { kind: K }> => record.kind === kind);

	/** Drives one whole turn: a spawn, its events a second apart, then the exit. */
	const runTurn = async (
		assembler: CotTurnAssembler,
		events: ParsedEvent[],
		config: CotSpawnConfig = spawnConfig(),
		exit: { code: number | null; outcome?: string } = { code: 0 }
	): Promise<void> => {
		assembler.handleSpawn(config);
		for (const event of events) {
			clock += 1000;
			assembler.handleParsedEvent(config.sessionId, event);
		}
		clock += 1000;
		assembler.handleExit(config.sessionId, exit.code, exit.outcome);
		await assembler.whenIdle();
	};

	beforeEach(() => {
		// The real path, so the folder a file reports compares equal on macOS,
		// where the temp dir is reached through a symlink.
		root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cot-assembler-')));
		folder = path.join(root, 'log');
		clock = START;
		enabled = new Map([[AGENT, folder]]);
		chains = new Map();
		errors = [];
		following = [];
		turnIds = 0;
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	// ========================================================================
	// A whole turn
	// ========================================================================

	describe('a whole turn', () => {
		it('writes one file whose records are the turn, in order, and whose chain verifies', async () => {
			await runTurn(makeAssembler(), claudeEvents());

			const turns = await readTurns();
			expect(turns).toHaveLength(1);
			expect(kindsOf(turns[0])).toEqual(CLAUDE_KINDS);

			const result = await verifyAgentChain(folder, chainIn(folder).head);
			expect(result).toMatchObject({ ok: true, headMatches: true, filesChecked: 1 });
			expect(result.recordsChecked).toBe(CLAUDE_KINDS.length);
			expect(errors).toEqual([]);
		});

		it('gives every record of the turn one turn id and a position with no holes', async () => {
			await runTurn(makeAssembler(), claudeEvents());

			const [records] = await readTurns();
			expect(new Set(records.map((record) => record.turnId))).toEqual(new Set(['0001-turn']));
			expect(records.map((record) => record.seq)).toEqual(records.map((_, index) => index));
			expect(new Set(records.map((record) => record.agentId))).toEqual(new Set([AGENT]));
		});

		it('files the turn under the hour it started, named for its tab and turn', async () => {
			await runTurn(makeAssembler(), claudeEvents());

			const [file] = await listTurnFiles(folder);
			expect(file).toBe(
				path.join(folder, '2026', '10', '10', '09', '093015-aaaaaaaa-0001-tur.jsonl')
			);
		});

		it('records what was asked and where, in turn-start', async () => {
			await runTurn(
				makeAssembler(),
				[],
				spawnConfig({ images: ['a.png', 'b.png'], agentSessionId: 'provider-session-9' })
			);

			const [records] = await readTurns();
			const { v, kind, agentId, turnId, seq, chainSeq, ts, prevHash, hash, ...payload } =
				records[0];
			expect(payload).toStrictEqual({
				toolType: 'claude-code',
				origin: 'interactive',
				tabId: TAB,
				providerSessionId: 'provider-session-9',
				cwd: '/work/project',
				querySource: 'user',
				prompt: 'List the files.',
				imageCount: 2,
			});
			expect(kind).toBe('turn-start');
			expect(ts).toBe(new Date(START).toISOString());
		});

		it('leaves out of turn-start what the turn does not have', async () => {
			await runTurn(
				makeAssembler(),
				[],
				spawnConfig({ sessionId: `${AGENT}-batch-1767225600000`, querySource: undefined })
			);

			const [records] = await readTurns();
			expect(records[0]).toMatchObject({ kind: 'turn-start', origin: 'auto-run', imageCount: 0 });
			for (const key of ['tabId', 'providerSessionId', 'querySource', 'sshRemoteId']) {
				expect(records[0]).not.toHaveProperty(key);
			}
			expect(records[0]).not.toHaveProperty('systemPromptSha256');
		});

		it('closes the turn with its exit code, how long it ran, and how many records it has', async () => {
			const events = claudeEvents();
			await runTurn(makeAssembler(), events, spawnConfig(), { code: 0, outcome: 'completed' });

			const [records] = await readTurns();
			const [end] = ofKind(records, 'turn-end');
			expect(events).toHaveLength(CLAUDE_LINES.length);
			expect(end).toMatchObject({
				exitCode: 0,
				outcome: 'completed',
				// One second for each line, and one more to the exit.
				durationMs: (events.length + 1) * 1000,
				recordCount: records.length,
			});
			expect(end.ts).toBe(new Date(clock).toISOString());
		});

		it('says so when the turn was stopped, which the exit code alone does not show', async () => {
			await runTurn(makeAssembler(), claudeEvents().slice(0, 2), spawnConfig(), {
				code: 0,
				outcome: 'interrupted',
			});

			const [records] = await readTurns();
			expect(ofKind(records, 'turn-end')[0]).toMatchObject({ exitCode: 0, outcome: 'interrupted' });
		});

		it('leaves the outcome out when Maestro gave none', async () => {
			await runTurn(makeAssembler(), [], spawnConfig(), { code: 1 });

			const [records] = await readTurns();
			expect(ofKind(records, 'turn-end')[0]).toMatchObject({ exitCode: 1 });
			expect(ofKind(records, 'turn-end')[0]).not.toHaveProperty('outcome');
		});

		it('stamps each record with the time its event arrived', async () => {
			await runTurn(makeAssembler(), claudeEvents());

			const [records] = await readTurns();
			const times = records.map((record) => Date.parse(record.ts));
			expect(times[0]).toBe(START);
			expect(times[1]).toBe(START + 1000);
			expect([...times].sort((a, b) => a - b)).toEqual(times);
		});

		it('keeps the agent in step across two turns, in two files and one chain', async () => {
			const assembler = makeAssembler();
			await runTurn(assembler, claudeEvents());
			clock += 60_000;
			await runTurn(assembler, claudeEvents());

			const turns = await readTurns();
			expect(turns).toHaveLength(2);
			expect(turns.map((records) => records[0].turnId)).toEqual(['0001-turn', '0002-turn']);
			const positions = turns.flat().map((record) => record.chainSeq);
			expect(positions).toEqual(positions.map((_, index) => index));
			await expect(verifyAgentChain(folder, chainIn(folder).head)).resolves.toMatchObject({
				ok: true,
				filesChecked: 2,
			});
		});

		it('records two tabs of one agent that run at the same time, each in its own file', async () => {
			const assembler = makeAssembler();
			const first = spawnConfig({ sessionId: `${AGENT}-ai-tab-one` });
			const second = spawnConfig({ sessionId: `${AGENT}-ai-tab-two` });
			const firstEvents = claudeEvents();
			const secondEvents = claudeEvents();

			assembler.handleSpawn(first);
			assembler.handleSpawn(second);
			for (let i = 0; i < firstEvents.length; i++) {
				assembler.handleParsedEvent(first.sessionId, firstEvents[i]);
				assembler.handleParsedEvent(second.sessionId, secondEvents[i]);
			}
			assembler.handleExit(second.sessionId, 0);
			assembler.handleExit(first.sessionId, 0);
			await assembler.whenIdle();

			const turns = await readTurns();
			expect(turns).toHaveLength(2);
			for (const records of turns) expect(kindsOf(records)).toEqual(CLAUDE_KINDS);
			await expect(verifyAgentChain(folder, chainIn(folder).head)).resolves.toMatchObject({
				ok: true,
				recordsChecked: CLAUDE_KINDS.length * 2,
			});
		});
	});

	// ========================================================================
	// Which turns are recorded
	// ========================================================================

	describe('which turns are recorded', () => {
		it('writes nothing for an agent with export off, and never asks whom the process belongs to', async () => {
			enabled.clear();
			const resolveTarget = vi.fn(async (id: string) => targetOf(id));
			await runTurn(makeAssembler({ resolveTarget }), claudeEvents());

			expect(await readTurns()).toEqual([]);
			expect(fs.existsSync(folder)).toBe(false);
			expect(resolveTarget).not.toHaveBeenCalled();
			expect(following).toEqual([]);
		});

		it('writes nothing for a process that is not an agent turn, and never asks whether export is on', async () => {
			const isEnabled = vi.fn(() => true);
			const resolveTarget = vi.fn(async (id: string) => targetOf(id));
			await runTurn(
				makeAssembler({ isEnabled, resolveTarget }),
				claudeEvents(),
				spawnConfig({ sessionId: `${AGENT}-synopsis-1767225600000` })
			);

			expect(await readTurns()).toEqual([]);
			expect(isEnabled).not.toHaveBeenCalled();
			expect(resolveTarget).not.toHaveBeenCalled();
		});

		it('writes nothing for an agent with export on and no folder', async () => {
			await runTurn(makeAssembler({ getFolder: () => null }), claudeEvents());

			expect(await readTurns()).toEqual([]);
			expect(following).toEqual([]);
		});

		it('does not pick up a turn when export is turned on after it started', async () => {
			enabled.clear();
			const assembler = makeAssembler();
			const events = claudeEvents();

			assembler.handleSpawn(spawnConfig());
			enabled.set(AGENT, folder);
			for (const event of events) assembler.handleParsedEvent(PROCESS, event);
			assembler.handleExit(PROCESS, 0);
			await assembler.whenIdle();

			expect(await readTurns()).toEqual([]);
		});

		it('picks up the next turn after export is turned on', async () => {
			enabled.clear();
			const assembler = makeAssembler();
			await runTurn(assembler, claudeEvents());
			enabled.set(AGENT, folder);
			await runTurn(assembler, claudeEvents());

			expect(await readTurns()).toHaveLength(1);
		});

		it('finishes a turn that was running when export was turned off', async () => {
			const assembler = makeAssembler();
			const events = claudeEvents();

			assembler.handleSpawn(spawnConfig());
			enabled.clear();
			for (const event of events) assembler.handleParsedEvent(PROCESS, event);
			assembler.handleExit(PROCESS, 0);
			await assembler.whenIdle();

			const [records] = await readTurns();
			expect(kindsOf(records)).toEqual(CLAUDE_KINDS);
		});

		it('keeps a running turn in the folder it started in when the folder is changed', async () => {
			const assembler = makeAssembler();
			const newFolder = path.join(root, 'log-two');
			const events = claudeEvents();

			assembler.handleSpawn(spawnConfig());
			enabled.set(AGENT, newFolder);
			for (const event of events) assembler.handleParsedEvent(PROCESS, event);
			assembler.handleExit(PROCESS, 0);
			await assembler.whenIdle();

			expect(await readTurns(folder)).toHaveLength(1);
			expect(await readTurns(newFolder)).toEqual([]);

			clock += 60_000;
			await runTurn(assembler, claudeEvents());
			expect(await readTurns(newFolder)).toHaveLength(1);
		});

		it('ignores the events and the exit of a process it never saw start', async () => {
			const assembler = makeAssembler();
			for (const event of claudeEvents()) assembler.handleParsedEvent(PROCESS, event);
			assembler.handleExit(PROCESS, 0);
			await assembler.whenIdle();

			expect(await readTurns()).toEqual([]);
			expect(errors).toEqual([]);
		});

		it('ignores what a process prints after its exit', async () => {
			const assembler = makeAssembler();
			await runTurn(assembler, claudeEvents().slice(0, 2));
			assembler.handleParsedEvent(PROCESS, piece('late'));
			assembler.handleExit(PROCESS, 1);
			await assembler.whenIdle();

			const [records] = await readTurns();
			expect(kindsOf(records)).toEqual(['turn-start', 'thinking', 'text', 'turn-end']);
		});
	});

	// ========================================================================
	// While the agent is being looked up
	// ========================================================================

	describe('while the agent of a process is being looked up', () => {
		it('holds the events that arrive meanwhile and writes them in order', async () => {
			const lookup = deferred<CotTarget | null>();
			const assembler = makeAssembler({ resolveTarget: () => lookup.promise });
			const events = claudeEvents();

			assembler.handleSpawn(spawnConfig());
			for (const event of events.slice(0, 4)) assembler.handleParsedEvent(PROCESS, event);
			lookup.resolve(targetOf(PROCESS));
			await assembler.whenIdle();
			for (const event of events.slice(4)) assembler.handleParsedEvent(PROCESS, event);
			assembler.handleExit(PROCESS, 0);
			await assembler.whenIdle();

			const [records] = await readTurns();
			expect(kindsOf(records)).toEqual(CLAUDE_KINDS);
		});

		it('writes a whole turn that ended before the lookup came back', async () => {
			const lookup = deferred<CotTarget | null>();
			const assembler = makeAssembler({ resolveTarget: () => lookup.promise });

			assembler.handleSpawn(spawnConfig());
			for (const event of claudeEvents()) assembler.handleParsedEvent(PROCESS, event);
			clock += 5000;
			assembler.handleExit(PROCESS, 0);
			clock += 5000;
			lookup.resolve(targetOf(PROCESS));
			await assembler.whenIdle();

			const [records] = await readTurns();
			expect(kindsOf(records)).toEqual(CLAUDE_KINDS);
			// The end is timed when the process ended, not when the lookup came back.
			expect(ofKind(records, 'turn-end')[0].durationMs).toBe(5000);
			expect(following).toEqual([true, false]);
		});

		it('writes nothing when the lookup says the process is not an agent turn', async () => {
			const assembler = makeAssembler({ resolveTarget: async () => null });
			await runTurn(assembler, claudeEvents());

			expect(await readTurns()).toEqual([]);
			expect(following).toEqual([true, false]);
			expect(errors).toEqual([]);
		});

		it('writes nothing when the lookup names another agent than the one decided on', async () => {
			const assembler = makeAssembler({
				resolveTarget: async () => ({ agentId: OTHER_AGENT, origin: 'group-chat' }),
			});
			await runTurn(assembler, claudeEvents());

			expect(await readTurns()).toEqual([]);
			expect(following).toEqual([true, false]);
		});

		it('writes nothing and reports the failure when the lookup fails', async () => {
			const assembler = makeAssembler({
				resolveTarget: async () => {
					throw new Error('metadata unreadable');
				},
			});
			await runTurn(assembler, claudeEvents());

			expect(await readTurns()).toEqual([]);
			expect(errors).toEqual([{ agentId: AGENT, message: 'metadata unreadable' }]);
			expect(following).toEqual([true, false]);
		});

		it('records the next turn of the same process id after a lookup that said no', async () => {
			let answers = 0;
			const assembler = makeAssembler({
				resolveTarget: async (id) => (answers++ === 0 ? null : targetOf(id)),
			});
			await runTurn(assembler, claudeEvents());
			await runTurn(assembler, claudeEvents());

			const turns = await readTurns();
			expect(turns).toHaveLength(1);
			expect(kindsOf(turns[0])).toEqual(CLAUDE_KINDS);
		});
	});

	// ========================================================================
	// Joining streamed text
	// ========================================================================

	describe('joining streamed text', () => {
		const streaming = (overrides: Partial<CotSpawnConfig> = {}): CotSpawnConfig =>
			spawnConfig({ toolType: 'opencode', agentSessionId: 'ses_1', ...overrides });

		it('writes the pieces of one block as one record', async () => {
			await runTurn(
				makeAssembler(),
				[piece('The '), piece('files '), piece('are '), piece('listed.')],
				streaming()
			);

			const [records] = await readTurns();
			expect(kindsOf(records)).toEqual(['turn-start', 'text', 'turn-end']);
			expect(ofKind(records, 'text')[0]).toMatchObject({
				text: 'The files are listed.',
				blockIndex: 0,
			});
			expect(ofKind(records, 'turn-end')[0].recordCount).toBe(3);
		});

		it('times a joined record at its first piece', async () => {
			await runTurn(makeAssembler(), [piece('a'), piece('b'), piece('c')], streaming());

			const [records] = await readTurns();
			expect(ofKind(records, 'text')[0].ts).toBe(new Date(START + 1000).toISOString());
		});

		it('ends a block where reasoning turns into reply text', async () => {
			await runTurn(
				makeAssembler(),
				[piece('Let me ', true), piece('think.', true), piece('Done'), piece('.')],
				streaming()
			);

			const [records] = await readTurns();
			expect(kindsOf(records)).toEqual(['turn-start', 'thinking', 'text', 'turn-end']);
			expect(ofKind(records, 'thinking')[0].text).toBe('Let me think.');
			expect(ofKind(records, 'text')[0].text).toBe('Done.');
		});

		it('writes the text held so far ahead of a tool call, so the order of the turn is kept', async () => {
			await runTurn(
				makeAssembler(),
				[piece('I will '), piece('look.'), toolRunning('t1'), piece('Found '), piece('it.')],
				streaming()
			);

			const [records] = await readTurns();
			expect(kindsOf(records)).toEqual(['turn-start', 'text', 'tool-call', 'text', 'turn-end']);
			expect(ofKind(records, 'text').map((record) => record.text)).toEqual([
				'I will look.',
				'Found it.',
			]);
		});

		it('writes a long block in pieces once 8 KB is held, and loses none of it', async () => {
			const chunk = 'x'.repeat(1000);
			const pieces = Array.from({ length: 20 }, (_, index) => piece(`${index}:${chunk}`));
			await runTurn(makeAssembler(), pieces, streaming());

			const [records] = await readTurns();
			const texts = ofKind(records, 'text');
			expect(texts.length).toBeGreaterThan(1);
			// Every piece names the same block, and together they are the text.
			expect(new Set(texts.map((record) => record.blockIndex))).toEqual(new Set([0]));
			expect(texts.map((record) => record.text).join('')).toBe(
				pieces.map((event) => event.text).join('')
			);
			// A record is written as soon as 8 KB is held, so none holds much more.
			for (const record of texts) {
				expect(Buffer.byteLength(record.text, 'utf8')).toBeLessThan(8 * 1024 + 1100);
			}
			expect(Buffer.byteLength(texts[0].text, 'utf8')).toBeGreaterThanOrEqual(8 * 1024);
		});

		it('counts the 8 KB in bytes, not characters', async () => {
			// The euro sign: three bytes in UTF-8, so 3,000 of them are 9,000 bytes.
			const wide = String.fromCharCode(0x20ac).repeat(1500);
			await runTurn(makeAssembler(), [piece(wide), piece(wide), piece('end')], streaming());

			const [records] = await readTurns();
			expect(ofKind(records, 'text').map((record) => record.text)).toEqual([wide + wide, 'end']);
		});

		it('writes what is still held when the turn ends, ahead of turn-end', async () => {
			await runTurn(
				makeAssembler(),
				[toolRunning('t1'), piece('Last '), piece('words')],
				streaming()
			);

			const [records] = await readTurns();
			expect(kindsOf(records)).toEqual(['turn-start', 'tool-call', 'text', 'turn-end']);
			expect(ofKind(records, 'text')[0].text).toBe('Last words');
		});

		it('does not join two blocks of one message that the provider sent whole', async () => {
			const lines = [
				assistant({ type: 'text', text: 'First paragraph.' }),
				assistant({ type: 'text', text: 'Second paragraph.' }),
			];
			await runTurn(makeAssembler(), claudeEvents(lines));

			const [records] = await readTurns();
			expect(ofKind(records, 'text').map((record) => [record.blockIndex, record.text])).toEqual([
				[0, 'First paragraph.'],
				[1, 'Second paragraph.'],
			]);
		});
	});

	// ========================================================================
	// The prompt
	// ========================================================================

	describe('the prompt', () => {
		const SYSTEM = 'You are a Maestro agent.\n\nWorking directory: /work/project';
		const wrapped = embedSystemPromptInPrompt(SYSTEM, 'List the files.');

		it('takes out the system prompt a provider was given inside its first message, and keeps its hash', async () => {
			await runTurn(makeAssembler(), [], spawnConfig({ toolType: 'codex', prompt: wrapped }));

			const [records] = await readTurns();
			expect(records[0]).toMatchObject({
				prompt: 'List the files.',
				systemPromptSha256: sha256Hex(SYSTEM),
			});
			expect(JSON.stringify(records)).not.toContain('You are a Maestro agent');
		});

		it('keeps the whole prompt of a resumed conversation, where no system prompt is sent', async () => {
			await runTurn(
				makeAssembler(),
				[],
				spawnConfig({ toolType: 'codex', prompt: wrapped, agentSessionId: 'thread-1' })
			);

			const [records] = await readTurns();
			expect(records[0]).toMatchObject({ prompt: wrapped });
			expect(records[0]).not.toHaveProperty('systemPromptSha256');
		});

		it('keeps the whole prompt for a provider that takes its system prompt as a flag', async () => {
			await runTurn(makeAssembler(), [], spawnConfig({ toolType: 'claude-code', prompt: wrapped }));

			const [records] = await readTurns();
			expect(records[0]).toMatchObject({ prompt: wrapped });
			expect(records[0]).not.toHaveProperty('systemPromptSha256');
		});

		it('keeps a prompt that only quotes the marker at its very start', async () => {
			const prompt = '\n\n---\n\n# User Request\n\nWhat does this heading mean?';
			await runTurn(makeAssembler(), [], spawnConfig({ toolType: 'codex', prompt }));

			const [records] = await readTurns();
			expect(records[0]).toMatchObject({ prompt });
			expect(records[0]).not.toHaveProperty('systemPromptSha256');
		});

		it('names the agent that asked, for a turn that answers a consult', async () => {
			const assembler = makeAssembler({
				peekAgentId: () => AGENT,
				resolveTarget: async () => ({ agentId: AGENT, origin: 'consult', consultedBy: 'asker-1' }),
			});
			await runTurn(assembler, [], spawnConfig({ sessionId: 'cross-agent-req-1' }));

			const [records] = await readTurns();
			expect(records[0]).toMatchObject({ origin: 'consult', consultedBy: 'asker-1' });
			expect(records[0]).not.toHaveProperty('tabId');
		});

		it('names no asking agent for any other turn', async () => {
			await runTurn(makeAssembler(), [], spawnConfig());

			const [records] = await readTurns();
			expect(records[0]).not.toHaveProperty('consultedBy');
		});

		it('says so when the provider has no output parser, so no line of the turn can be read', async () => {
			// `terminal` stands for any provider Maestro has no parser for: its
			// output is passed on as raw text and never arrives here as an event.
			await runTurn(makeAssembler(), [], spawnConfig({ toolType: 'terminal' }));

			const [records] = await readTurns();
			expect(kindsOf(records)).toEqual(['turn-start', 'capture-gap', 'turn-end']);
			expect(records[1]).toMatchObject({ reason: 'output-not-captured:no-parser' });
			// The gap is Maestro's note about the log, not a record of the turn.
			expect(records[2]).toMatchObject({ recordCount: 2 });
		});

		it('writes no such gap for a provider it can read', async () => {
			await runTurn(makeAssembler(), [], spawnConfig({ toolType: 'claude-code' }));

			const [records] = await readTurns();
			expect(kindsOf(records)).toEqual(['turn-start', 'turn-end']);
		});

		it('says so when the prompt of a turn on an SSH remote did not reach it', async () => {
			await runTurn(
				makeAssembler(),
				claudeEvents().slice(0, 2),
				spawnConfig({
					prompt: undefined,
					cwd: '/Users/me',
					projectPath: '/srv/project',
					sshRemoteId: 'remote-1',
					sshStdinScript: 'cd /srv/project && exec claude --print',
				})
			);

			const [records] = await readTurns();
			expect(kindsOf(records)).toEqual([
				'turn-start',
				'capture-gap',
				'thinking',
				'text',
				'turn-end',
			]);
			expect(records[0]).toMatchObject({
				prompt: '',
				cwd: '/srv/project',
				sshRemoteId: 'remote-1',
			});
			expect(records[1]).toMatchObject({ reason: 'prompt-not-captured:ssh-remote' });
			// The script the prompt travels in is never written to the log.
			expect(JSON.stringify(records)).not.toContain('exec claude');
		});

		it('does not count that note in the records of the turn', async () => {
			await runTurn(
				makeAssembler(),
				claudeEvents().slice(0, 2),
				spawnConfig({ prompt: undefined, sshRemoteId: 'remote-1' })
			);

			const [records] = await readTurns();
			expect(records).toHaveLength(5);
			expect(ofKind(records, 'turn-end')[0].recordCount).toBe(4);
		});

		it('records an empty prompt the person really sent without a note', async () => {
			await runTurn(makeAssembler(), [], spawnConfig({ prompt: '' }));

			const [records] = await readTurns();
			expect(kindsOf(records)).toEqual(['turn-start', 'turn-end']);
			expect(records[0]).toMatchObject({ prompt: '' });
		});

		it('says so for a local turn that came with no prompt', async () => {
			await runTurn(makeAssembler(), [], spawnConfig({ prompt: undefined }));

			const [records] = await readTurns();
			expect(records[1]).toMatchObject({ kind: 'capture-gap', reason: 'prompt-not-captured' });
			expect(records[0]).toMatchObject({ cwd: '/work/project' });
		});
	});

	// ========================================================================
	// Turns that never report their end
	// ========================================================================

	describe('a turn whose end is never reported', () => {
		it('closes at once a turn whose process could not be started', async () => {
			const assembler = makeAssembler({ isProcessRunning: () => false });
			assembler.handleSpawn(spawnConfig());
			await assembler.whenIdle();

			const [records] = await readTurns();
			expect(kindsOf(records)).toEqual(['turn-start', 'turn-end']);
			expect(ofKind(records, 'turn-end')[0]).toMatchObject({
				exitCode: null,
				durationMs: 0,
				recordCount: 2,
			});
			expect(following).toEqual([true, false]);
			await expect(verifyAgentChain(folder, chainIn(folder).head)).resolves.toMatchObject({
				ok: true,
			});
		});

		it('closes the old turn when a new process takes its id, and records the new one', async () => {
			const assembler = makeAssembler();
			const events = claudeEvents();

			assembler.handleSpawn(spawnConfig());
			for (const event of events.slice(0, 3)) assembler.handleParsedEvent(PROCESS, event);
			await assembler.whenIdle();

			clock += 30_000;
			await runTurn(assembler, claudeEvents());

			const turns = await readTurns();
			expect(turns).toHaveLength(2);
			expect(kindsOf(turns[0])).toEqual([
				'turn-start',
				'thinking',
				'text',
				'tool-call',
				'turn-end',
			]);
			expect(ofKind(turns[0], 'turn-end')[0]).toMatchObject({
				exitCode: null,
				durationMs: 30_000,
				recordCount: 5,
			});
			expect(kindsOf(turns[1])).toEqual(CLAUDE_KINDS);
			expect(ofKind(turns[1], 'turn-end')[0].exitCode).toBe(0);
			// The old turn is let go before the new one is taken up.
			expect(following).toEqual([true, false, true, false]);
			await expect(verifyAgentChain(folder, chainIn(folder).head)).resolves.toMatchObject({
				ok: true,
				filesChecked: 2,
			});
		});

		it('closes the old turn even when the new process is not recorded', async () => {
			const assembler = makeAssembler();
			assembler.handleSpawn(spawnConfig());
			assembler.handleParsedEvent(PROCESS, claudeEvents()[0]);
			enabled.clear();
			assembler.handleSpawn(spawnConfig());
			assembler.handleParsedEvent(PROCESS, piece('not recorded'));
			assembler.handleExit(PROCESS, 0);
			await assembler.whenIdle();

			const turns = await readTurns();
			expect(turns).toHaveLength(1);
			expect(kindsOf(turns[0])).toEqual(['turn-start', 'thinking', 'turn-end']);
			expect(following).toEqual([true, false]);
		});

		it('closes an old turn that was still being looked up when its id was taken', async () => {
			const first = deferred<CotTarget | null>();
			let lookups = 0;
			const assembler = makeAssembler({
				resolveTarget: (id) => (lookups++ === 0 ? first.promise : Promise.resolve(targetOf(id))),
			});

			assembler.handleSpawn(spawnConfig({ prompt: 'First.' }));
			assembler.handleParsedEvent(PROCESS, claudeEvents()[0]);
			clock += 1000;
			assembler.handleSpawn(spawnConfig({ prompt: 'Second.' }));
			assembler.handleParsedEvent(PROCESS, claudeEvents()[1]);
			assembler.handleExit(PROCESS, 0);
			first.resolve(targetOf(PROCESS));
			await assembler.whenIdle();

			const turns = await readTurns();
			const byPrompt = new Map(
				turns.map((records) => [ofKind(records, 'turn-start')[0].prompt, records])
			);
			expect(kindsOf(byPrompt.get('First.')!)).toEqual(['turn-start', 'thinking', 'turn-end']);
			expect(ofKind(byPrompt.get('First.')!, 'turn-end')[0].exitCode).toBeNull();
			expect(kindsOf(byPrompt.get('Second.')!)).toEqual(['turn-start', 'text', 'turn-end']);
			expect(ofKind(byPrompt.get('Second.')!, 'turn-end')[0].exitCode).toBe(0);
			expect(following).toEqual([true, false]);
		});
	});

	// ========================================================================
	// Following
	// ========================================================================

	describe('telling the listener when there is a turn to follow', () => {
		it('says true at the first recorded turn and false when the last one ends', async () => {
			const assembler = makeAssembler();
			const first = spawnConfig({ sessionId: `${AGENT}-ai-tab-one` });
			const second = spawnConfig({ sessionId: `${AGENT}-ai-tab-two` });

			assembler.handleSpawn(first);
			expect(following).toEqual([true]);
			assembler.handleSpawn(second);
			await assembler.whenIdle();
			assembler.handleExit(first.sessionId, 0);
			expect(following).toEqual([true]);
			assembler.handleExit(second.sessionId, 0);
			expect(following).toEqual([true, false]);
			await assembler.whenIdle();
		});

		it('is already following when the spawn call returns, before the first line can arrive', () => {
			const assembler = makeAssembler({ resolveTarget: () => new Promise(() => {}) });
			assembler.handleSpawn(spawnConfig());

			expect(following).toEqual([true]);
		});
	});

	// ========================================================================
	// Failures
	// ========================================================================

	describe('when something fails', () => {
		it('never throws into its caller, whatever its dependencies do', async () => {
			const boom = (): never => {
				throw new Error('boom');
			};
			const assembler = makeAssembler({
				peekAgentId: boom,
				onError: boom,
				onFollowingChange: boom,
			});

			expect(() => assembler.handleSpawn(spawnConfig())).not.toThrow();
			expect(() => assembler.handleParsedEvent(PROCESS, piece('a'))).not.toThrow();
			expect(() => assembler.handleExit(PROCESS, 0)).not.toThrow();
			await expect(assembler.whenIdle()).resolves.toBeUndefined();
		});

		it('reports a failure that came before the agent was known with no agent', async () => {
			const assembler = makeAssembler({
				peekAgentId: () => {
					throw new Error('agents unreadable');
				},
			});
			assembler.handleSpawn(spawnConfig());
			await assembler.whenIdle();

			expect(errors).toEqual([{ agentId: null, message: 'agents unreadable' }]);
			expect(await readTurns()).toEqual([]);
		});

		it('files a failure of the on/off check under the agent, and records nothing', async () => {
			const assembler = makeAssembler({
				isEnabled: () => {
					throw new Error('store unreadable');
				},
			});
			await runTurn(assembler, claudeEvents());

			expect(errors).toEqual([{ agentId: AGENT, message: 'store unreadable' }]);
			expect(await readTurns()).toEqual([]);
			expect(following).toEqual([]);
		});

		it('still closes the turn when a record could not be handed to the writer', async () => {
			let calls = 0;
			const kinds: string[] = [];
			const assembler = makeAssembler({
				writer: {
					// Not `async`: the second record is refused with a throw, before
					// the writer has taken it.
					append: (_agentId, _file, draft) => {
						if (++calls === 2) throw new Error('refused');
						kinds.push(draft.kind);
						return Promise.resolve(null);
					},
				},
			});
			await runTurn(assembler, claudeEvents().slice(0, 2));

			expect(kinds).toEqual(['turn-start', 'text', 'turn-end']);
			expect(errors).toEqual([{ agentId: AGENT, message: 'refused' }]);
			expect(following).toEqual([true, false]);
		});

		it('still records a turn when the check for a running process fails', async () => {
			const assembler = makeAssembler({
				isProcessRunning: () => {
					throw new Error('no process table');
				},
			});
			await runTurn(assembler, claudeEvents());

			const [records] = await readTurns();
			expect(kindsOf(records)).toEqual(CLAUDE_KINDS);
			expect(errors).toEqual([{ agentId: AGENT, message: 'no process table' }]);
		});

		it('leaves a write that failed to the writer, which marks the hole in the chain', async () => {
			const assembler = makeAssembler();
			const events = claudeEvents();
			assembler.handleSpawn(spawnConfig());
			assembler.handleParsedEvent(PROCESS, events[0]);
			await assembler.whenIdle();

			// The disk refuses one write, then works again. The reply text that
			// arrives next ends the reasoning block, so the reasoning is what is
			// written, and lost.
			const appendFile = vi
				.spyOn(fs.promises, 'appendFile')
				.mockRejectedValueOnce(
					Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
				);
			assembler.handleParsedEvent(PROCESS, events[1]);
			await assembler.whenIdle();
			appendFile.mockRestore();
			assembler.handleParsedEvent(PROCESS, events[2]);
			assembler.handleExit(PROCESS, 0);
			await assembler.whenIdle();

			const [records] = await readTurns();
			expect(kindsOf(records)).toEqual([
				'turn-start',
				'capture-gap',
				'text',
				'tool-call',
				'turn-end',
			]);
			expect(records[1]).toMatchObject({ reason: 'write-failed:ENOSPC', droppedRecords: 1 });
			// The count is what the turn produced: the lost reasoning is in it, and
			// the gap is not. The file holds one record fewer, and the gap says why.
			expect(ofKind(records, 'turn-end')[0].recordCount).toBe(5);
			await expect(verifyAgentChain(folder, chainIn(folder).head)).resolves.toMatchObject({
				ok: true,
			});
		});
	});
});
