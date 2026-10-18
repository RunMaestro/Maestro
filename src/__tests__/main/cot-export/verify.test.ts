/**
 * Tests for main/cot-export/verify.ts.
 *
 * Every log here is built by the real writer in a temp directory, then
 * damaged the way a person would damage it. The verifier has to name the
 * first thing that no longer adds up, and it has to stay quiet about a log
 * that only carries the leftovers of a failed write.
 *
 * Every test writes to its own fresh directory under the OS temp dir and
 * builds paths with `path.join`. None of them reads or writes the user's
 * real data.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sealRecord } from '../../../main/cot-export/hash-chain';
import { turnFilePath } from '../../../main/cot-export/layout';
import { verifyAgentChain } from '../../../main/cot-export/verify';
import { createCotWriter } from '../../../main/cot-export/writer';
import type { CotRecordDraft } from '../../../main/cot-export/writer';
import { COT_GENESIS_CHAIN_SEQ, COT_GENESIS_HASH } from '../../../shared/cotExport/types';
import type { CotChainState, CotRecord } from '../../../shared/cotExport/types';

const AGENT = 'agent-1';
const TS = '2026-10-10T09:00:01.000Z';
const HOUR_9 = new Date(2026, 9, 10, 9, 0, 0);
const HOUR_10 = new Date(2026, 9, 10, 10, 0, 0);
const HOUR_11 = new Date(2026, 9, 10, 11, 0, 0);

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

function diskFull(): Error {
	return Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
}

/** A writer for one folder whose head the test can read back. */
function createChain(folder: string): {
	writer: ReturnType<typeof createCotWriter>;
	head: () => string;
} {
	let state: CotChainState = {
		folder,
		head: COT_GENESIS_HASH,
		chainSeq: COT_GENESIS_CHAIN_SEQ,
	};
	const writer = createCotWriter({
		getChainState: () => state,
		onHeadAdvanced: (_agentId, next) => {
			state = next;
		},
		onError: () => {},
		now: () => Date.UTC(2026, 9, 10, 12, 0, 0),
	});
	return { writer, head: () => state.head };
}

interface BuiltLog {
	/** Three turn files in three hour folders, oldest first. */
	files: [string, string, string];
	/** The head the writer reached: what the store would hold. */
	head: string;
}

/**
 * Writes a log of nine records in three files: positions 0-3, 4-6 and 7-8.
 * `label` goes into the text so two logs built the same way differ.
 */
async function buildLog(folder: string, label = 'a'): Promise<BuiltLog> {
	const { writer, head } = createChain(folder);
	const files: BuiltLog['files'] = [
		turnFilePath(folder, HOUR_9, 'tab-1', 'turn-1'),
		turnFilePath(folder, HOUR_10, 'tab-1', 'turn-2'),
		turnFilePath(folder, HOUR_11, 'tab-1', 'turn-3'),
	];
	const turns: Array<[string, CotRecordDraft[]]> = [
		[
			files[0],
			[
				turnStart('turn-1'),
				text('turn-1', `${label}-one`),
				text('turn-1', `${label}-two`),
				turnEnd('turn-1', 4),
			],
		],
		[files[1], [turnStart('turn-2'), text('turn-2', `${label}-three`), turnEnd('turn-2', 3)]],
		[files[2], [turnStart('turn-3'), turnEnd('turn-3', 2)]],
	];
	for (const [file, drafts] of turns) {
		for (const draft of drafts) {
			const record = await writer.append(AGENT, file, draft);
			if (!record) throw new Error('The record did not land.');
		}
	}
	return { files, head: head() };
}

function readLines(file: string): string[] {
	return fs.readFileSync(file, 'utf8').split('\n');
}

/** Writes `lines` back as a file. The last entry of `readLines` is the empty text after the final newline, so it restores that newline. */
function writeLines(file: string, lines: string[]): void {
	fs.writeFileSync(file, lines.join('\n'));
}

/** The line index of the record at chain position `chainSeq`, or throws. */
function lineOf(file: string, chainSeq: number): number {
	const index = readLines(file).findIndex((line) => {
		if (line === '') return false;
		return (JSON.parse(line) as CotRecord).chainSeq === chainSeq;
	});
	if (index === -1) throw new Error(`No record ${chainSeq} in ${file}`);
	return index;
}

describe('cot-export verifyAgentChain', () => {
	let folder: string;
	let otherFolder: string;

	beforeEach(() => {
		folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cot-verify-')));
		otherFolder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cot-verify-')));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(folder, { recursive: true, force: true });
		fs.rmSync(otherFolder, { recursive: true, force: true });
	});

	describe('an intact log', () => {
		it('passes an unmodified chain that spans several files', async () => {
			const { head } = await buildLog(folder);

			const result = await verifyAgentChain(folder, head);

			expect(result).toEqual({
				ok: true,
				filesChecked: 3,
				recordsChecked: 9,
				headMatches: true,
			});
		});

		it('passes a log written by two turns of one agent at the same moment', async () => {
			const { writer, head } = createChain(folder);
			const first = turnFilePath(folder, HOUR_9, 'tab-1', 'turn-1');
			const second = turnFilePath(folder, HOUR_9, 'tab-2', 'turn-2');

			await Promise.all([
				(async () => {
					await writer.append(AGENT, first, turnStart('turn-1'));
					await writer.append(AGENT, first, text('turn-1', 'one'));
					await writer.append(AGENT, first, turnEnd('turn-1', 3));
				})(),
				(async () => {
					await writer.append(AGENT, second, turnStart('turn-2'));
					await writer.append(AGENT, second, text('turn-2', 'two'));
					await writer.append(AGENT, second, turnEnd('turn-2', 3));
				})(),
			]);

			const result = await verifyAgentChain(folder, head());

			expect(result).toMatchObject({ ok: true, filesChecked: 2, recordsChecked: 6 });
			expect(result.firstBreak).toBeUndefined();
		});

		it('passes a log that holds a capture-gap after a failed write', async () => {
			const { writer, head } = createChain(folder);
			const file = turnFilePath(folder, HOUR_9, 'tab-1', 'turn-1');
			await writer.append(AGENT, file, turnStart('turn-1'));
			vi.spyOn(fs.promises, 'appendFile').mockRejectedValueOnce(diskFull());
			expect(await writer.append(AGENT, file, text('turn-1', 'lost'))).toBeNull();
			await writer.append(AGENT, file, turnEnd('turn-1', 3));

			const result = await verifyAgentChain(folder, head());

			expect(result).toMatchObject({ ok: true, recordsChecked: 3, headMatches: true });
			const kinds = readLines(file)
				.filter((line) => line !== '')
				.map((line) => (JSON.parse(line) as CotRecord).kind);
			expect(kinds).toContain('capture-gap');
		});

		it('leaves a cut piece and a blank line alone when no record is missing', async () => {
			const { files, head } = await buildLog(folder);
			const lines = readLines(files[0]);
			lines.splice(2, 0, '{"v":1,"kind":"te', '');
			writeLines(files[0], lines);

			const result = await verifyAgentChain(folder, head);

			expect(result).toMatchObject({ ok: true, recordsChecked: 9, headMatches: true });
			expect(result.firstBreak).toBeUndefined();
		});

		it('ignores dotfiles and files that are not turn logs', async () => {
			const { files, head } = await buildLog(folder);
			const hourFolder = path.dirname(files[0]);
			fs.writeFileSync(path.join(hourFolder, '.maestro-write-probe-1-abc'), 'not a log');
			fs.writeFileSync(path.join(hourFolder, '.hidden.jsonl'), 'garbage');
			fs.writeFileSync(path.join(hourFolder, 'notes.txt'), 'garbage');
			fs.writeFileSync(path.join(folder, 'README.jsonl'), 'garbage');

			const result = await verifyAgentChain(folder, head);

			expect(result).toMatchObject({ ok: true, filesChecked: 3, recordsChecked: 9 });
		});
	});

	describe('an empty log', () => {
		it('verifies a folder with no records when no head is expected', async () => {
			expect(await verifyAgentChain(folder, null)).toEqual({
				ok: true,
				filesChecked: 0,
				recordsChecked: 0,
				headMatches: true,
			});
		});

		it('treats the genesis hash and no head as the same thing', async () => {
			const result = await verifyAgentChain(folder, COT_GENESIS_HASH);
			expect(result.ok).toBe(true);
		});

		it('verifies a folder that does not exist yet when no head is expected', async () => {
			const result = await verifyAgentChain(path.join(folder, 'not-created'), null);
			expect(result).toMatchObject({ ok: true, filesChecked: 0, headMatches: true });
		});

		it('fails when Maestro sealed records and none are left', async () => {
			const result = await verifyAgentChain(folder, 'a'.repeat(64));

			expect(result.ok).toBe(false);
			expect(result.headMatches).toBe(false);
			expect(result.firstBreak).toBeUndefined();
		});
	});

	describe('a damaged log', () => {
		it('reports the record whose content was edited, and not the ones after it', async () => {
			const { files, head } = await buildLog(folder);
			const lines = readLines(files[0]);
			const index = lineOf(files[0], 1);
			lines[index] = lines[index].replace('a-one', 'a-onx');
			writeLines(files[0], lines);

			const result = await verifyAgentChain(folder, head);

			expect(result.ok).toBe(false);
			expect(result.firstBreak).toMatchObject({ file: files[0], chainSeq: 1 });
			expect(result.firstBreak?.reason).toContain('Record 1 was changed');
			// The head is the newest record, which was not touched.
			expect(result.headMatches).toBe(true);
		});

		it('reports the record after one that was edited and sealed again', async () => {
			const { files, head } = await buildLog(folder);
			const lines = readLines(files[0]);
			const index = lineOf(files[0], 1);
			const original = JSON.parse(lines[index]) as CotRecord;
			const forged = sealRecord({ ...original, text: 'rewritten' } as CotRecord, original.prevHash);
			lines[index] = JSON.stringify(forged);
			writeLines(files[0], lines);

			const result = await verifyAgentChain(folder, head);

			expect(result.ok).toBe(false);
			expect(result.firstBreak).toMatchObject({ file: files[0], chainSeq: 2 });
			expect(result.firstBreak?.reason).toContain('does not link');
		});

		it('reports a record from another chain that was spliced into place', async () => {
			const { files, head } = await buildLog(folder, 'a');
			const other = await buildLog(otherFolder, 'b');
			const lines = readLines(files[0]);
			const foreign = readLines(other.files[0])[lineOf(other.files[0], 2)];
			lines[lineOf(files[0], 2)] = foreign;
			writeLines(files[0], lines);

			const result = await verifyAgentChain(folder, head);

			expect(result.ok).toBe(false);
			expect(result.firstBreak).toMatchObject({ file: files[0], chainSeq: 2 });
			expect(result.firstBreak?.reason).toContain('does not link');
		});

		it('reports the missing position when a middle file is deleted', async () => {
			const { files, head } = await buildLog(folder);
			fs.rmSync(files[1]);

			const result = await verifyAgentChain(folder, head);

			expect(result.ok).toBe(false);
			expect(result.filesChecked).toBe(2);
			expect(result.firstBreak).toMatchObject({ file: files[2], chainSeq: 4 });
			expect(result.firstBreak?.reason).toContain('Record 4 is missing');
		});

		it('reports position 0 when the oldest file is deleted', async () => {
			const { files, head } = await buildLog(folder);
			fs.rmSync(files[0]);

			const result = await verifyAgentChain(folder, head);

			expect(result.ok).toBe(false);
			expect(result.firstBreak).toMatchObject({ file: files[1], chainSeq: 0 });
		});

		it('reports two intact lines of one file that were swapped', async () => {
			const { files, head } = await buildLog(folder);
			const lines = readLines(files[0]);
			const first = lineOf(files[0], 1);
			const second = lineOf(files[0], 2);
			[lines[first], lines[second]] = [lines[second], lines[first]];
			writeLines(files[0], lines);

			const result = await verifyAgentChain(folder, head);

			// Every record is intact and every link holds. Only the order is wrong.
			expect(result.ok).toBe(false);
			expect(result.headMatches).toBe(true);
			expect(result.recordsChecked).toBe(9);
			expect(result.firstBreak).toMatchObject({ file: files[0], chainSeq: 1 });
			expect(result.firstBreak?.reason).toBe(
				'Record 1 comes after record 2 in its file, so the lines of the file were reordered.'
			);
		});

		it('reports a record that was moved to the top of its file', async () => {
			const { files, head } = await buildLog(folder);
			const lines = readLines(files[1]);
			const [moved] = lines.splice(lineOf(files[1], 6), 1);
			lines.unshift(moved);
			writeLines(files[1], lines);

			const result = await verifyAgentChain(folder, head);

			expect(result.ok).toBe(false);
			// Positions 4 and 5 now come after 6. The earlier of them is named.
			expect(result.firstBreak).toMatchObject({ file: files[1], chainSeq: 4 });
			expect(result.firstBreak?.reason).toContain('were reordered');
		});

		it('names the earlier problem when a file was reordered and another was edited', async () => {
			const { files, head } = await buildLog(folder);
			// Reordered in the second file, edited in the first.
			const later = readLines(files[1]);
			const a = lineOf(files[1], 4);
			const b = lineOf(files[1], 5);
			[later[a], later[b]] = [later[b], later[a]];
			writeLines(files[1], later);
			const earlier = readLines(files[0]);
			const edited = lineOf(files[0], 1);
			earlier[edited] = earlier[edited].replace('a-one', 'a-ONE');
			writeLines(files[0], earlier);

			const result = await verifyAgentChain(folder, head);

			expect(result.firstBreak).toMatchObject({ file: files[0], chainSeq: 1 });
			expect(result.firstBreak?.reason).toContain('was changed after it was written');
		});

		it('reports a missing record when one line is removed from the middle of a file', async () => {
			const { files, head } = await buildLog(folder);
			const lines = readLines(files[1]);
			lines.splice(lineOf(files[1], 5), 1);
			writeLines(files[1], lines);

			const result = await verifyAgentChain(folder, head);

			expect(result.ok).toBe(false);
			// Position 6 is the record after the gap, and it lies in the same file.
			expect(result.firstBreak).toMatchObject({ file: files[1], chainSeq: 5 });
			expect(result.firstBreak?.reason).toContain('removed from the log');
		});

		it('sets headMatches to false when the newest file is deleted', async () => {
			const { files, head } = await buildLog(folder);
			fs.rmSync(files[2]);

			const result = await verifyAgentChain(folder, head);

			// Nothing left in the folder is wrong. Only the head shows the loss.
			expect(result.firstBreak).toBeUndefined();
			expect(result.headMatches).toBe(false);
			expect(result.ok).toBe(false);
			expect(result.filesChecked).toBe(2);
			expect(result.recordsChecked).toBe(7);
		});

		it('sets headMatches to false when the newest line is removed', async () => {
			const { files, head } = await buildLog(folder);
			const lines = readLines(files[2]);
			lines.splice(lineOf(files[2], 8), 1);
			writeLines(files[2], lines);

			const result = await verifyAgentChain(folder, head);

			expect(result.firstBreak).toBeUndefined();
			expect(result).toMatchObject({ ok: false, headMatches: false, recordsChecked: 8 });
		});

		it('reports the invalid JSON of a line that was cut short in the middle', async () => {
			const { files, head } = await buildLog(folder);
			const lines = readLines(files[0]);
			const index = lineOf(files[0], 2);
			lines[index] = lines[index].slice(0, 30);
			writeLines(files[0], lines);

			const result = await verifyAgentChain(folder, head);

			expect(result.ok).toBe(false);
			expect(result.firstBreak).toMatchObject({ file: files[0], chainSeq: 2 });
			expect(result.firstBreak?.reason).toContain(`line ${index + 1} of this file`);
			expect(result.firstBreak?.reason).toContain('not valid JSON');
		});

		it('names a line that is JSON but not a record', async () => {
			const { files, head } = await buildLog(folder);
			const lines = readLines(files[0]);
			const index = lineOf(files[0], 2);
			lines[index] = '[1,2,3]';
			writeLines(files[0], lines);

			const result = await verifyAgentChain(folder, head);

			expect(result.firstBreak).toMatchObject({ file: files[0], chainSeq: 2 });
			expect(result.firstBreak?.reason).toContain('not a readable record');
		});

		it('does not blame a cut piece that sits where the missing record cannot have been', async () => {
			const { files, head } = await buildLog(folder);
			// A cut piece between positions 0 and 1 cannot have held position 5.
			const first = readLines(files[0]);
			first.splice(lineOf(files[0], 1), 0, '{"v":1,"kind":"te');
			writeLines(files[0], first);
			const second = readLines(files[1]);
			second.splice(lineOf(files[1], 5), 1);
			writeLines(files[1], second);

			const result = await verifyAgentChain(folder, head);

			expect(result.firstBreak).toMatchObject({ chainSeq: 5 });
			expect(result.firstBreak?.reason).toContain('removed from the log');
			expect(result.firstBreak?.reason).not.toContain('not valid JSON');
		});

		it('reports the cut start of the newest line through the head', async () => {
			const { files, head } = await buildLog(folder);
			const lines = readLines(files[2]);
			const index = lineOf(files[2], 8);
			lines[index] = lines[index].slice(0, 30);
			writeLines(files[2], lines);

			const result = await verifyAgentChain(folder, head);

			expect(result.ok).toBe(false);
			expect(result.headMatches).toBe(false);
			expect(result.recordsChecked).toBe(8);
		});

		it('reports a position that appears twice', async () => {
			const { files, head } = await buildLog(folder);
			const copy = turnFilePath(folder, new Date(2026, 9, 10, 8, 0, 0), 'tab-1', 'turn-0');
			fs.mkdirSync(path.dirname(copy), { recursive: true });
			fs.copyFileSync(files[0], copy);

			const result = await verifyAgentChain(folder, head);

			expect(result.ok).toBe(false);
			expect(result.firstBreak?.reason).toContain('appears more than once');
		});

		it('fails when records exist and Maestro has no head on record', async () => {
			await buildLog(folder);

			const result = await verifyAgentChain(folder, null);

			expect(result).toMatchObject({ ok: false, headMatches: false, recordsChecked: 9 });
			expect(result.firstBreak).toBeUndefined();
		});

		it('names a file it cannot read as the likely home of a missing record', async () => {
			if (process.platform === 'win32' || process.getuid?.() === 0) return;
			const { files, head } = await buildLog(folder);
			fs.chmodSync(files[1], 0o000);
			try {
				const result = await verifyAgentChain(folder, head);

				expect(result.ok).toBe(false);
				expect(result.filesChecked).toBe(2);
				expect(result.firstBreak).toMatchObject({ file: files[1], chainSeq: 4 });
				expect(result.firstBreak?.reason).toContain('could not be read');
			} finally {
				fs.chmodSync(files[1], 0o600);
			}
		});
	});
});
