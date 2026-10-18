/**
 * Tests for main/cot-export/writer.ts.
 *
 * The writer decides where a record lands in the chain, so these tests pin
 * the three things a reader of the log relies on: positions have no holes, a
 * lost record always leaves a `capture-gap`, and a head that was not saved
 * before a hard stop is found again and not reported as tampering.
 *
 * Every test writes to its own fresh directory under the OS temp dir and
 * builds paths with `path.join`. None of them reads or writes the user's
 * real data.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recomputeHash } from '../../../main/cot-export/hash-chain';
import { turnFilePath } from '../../../main/cot-export/layout';
import { createCotWriter, recoverHead } from '../../../main/cot-export/writer';
import type { CotRecordDraft, CotWriter } from '../../../main/cot-export/writer';
import {
	COT_EXPORT_FORMAT_VERSION,
	COT_GENESIS_CHAIN_SEQ,
	COT_GENESIS_HASH,
} from '../../../shared/cotExport/types';
import type { CotChainState, CotRecord } from '../../../shared/cotExport/types';

const AGENT = 'agent-1';
const OTHER_AGENT = 'agent-2';
/** What the injected clock reads. */
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const NOW_ISO = '2026-10-10T12:00:00.000Z';
/** When the test turns start, on the local clock. */
const START = new Date(2026, 9, 10, 9, 0, 0);
const LATER_START = new Date(2026, 9, 10, 10, 0, 0);
const TS = '2026-10-10T09:00:01.000Z';
/** A well-formed hash that no record in these tests has. */
const FOREIGN_HASH = 'f'.repeat(64);

function turnStart(turnId: string): CotRecordDraft {
	return {
		turnId,
		ts: TS,
		kind: 'turn-start',
		toolType: 'claude-code',
		origin: 'interactive',
		tabId: 'tab-1',
		cwd: '/work/project',
		prompt: 'List the files.',
		imageCount: 0,
	};
}

function text(turnId: string, body: string): CotRecordDraft {
	return { turnId, ts: TS, kind: 'text', text: body };
}

function turnEnd(turnId: string, recordCount: number): CotRecordDraft {
	return { turnId, ts: TS, kind: 'turn-end', exitCode: 0, durationMs: 1500, recordCount };
}

function emptyChain(folder: string): CotChainState {
	return { folder, head: COT_GENESIS_HASH, chainSeq: COT_GENESIS_CHAIN_SEQ };
}

function diskFull(): Error {
	return Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
}

function errorCode(error: Error): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}

/** The lines of a turn file, blank ones left out. */
function readLines(file: string): string[] {
	return fs
		.readFileSync(file, 'utf8')
		.split('\n')
		.filter((line) => line !== '');
}

/** The records of a turn file, in file order. */
function readRecords(file: string): CotRecord[] {
	return readLines(file).map((line) => JSON.parse(line) as CotRecord);
}

/** Asserts that `records` continue the chain from `after`, one by one, each intact. */
function expectChain(
	records: CotRecord[],
	after: Pick<CotChainState, 'head' | 'chainSeq'> = emptyChain('')
): void {
	let { head, chainSeq } = after;
	for (const record of records) {
		expect(record.chainSeq).toBe(chainSeq + 1);
		expect(record.prevHash).toBe(head);
		expect(recomputeHash(record)).toBe(record.hash);
		head = record.hash;
		chainSeq = record.chainSeq;
	}
}

interface Harness {
	writer: CotWriter;
	/** What the store holds: tests change it to move an agent to another folder. */
	chains: Record<string, CotChainState | null>;
	/** Every `onHeadAdvanced` call, in order. */
	heads: Array<{ agentId: string; state: CotChainState }>;
	/** Every `onError` call, in order. */
	errors: Array<{ agentId: string; error: Error }>;
}

function createHarness(chains: Record<string, CotChainState | null>): Harness {
	const heads: Harness['heads'] = [];
	const errors: Harness['errors'] = [];
	const writer = createCotWriter({
		getChainState: (agentId) => chains[agentId] ?? null,
		onHeadAdvanced: (agentId, state) => {
			heads.push({ agentId, state });
		},
		onError: (agentId, error) => {
			errors.push({ agentId, error });
		},
		now: () => NOW,
	});
	return { writer, chains, heads, errors };
}

describe('cot-export writer', () => {
	let folder: string;
	let otherFolder: string;
	let file: string;

	beforeEach(() => {
		folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cot-writer-')));
		otherFolder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cot-writer-')));
		file = turnFilePath(folder, START, 'tab-1', 'turn-1');
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(folder, { recursive: true, force: true });
		fs.rmSync(otherFolder, { recursive: true, force: true });
	});

	/**
	 * Writes one record per draft to `target` with a writer of its own, and
	 * returns the records and the chain state after each of them.
	 */
	async function writeRecords(
		chain: CotChainState,
		target: string,
		drafts: CotRecordDraft[]
	): Promise<{ records: CotRecord[]; states: CotChainState[] }> {
		const harness = createHarness({ [AGENT]: chain });
		const records: CotRecord[] = [];
		for (const draft of drafts) {
			const record = await harness.writer.append(AGENT, target, draft);
			if (!record) throw new Error('The record did not land.');
			records.push(record);
		}
		return { records, states: harness.heads.map((entry) => entry.state) };
	}

	describe('append', () => {
		it('seals the first record against the genesis hash and writes it as one line', async () => {
			const { writer, heads, errors } = createHarness({ [AGENT]: emptyChain(folder) });

			const record = await writer.append(AGENT, file, turnStart('turn-1'));

			expect(record).toMatchObject({
				v: COT_EXPORT_FORMAT_VERSION,
				kind: 'turn-start',
				agentId: AGENT,
				turnId: 'turn-1',
				seq: 0,
				chainSeq: 0,
				ts: TS,
				prompt: 'List the files.',
				prevHash: COT_GENESIS_HASH,
			});
			expect(fs.readFileSync(file, 'utf8')).toBe(`${JSON.stringify(record)}\n`);
			expect(readRecords(file)).toEqual([record]);
			expectChain(readRecords(file));
			expect(heads).toEqual([
				{ agentId: AGENT, state: { folder, head: record?.hash, chainSeq: 0 } },
			]);
			expect(errors).toEqual([]);
		});

		it('writes the fields in the order the format lists them', async () => {
			const { writer } = createHarness({ [AGENT]: emptyChain(folder) });
			await writer.append(AGENT, file, text('turn-1', 'hello'));
			expect(Object.keys(JSON.parse(readLines(file)[0]))).toEqual([
				'v',
				'kind',
				'agentId',
				'turnId',
				'seq',
				'chainSeq',
				'ts',
				'text',
				'prevHash',
				'hash',
			]);
		});

		it('counts seq within a turn and chainSeq across turns', async () => {
			const { writer } = createHarness({ [AGENT]: emptyChain(folder) });
			const secondFile = turnFilePath(folder, LATER_START, 'tab-1', 'turn-2');

			await writer.append(AGENT, file, turnStart('turn-1'));
			await writer.append(AGENT, file, text('turn-1', 'one'));
			await writer.append(AGENT, file, turnEnd('turn-1', 3));
			await writer.append(AGENT, secondFile, turnStart('turn-2'));
			await writer.append(AGENT, secondFile, turnEnd('turn-2', 2));

			const first = readRecords(file);
			const second = readRecords(secondFile);
			expect(first.map((record) => record.seq)).toEqual([0, 1, 2]);
			expect(second.map((record) => record.seq)).toEqual([0, 1]);
			expect([...first, ...second].map((record) => record.chainSeq)).toEqual([0, 1, 2, 3, 4]);
			expectChain([...first, ...second]);
		});

		it('lets the writer, not the draft, set the agent and the positions', async () => {
			const { writer } = createHarness({ [AGENT]: emptyChain(folder) });
			// A draft built from a whole record carries fields that are not its to set.
			const stray = {
				...text('turn-1', 'hello'),
				v: 99,
				agentId: 'someone-else',
				seq: 41,
				chainSeq: 42,
				prevHash: FOREIGN_HASH,
				hash: FOREIGN_HASH,
			} as unknown as CotRecordDraft;

			const record = await writer.append(AGENT, file, stray);

			expect(record).toMatchObject({
				v: COT_EXPORT_FORMAT_VERSION,
				agentId: AGENT,
				seq: 0,
				chainSeq: 0,
				prevHash: COT_GENESIS_HASH,
			});
			expectChain(readRecords(file));
		});

		it('gives two concurrent turns of one agent a contiguous chainSeq', async () => {
			const { writer } = createHarness({ [AGENT]: emptyChain(folder) });
			const fileA = turnFilePath(folder, START, 'tab-a', 'turn-a');
			const fileB = turnFilePath(folder, START, 'tab-b', 'turn-b');

			// Nothing is awaited between the calls: both tabs write at once.
			const pending = [
				writer.append(AGENT, fileA, turnStart('turn-a')),
				writer.append(AGENT, fileB, turnStart('turn-b')),
			];
			for (let i = 0; i < 10; i++) {
				pending.push(writer.append(AGENT, fileA, text('turn-a', `a${i}`)));
				pending.push(writer.append(AGENT, fileB, text('turn-b', `b${i}`)));
			}
			pending.push(writer.append(AGENT, fileA, turnEnd('turn-a', 12)));
			pending.push(writer.append(AGENT, fileB, turnEnd('turn-b', 12)));
			const written = await Promise.all(pending);

			const positions = Array.from({ length: 24 }, (_, index) => index);
			// Records land in the order they were handed over.
			expect(written.map((record) => record?.chainSeq)).toEqual(positions);
			const all = [...readRecords(fileA), ...readRecords(fileB)].sort(
				(a, b) => a.chainSeq - b.chainSeq
			);
			expect(all.map((record) => record.chainSeq)).toEqual(positions);
			expectChain(all);
			const perTurn = Array.from({ length: 12 }, (_, index) => index);
			expect(readRecords(fileA).map((record) => record.seq)).toEqual(perTurn);
			expect(readRecords(fileB).map((record) => record.seq)).toEqual(perTurn);
		});

		it('does not make one agent wait for another', async () => {
			const { writer } = createHarness({
				[AGENT]: emptyChain(folder),
				[OTHER_AGENT]: emptyChain(otherFolder),
			});
			const otherFile = turnFilePath(otherFolder, START, 'tab-1', 'turn-2');
			const realAppend = fs.promises.appendFile;
			let release: () => void = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const appendSpy = vi.spyOn(fs.promises, 'appendFile').mockImplementation(async (...args) => {
				if (String(args[0]).startsWith(folder + path.sep)) await gate;
				return realAppend(...args);
			});

			const held = writer.append(AGENT, file, turnStart('turn-1'));
			await vi.waitFor(() => expect(appendSpy).toHaveBeenCalled());
			const free = await writer.append(OTHER_AGENT, otherFile, turnStart('turn-2'));

			expect(free).toMatchObject({ agentId: OTHER_AGENT, chainSeq: 0 });
			expect(fs.existsSync(file)).toBe(false);
			release();
			expect(await held).toMatchObject({ agentId: AGENT, chainSeq: 0 });
		});

		it('moves the head only after the line is on disk', async () => {
			const { writer, heads } = createHarness({ [AGENT]: emptyChain(folder) });
			const realAppend = fs.promises.appendFile;
			let release: () => void = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const appendSpy = vi.spyOn(fs.promises, 'appendFile').mockImplementation(async (...args) => {
				await gate;
				return realAppend(...args);
			});

			const pending = writer.append(AGENT, file, turnStart('turn-1'));
			await vi.waitFor(() => expect(appendSpy).toHaveBeenCalled());
			expect(heads).toEqual([]);

			release();
			const record = await pending;
			expect(heads).toEqual([
				{ agentId: AGENT, state: { folder, head: record?.hash, chainSeq: 0 } },
			]);
		});

		it.skipIf(process.platform === 'win32')(
			'creates the file readable and writable by its owner only',
			async () => {
				const { writer } = createHarness({ [AGENT]: emptyChain(folder) });
				await writer.append(AGENT, file, turnStart('turn-1'));
				expect(fs.statSync(file).mode & 0o777).toBe(0o600);
			}
		);

		it('keeps a running turn in its old chain after the agent moves to another folder', async () => {
			const { writer, chains, heads } = createHarness({ [AGENT]: emptyChain(folder) });
			const newFile = turnFilePath(otherFolder, LATER_START, 'tab-1', 'turn-new');

			await writer.append(AGENT, file, turnStart('turn-1'));
			// The person picks another folder while the turn is still running.
			chains[AGENT] = emptyChain(otherFolder);
			const stillOld = await writer.append(AGENT, file, text('turn-1', 'more'));
			const firstNew = await writer.append(AGENT, newFile, turnStart('turn-new'));
			const lastOld = await writer.append(AGENT, file, turnEnd('turn-1', 3));

			expect(stillOld).toMatchObject({ seq: 1, chainSeq: 1 });
			expect(lastOld).toMatchObject({ seq: 2, chainSeq: 2 });
			expect(firstNew).toMatchObject({ seq: 0, chainSeq: 0, prevHash: COT_GENESIS_HASH });
			expectChain(readRecords(file));
			expectChain(readRecords(newFile));
			// Each head names the folder of the chain it belongs to.
			expect(heads.map((entry) => entry.state.folder)).toEqual([
				folder,
				folder,
				otherFolder,
				folder,
			]);
		});

		it('refuses a record for an agent that has no chain', async () => {
			const { writer, heads, errors } = createHarness({ [AGENT]: null });

			expect(await writer.append(AGENT, file, turnStart('turn-1'))).toBeNull();

			expect(errors.map((entry) => entry.agentId)).toEqual([AGENT]);
			expect(heads).toEqual([]);
			expect(fs.readdirSync(folder)).toEqual([]);
		});

		it('refuses a file that lies outside the folder of the chain', async () => {
			const { writer, heads, errors } = createHarness({ [AGENT]: emptyChain(folder) });
			const outside = turnFilePath(otherFolder, START, 'tab-1', 'turn-1');

			expect(await writer.append(AGENT, outside, turnStart('turn-1'))).toBeNull();

			expect(errors).toHaveLength(1);
			expect(heads).toEqual([]);
			expect(fs.readdirSync(otherFolder)).toEqual([]);
		});

		it('still lands the record when the head callback throws', async () => {
			const errors: Error[] = [];
			let calls = 0;
			const writer = createCotWriter({
				getChainState: () => emptyChain(folder),
				onHeadAdvanced: () => {
					calls += 1;
					if (calls === 1) throw new Error('the store could not save');
				},
				onError: (_agentId, error) => {
					errors.push(error);
				},
				now: () => NOW,
			});

			const first = await writer.append(AGENT, file, turnStart('turn-1'));
			const second = await writer.append(AGENT, file, text('turn-1', 'next'));

			expect(first).not.toBeNull();
			expect(errors.map((error) => error.message)).toEqual(['the store could not save']);
			// The head moved in memory all the same, and no record counts as lost.
			expect(second?.prevHash).toBe(first?.hash);
			expect(readRecords(file).map((record) => record.kind)).toEqual(['turn-start', 'text']);
		});

		it('never rejects, even when the error callback throws', async () => {
			const writer = createCotWriter({
				getChainState: () => null,
				onHeadAdvanced: () => {},
				onError: () => {
					throw new Error('nowhere to report');
				},
				now: () => NOW,
			});
			await expect(writer.append(AGENT, file, turnStart('turn-1'))).resolves.toBeNull();
			await expect(writer.recover(AGENT, folder)).resolves.toBeUndefined();
		});
	});

	describe('a write that fails', () => {
		it('writes one capture-gap, with the count, ahead of the next record that lands', async () => {
			const { writer, heads, errors } = createHarness({ [AGENT]: emptyChain(folder) });
			const first = await writer.append(AGENT, file, turnStart('turn-1'));

			vi.spyOn(fs.promises, 'appendFile')
				.mockRejectedValueOnce(diskFull())
				.mockRejectedValueOnce(diskFull());
			expect(await writer.append(AGENT, file, text('turn-1', 'lost one'))).toBeNull();
			expect(await writer.append(AGENT, file, text('turn-1', 'lost two'))).toBeNull();

			// Nothing moved: not the head, not the file.
			expect(heads).toHaveLength(1);
			expect(readRecords(file)).toEqual([first]);
			expect(errors.map((entry) => entry.agentId)).toEqual([AGENT, AGENT]);
			expect(errors.map((entry) => errorCode(entry.error))).toEqual(['ENOSPC', 'ENOSPC']);

			const landed = await writer.append(AGENT, file, text('turn-1', 'kept'));

			const records = readRecords(file);
			expect(records.map((record) => record.kind)).toEqual(['turn-start', 'capture-gap', 'text']);
			expect(records[1]).toMatchObject({
				v: COT_EXPORT_FORMAT_VERSION,
				kind: 'capture-gap',
				agentId: AGENT,
				turnId: 'turn-1',
				seq: 1,
				chainSeq: 1,
				ts: NOW_ISO,
				reason: 'write-failed:ENOSPC',
				droppedRecords: 2,
				prevHash: first?.hash,
			});
			expect(records[2]).toEqual(landed);
			expect(landed).toMatchObject({ seq: 2, chainSeq: 2, text: 'kept' });
			expectChain(records);
			// The gap and the record land together, so the head is reported once.
			expect(heads).toHaveLength(2);
			expect(heads[1].state).toEqual({ folder, head: landed?.hash, chainSeq: 2 });

			// The gap is written once.
			await writer.append(AGENT, file, text('turn-1', 'after'));
			expect(readRecords(file).map((record) => record.kind)).toEqual([
				'turn-start',
				'capture-gap',
				'text',
				'text',
			]);
			expectChain(readRecords(file));
		});

		it('names the code of the system error when the folder cannot be created', async () => {
			const { writer, errors } = createHarness({ [AGENT]: emptyChain(folder) });
			// A file where the year folder has to go.
			const blocker = path.join(folder, String(START.getFullYear()));
			fs.writeFileSync(blocker, '');

			expect(await writer.append(AGENT, file, turnStart('turn-1'))).toBeNull();
			const code = errorCode(errors[0].error);
			expect(code).toEqual(expect.any(String));

			fs.rmSync(blocker);
			await writer.append(AGENT, file, turnStart('turn-1'));

			// The gap sits ahead of the turn-start, so seq 0 is not the turn-start.
			const records = readRecords(file);
			expect(records[0]).toMatchObject({
				kind: 'capture-gap',
				seq: 0,
				chainSeq: 0,
				prevHash: COT_GENESIS_HASH,
				reason: `write-failed:${code}`,
				droppedRecords: 1,
			});
			expect(records[1]).toMatchObject({ kind: 'turn-start', seq: 1, chainSeq: 1 });
			expectChain(records);
		});

		it('carries the gap into the next turn when a turn ends on a failed write', async () => {
			const { writer } = createHarness({ [AGENT]: emptyChain(folder) });
			const secondFile = turnFilePath(folder, LATER_START, 'tab-1', 'turn-2');
			await writer.append(AGENT, file, turnStart('turn-1'));

			vi.spyOn(fs.promises, 'appendFile').mockRejectedValueOnce(diskFull());
			expect(await writer.append(AGENT, file, turnEnd('turn-1', 2))).toBeNull();
			await writer.append(AGENT, secondFile, turnStart('turn-2'));

			expect(readRecords(file).map((record) => record.kind)).toEqual(['turn-start']);
			const second = readRecords(secondFile);
			expect(second[0]).toMatchObject({
				kind: 'capture-gap',
				turnId: 'turn-2',
				seq: 0,
				chainSeq: 1,
				droppedRecords: 1,
			});
			expect(second[1]).toMatchObject({ kind: 'turn-start', turnId: 'turn-2', seq: 1 });
			expectChain([...readRecords(file), ...second]);
		});

		it('starts on a new line after a write that was cut short', async () => {
			const { writer } = createHarness({ [AGENT]: emptyChain(folder) });
			const first = await writer.append(AGENT, file, turnStart('turn-1'));

			// The disk fills up part of the way through the line.
			vi.spyOn(fs.promises, 'appendFile').mockImplementationOnce(async (target, data) => {
				fs.appendFileSync(String(target), String(data).slice(0, 40));
				throw diskFull();
			});
			expect(await writer.append(AGENT, file, text('turn-1', 'cut short'))).toBeNull();
			const landed = await writer.append(AGENT, file, text('turn-1', 'kept'));

			const lines = readLines(file);
			expect(lines).toHaveLength(4);
			expect(JSON.parse(lines[0])).toEqual(first);
			// The piece of the lost line stays alone on its line.
			expect(() => JSON.parse(lines[1])).toThrow();
			expect(JSON.parse(lines[2])).toMatchObject({
				kind: 'capture-gap',
				reason: 'write-failed:ENOSPC',
				droppedRecords: 1,
				prevHash: first?.hash,
			});
			expect(JSON.parse(lines[3])).toEqual(landed);
		});

		it('counts a record that cannot be sealed as lost, and never writes it', async () => {
			const { writer, errors } = createHarness({ [AGENT]: emptyChain(folder) });
			await writer.append(AGENT, file, turnStart('turn-1'));
			const unsealable: CotRecordDraft = {
				turnId: 'turn-1',
				ts: TS,
				kind: 'usage',
				usage: {
					inputTokens: 10,
					outputTokens: 20,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: Number.NaN,
					contextWindow: 200000,
				},
			};

			expect(await writer.append(AGENT, file, unsealable)).toBeNull();
			expect(errors).toHaveLength(1);
			expect(readRecords(file)).toHaveLength(1);

			await writer.append(AGENT, file, text('turn-1', 'kept'));

			const records = readRecords(file);
			expect(records[1]).toMatchObject({
				kind: 'capture-gap',
				reason: 'write-failed:unserializable',
				droppedRecords: 1,
			});
			expectChain(records);
			// Nothing reached the file for the lost record, so no line was left to close.
			expect(fs.readFileSync(file, 'utf8').split('\n')).toHaveLength(4);
		});
	});

	describe('recoverHead', () => {
		const drafts = [turnStart('turn-1'), text('turn-1', 'one'), text('turn-1', 'two')];

		it('reports an unchanged head when the newest record on disk is the stored one', async () => {
			const { states } = await writeRecords(emptyChain(folder), file, drafts);
			expect(await recoverHead(folder, states[2])).toEqual({
				outcome: 'unchanged',
				state: states[2],
			});
		});

		it('adopts a record that landed before the head was saved', async () => {
			const { states } = await writeRecords(emptyChain(folder), file, drafts);
			expect(await recoverHead(folder, states[1])).toEqual({
				outcome: 'adopted',
				state: states[2],
			});
		});

		it('adopts several unsaved records when each links from the one before', async () => {
			const { states } = await writeRecords(emptyChain(folder), file, drafts);
			expect(await recoverHead(folder, states[0])).toEqual({
				outcome: 'adopted',
				state: states[2],
			});
			// Nothing was saved at all: the whole chain is found from the genesis hash.
			expect(await recoverHead(folder, emptyChain(folder))).toEqual({
				outcome: 'adopted',
				state: states[2],
			});
		});

		it('adopts unsaved records that lie in more than one file', async () => {
			const first = await writeRecords(emptyChain(folder), file, [
				turnStart('turn-1'),
				turnEnd('turn-1', 2),
			]);
			const secondFile = turnFilePath(folder, LATER_START, 'tab-1', 'turn-2');
			const second = await writeRecords(first.states[1], secondFile, [
				turnStart('turn-2'),
				text('turn-2', 'one'),
			]);
			// Saved after the first turn-start. The turn-end and the next turn were not.
			expect(await recoverHead(folder, first.states[0])).toEqual({
				outcome: 'adopted',
				state: second.states[1],
			});
		});

		it('reads a record that is larger than one read from the end of the file', async () => {
			const long = 'x'.repeat(200_000);
			const { states } = await writeRecords(emptyChain(folder), file, [
				turnStart('turn-1'),
				text('turn-1', long),
				text('turn-1', 'after'),
			]);
			expect(await recoverHead(folder, states[0])).toEqual({
				outcome: 'adopted',
				state: states[2],
			});
			expect(await recoverHead(folder, states[1])).toEqual({
				outcome: 'adopted',
				state: states[2],
			});
		});

		it('passes over a line that a hard stop cut short', async () => {
			const { states } = await writeRecords(emptyChain(folder), file, drafts);
			fs.appendFileSync(file, '{"v":1,"kind":"text","agentId":"agent-1","turnI');
			expect(await recoverHead(folder, states[1])).toEqual({
				outcome: 'adopted',
				state: states[2],
			});
			expect(await recoverHead(folder, states[2])).toEqual({
				outcome: 'unchanged',
				state: states[2],
			});
		});

		it('flags a stored head that is not the record on disk', async () => {
			const { states } = await writeRecords(emptyChain(folder), file, drafts);
			const stored = { ...states[2], head: FOREIGN_HASH };
			expect(await recoverHead(folder, stored)).toEqual({ outcome: 'mismatch', state: stored });
		});

		it('flags a log whose newest records were removed', async () => {
			const first = await writeRecords(emptyChain(folder), file, [
				turnStart('turn-1'),
				turnEnd('turn-1', 2),
			]);
			const secondFile = turnFilePath(folder, LATER_START, 'tab-1', 'turn-2');
			const second = await writeRecords(first.states[1], secondFile, [turnStart('turn-2')]);
			fs.rmSync(secondFile);
			expect(await recoverHead(folder, second.states[0])).toEqual({
				outcome: 'mismatch',
				state: second.states[0],
			});
		});

		it('flags an unsaved record that was edited', async () => {
			const { states } = await writeRecords(emptyChain(folder), file, drafts);
			fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"two"', '"2wo"'));
			expect(await recoverHead(folder, states[0])).toEqual({
				outcome: 'mismatch',
				state: states[0],
			});
		});

		it('flags unsaved records with one missing from the middle', async () => {
			const { states } = await writeRecords(emptyChain(folder), file, drafts);
			const lines = readLines(file);
			fs.writeFileSync(file, `${lines[0]}\n${lines[2]}\n`);
			expect(await recoverHead(folder, states[0])).toEqual({
				outcome: 'mismatch',
				state: states[0],
			});
		});

		it('treats an empty or missing folder as an empty chain', async () => {
			const empty = emptyChain(folder);
			expect(await recoverHead(folder, empty)).toEqual({ outcome: 'unchanged', state: empty });
			const missing = emptyChain(path.join(folder, 'not-created-yet'));
			expect(await recoverHead(missing.folder, missing)).toEqual({
				outcome: 'unchanged',
				state: missing,
			});
		});

		it('flags a chain with records when its folder is empty', async () => {
			const stored: CotChainState = { folder, head: FOREIGN_HASH, chainSeq: 7 };
			expect(await recoverHead(folder, stored)).toEqual({ outcome: 'mismatch', state: stored });
		});
	});

	describe('recovery at the first use of a chain', () => {
		const drafts = [turnStart('turn-1'), text('turn-1', 'one'), text('turn-1', 'two')];
		let nextFile: string;

		beforeEach(() => {
			nextFile = turnFilePath(folder, LATER_START, 'tab-1', 'turn-2');
		});

		it('adopts a forward tail before its first write', async () => {
			const { records, states } = await writeRecords(emptyChain(folder), file, drafts);
			// The app stopped hard: the store still holds the head after the first record.
			const { writer, heads, errors } = createHarness({ [AGENT]: states[0] });

			const record = await writer.append(AGENT, nextFile, turnStart('turn-2'));

			expect(record).toMatchObject({ seq: 0, chainSeq: 3, prevHash: records[2].hash });
			expect(readRecords(nextFile).map((entry) => entry.kind)).toEqual(['turn-start']);
			expectChain([...readRecords(file), ...readRecords(nextFile)]);
			expect(heads.map((entry) => entry.state)).toEqual([
				states[2],
				{ folder, head: record?.hash, chainSeq: 3 },
			]);
			expect(errors).toEqual([]);
		});

		it('keeps a contradicted head and writes a gap ahead of the next record', async () => {
			await writeRecords(emptyChain(folder), file, drafts);
			const stored: CotChainState = { folder, head: FOREIGN_HASH, chainSeq: 2 };
			const { writer, errors } = createHarness({ [AGENT]: stored });

			await writer.append(AGENT, nextFile, turnStart('turn-2'));
			await writer.append(AGENT, nextFile, text('turn-2', 'next'));

			const records = readRecords(nextFile);
			expect(records.map((record) => record.kind)).toEqual(['capture-gap', 'turn-start', 'text']);
			expect(records[0]).toMatchObject({
				agentId: AGENT,
				turnId: 'turn-2',
				seq: 0,
				chainSeq: 3,
				ts: NOW_ISO,
				reason: 'head-mismatch-on-start',
				prevHash: FOREIGN_HASH,
			});
			expect(records[0]).not.toHaveProperty('droppedRecords');
			expectChain(records, stored);
			// A contradiction is recorded in the chain. It is not a failed write.
			expect(errors).toEqual([]);
		});

		it('writes the mismatch gap ahead of the gap for a failed write', async () => {
			const stored: CotChainState = { folder, head: FOREIGN_HASH, chainSeq: 7 };
			const { writer } = createHarness({ [AGENT]: stored });

			vi.spyOn(fs.promises, 'appendFile').mockRejectedValueOnce(diskFull());
			expect(await writer.append(AGENT, nextFile, turnStart('turn-2'))).toBeNull();
			await writer.append(AGENT, nextFile, turnStart('turn-2'));

			const records = readRecords(nextFile);
			expect(
				records.map((record) => (record.kind === 'capture-gap' ? record.reason : record.kind))
			).toEqual(['head-mismatch-on-start', 'write-failed:ENOSPC', 'turn-start']);
			expectChain(records, stored);
		});

		it('checks the head again after the folder could not be read', async () => {
			const { records, states } = await writeRecords(emptyChain(folder), file, drafts);
			const { writer, errors } = createHarness({ [AGENT]: states[0] });

			vi.spyOn(fs.promises, 'readdir').mockRejectedValueOnce(
				Object.assign(new Error('EACCES: permission denied, scandir'), { code: 'EACCES' })
			);
			expect(await writer.append(AGENT, nextFile, turnStart('turn-2'))).toBeNull();
			expect(errors.map((entry) => errorCode(entry.error))).toEqual(['EACCES']);

			await writer.append(AGENT, nextFile, turnStart('turn-2'));

			// The forward tail is adopted on the second try, so the chain has no break.
			const next = readRecords(nextFile);
			expect(next[0]).toMatchObject({
				kind: 'capture-gap',
				chainSeq: 3,
				prevHash: records[2].hash,
				reason: 'write-failed:EACCES',
				droppedRecords: 1,
			});
			expectChain([...readRecords(file), ...next]);
		});

		it('goes on from the stored head, and says so, when the folder can never be checked', async () => {
			const { states } = await writeRecords(emptyChain(folder), file, drafts);
			const { writer, errors } = createHarness({ [AGENT]: states[2] });
			const denied = (): Error =>
				Object.assign(new Error('EACCES: permission denied, scandir'), { code: 'EACCES' });
			const readdir = vi.spyOn(fs.promises, 'readdir').mockImplementation(async () => {
				throw denied();
			});

			// Two records are lost while the check is tried again.
			expect(await writer.append(AGENT, nextFile, turnStart('turn-2'))).toBeNull();
			expect(await writer.append(AGENT, nextFile, text('turn-2', 'lost'))).toBeNull();
			// The third failure is the last try: the log must not stop for good.
			const landed = await writer.append(AGENT, nextFile, text('turn-2', 'kept'));
			expect(landed).toMatchObject({ kind: 'text', text: 'kept' });
			expect(errors.map((entry) => errorCode(entry.error))).toEqual(['EACCES', 'EACCES', 'EACCES']);

			const walks = readdir.mock.calls.length;
			await writer.append(AGENT, nextFile, text('turn-2', 'next'));
			// The folder is not walked again for every record after that.
			expect(readdir.mock.calls.length).toBe(walks);

			const records = readRecords(nextFile);
			expect(
				records.map((record) => (record.kind === 'capture-gap' ? record.reason : record.kind))
			).toEqual(['head-unchecked-on-start', 'write-failed:EACCES', 'text', 'text']);
			expect(records[1]).toMatchObject({ droppedRecords: 2 });
			expectChain(records, states[2]);
		});

		it('takes a whole log up again from a chain with no stored head, however many hours it spans', async () => {
			// More hour folders than a check of a stored head reads.
			const HOURS = 30;
			const harness = createHarness({ [AGENT]: emptyChain(folder) });
			for (let hour = 0; hour < HOURS; hour++) {
				const start = new Date(2026, 9, 10 + Math.floor(hour / 24), hour % 24, 0, 0);
				const target = turnFilePath(folder, start, 'tab-1', `turn-${hour}`);
				expect(
					await harness.writer.append(AGENT, target, text(`turn-${hour}`, 'one'))
				).not.toBeNull();
			}
			const newest = harness.heads[harness.heads.length - 1].state;
			expect(newest.chainSeq).toBe(HOURS - 1);

			// The state was lost and the person chose the same folder again.
			expect(await recoverHead(folder, emptyChain(folder))).toEqual({
				outcome: 'adopted',
				state: newest,
			});

			// The next record continues the chain. It does not start a second one.
			const { writer, errors } = createHarness({ [AGENT]: emptyChain(folder) });
			const record = await writer.append(AGENT, nextFile, turnStart('turn-next'));
			expect(record).toMatchObject({ chainSeq: HOURS, prevHash: newest.head });
			expect(readRecords(nextFile).map((entry) => entry.kind)).toEqual(['turn-start']);
			expect(errors).toEqual([]);
		});

		it('recovers on request, once, without writing a record', async () => {
			const { states } = await writeRecords(emptyChain(folder), file, drafts);
			const { writer, heads, errors } = createHarness({ [AGENT]: states[0] });
			const before = fs.readFileSync(file, 'utf8');

			await writer.recover(AGENT, folder);
			await writer.recover(AGENT, folder);

			expect(heads).toEqual([{ agentId: AGENT, state: states[2] }]);
			expect(fs.readFileSync(file, 'utf8')).toBe(before);
			expect(errors).toEqual([]);
		});

		it('has nothing to recover for an agent with no chain', async () => {
			const { writer, heads, errors } = createHarness({ [AGENT]: null });
			await writer.recover(AGENT, folder);
			expect(heads).toEqual([]);
			expect(errors).toEqual([]);
		});
	});

	describe('whileQuiet', () => {
		const drafts = [turnStart('turn-1'), text('turn-1', 'one'), text('turn-1', 'two')];

		it('hands over the head after it was checked against the disk', async () => {
			const { states } = await writeRecords(emptyChain(folder), file, drafts);
			// The stored head is behind the disk, as after a hard stop.
			const { writer, heads, errors } = createHarness({ [AGENT]: states[0] });

			expect(await writer.whileQuiet(AGENT, folder, async (state) => state)).toEqual(states[2]);
			expect(heads).toEqual([{ agentId: AGENT, state: states[2] }]);
			expect(errors).toEqual([]);
		});

		it('holds every write of the agent until the work is done, and loses none', async () => {
			const { states } = await writeRecords(emptyChain(folder), file, drafts);
			const { writer } = createHarness({ [AGENT]: states[2] });
			const before = fs.readFileSync(file, 'utf8');
			let release = (): void => undefined;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});

			const work = writer.whileQuiet(AGENT, folder, async (state) => {
				await held;
				return state;
			});
			const late = writer.append(AGENT, file, text('turn-1', 'three'));
			// Long enough for a write that was not held to land.
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(fs.readFileSync(file, 'utf8')).toBe(before);

			release();
			expect(await work).toEqual(states[2]);
			expect(await late).toMatchObject({ chainSeq: 3, prevHash: states[2].head });
			expectChain(readRecords(file));
		});

		it('hands over null for an agent with no chain in the folder', async () => {
			const { writer, errors } = createHarness({ [AGENT]: null });
			expect(await writer.whileQuiet(AGENT, folder, async (state) => state)).toBeNull();
			expect(errors).toEqual([]);
		});

		it('hands over the head it holds when the folder could not be checked', async () => {
			const { states } = await writeRecords(emptyChain(folder), file, drafts);
			const { writer, errors } = createHarness({ [AGENT]: states[2] });
			vi.spyOn(fs.promises, 'readdir').mockRejectedValueOnce(
				Object.assign(new Error('EACCES: permission denied, scandir'), { code: 'EACCES' })
			);

			expect(await writer.whileQuiet(AGENT, folder, async (state) => state)).toEqual(states[2]);
			expect(errors.map((entry) => errorCode(entry.error))).toEqual(['EACCES']);
		});

		it('rejects when the work does, and the writes behind it still land', async () => {
			const { writer } = createHarness({ [AGENT]: emptyChain(folder) });

			const work = writer.whileQuiet(AGENT, folder, async () => {
				throw new Error('The walk failed.');
			});
			const late = writer.append(AGENT, file, turnStart('turn-1'));

			await expect(work).rejects.toThrow('The walk failed.');
			expect(await late).toMatchObject({ kind: 'turn-start', chainSeq: 0 });
		});
	});
});
