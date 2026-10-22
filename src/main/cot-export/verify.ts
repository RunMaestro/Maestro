/**
 * Chain of thought export: the verifier.
 *
 * It walks one agent's folder, reads every turn file, and checks that the
 * records still form the chain the writer sealed. It reads and never writes.
 *
 * WHAT IT CAN SHOW
 * - A record that was edited: its contents no longer match its hash.
 * - Records that were reordered, replaced, or spliced in: a record does not
 *   link to the one before it, or the lines of a file are no longer in the
 *   order they were written in.
 * - A record or a whole file that was deleted from the middle: a position
 *   is missing.
 * - The newest records or files that were deleted: the newest record on disk
 *   is not the head Maestro last sealed. No record left in the folder can
 *   show this, so it takes the head from outside (`expectedHead`).
 *
 * WHAT IT DOES NOT TREAT AS TAMPERING
 * The writer only appends, and a write that fails part of the way through can
 * leave the cut start of a line behind, or a blank line. Such a line is not a
 * record, and a chain with no missing position, no bad link, and a matching
 * head is intact with it. Reporting every unreadable line would fail every
 * log that ever met a full disk, which is the case `capture-gap` exists for.
 * An unreadable line matters only when a record is missing, and then it is
 * named as the likely cause.
 *
 * Call `writer.recover(agentId, folder)` before this, and pass the stored
 * head. After a hard stop the stored head can be behind the disk until the
 * agent's next turn, and a verify in that window reports `headMatches: false`
 * for a log that is intact.
 *
 * This feature is hidden from agents on purpose. Read the header of
 * `src/shared/cotExport/types.ts` before you change or expose anything here.
 */

import * as fs from 'fs';
import { COT_GENESIS_CHAIN_SEQ, COT_GENESIS_HASH } from '../../shared/cotExport/types';
import type { CotVerifyResult } from '../../shared/cotExport/types';
import { readChainLink } from './hash-chain';
import { listTurnFiles } from './layout';

/** The few fields of one record the walk keeps, so memory stays bounded. */
interface RecordTuple {
	chainSeq: number;
	prevHash: string;
	hash: string;
	/** Whether the stored hash is the hash the contents give. */
	intact: boolean;
	/** Index into the list of files, not the path, so a large log stays small. */
	fileIndex: number;
}

/**
 * Something in a file that could have held a record Maestro wrote: a line
 * that is not a record, or a file that could not be read. It is named when a
 * position is missing, and does not break the chain by itself.
 */
interface Suspect {
	fileIndex: number;
	/** A sentence fragment that says what it is, for the reason text. */
	description: string;
	/**
	 * The chain positions it can have held, exclusive at both ends. A turn
	 * file lists its records in chain order, so a line lies between the
	 * record before it and the record after it in the same file.
	 */
	after: number;
	before: number;
}

type FirstBreak = NonNullable<CotVerifyResult['firstBreak']>;

/**
 * Reads one turn file line by line, adding each record to `records` and each
 * line that is not a record to `suspects`. Returns false when the file could
 * not be read to the end. Records read before the failure are kept.
 *
 * The writer appends, one record at a time, so the positions in a file only
 * ever go up. A record that comes after one with a higher position was moved
 * there, and it is added to `misplaced`. The walk over the whole chain sorts
 * by position and would not see it: every record is intact and every link
 * holds, and still the file no longer reads in the order things happened.
 */
async function readTurnFile(
	file: string,
	fileIndex: number,
	records: RecordTuple[],
	suspects: Suspect[],
	misplaced: FirstBreak[]
): Promise<boolean> {
	let lineNumber = 0;
	let lastChainSeq = COT_GENESIS_CHAIN_SEQ;
	/** Suspects in this file still waiting for the record that follows them. */
	let waiting: Suspect[] = [];

	const handleLine = (line: string): void => {
		lineNumber += 1;
		if (line.trim() === '') return;
		const link = readChainLink(line);
		if (link === null) {
			let validJson = true;
			try {
				JSON.parse(line);
			} catch {
				validJson = false;
			}
			const suspect: Suspect = {
				fileIndex,
				description: validJson
					? `line ${lineNumber} of this file is not a readable record`
					: `line ${lineNumber} of this file is not valid JSON`,
				after: lastChainSeq,
				before: Infinity,
			};
			suspects.push(suspect);
			waiting.push(suspect);
			return;
		}
		for (const suspect of waiting) suspect.before = link.chainSeq;
		waiting = [];
		// A repeat of a position is the chain walk's to report, so only a step
		// back is taken here.
		if (link.chainSeq < lastChainSeq) {
			misplaced.push({
				file,
				chainSeq: link.chainSeq,
				reason: `Record ${link.chainSeq} comes after record ${lastChainSeq} in its file, so the lines of the file were reordered.`,
			});
		}
		lastChainSeq = Math.max(lastChainSeq, link.chainSeq);
		records.push({
			chainSeq: link.chainSeq,
			prevHash: link.prevHash,
			hash: link.hash,
			intact: link.intact,
			fileIndex,
		});
	};

	// The stream hands over decoded text in chunks, and a line is cut out of
	// the chunks by hand. That keeps one line in memory at a time, and a read
	// error rejects the loop, which `readline` did not do on every Node line.
	const stream = fs.createReadStream(file, { encoding: 'utf8' });
	let pending = '';
	try {
		for await (const chunk of stream as AsyncIterable<string>) {
			pending += chunk;
			let start = 0;
			let newline = pending.indexOf('\n', start);
			while (newline !== -1) {
				handleLine(pending.slice(start, newline));
				start = newline + 1;
				newline = pending.indexOf('\n', start);
			}
			pending = pending.slice(start);
		}
		if (pending !== '') handleLine(pending);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | null)?.code;
		suspects.push({
			fileIndex,
			description: code ? `this file could not be read (${code})` : 'this file could not be read',
			after: lastChainSeq,
			before: Infinity,
		});
		return false;
	} finally {
		stream.destroy();
	}
}

/**
 * The reason text for a missing position, naming the line or file that may
 * have held the record when there is one.
 */
function missingBreak(
	position: number,
	files: string[],
	suspects: Suspect[],
	followedBy: RecordTuple
): FirstBreak {
	const suspect = suspects.find((s) => s.after < position && position < s.before);
	if (suspect) {
		return {
			file: files[suspect.fileIndex],
			chainSeq: position,
			reason: `Record ${position} is missing, and ${suspect.description}, so it may have held that record.`,
		};
	}
	return {
		file: files[followedBy.fileIndex],
		chainSeq: position,
		reason: `Record ${position} is missing: a record or a whole file was removed from the log.`,
	};
}

/**
 * Walks `records` (sorted by position) and returns the earliest problem. The
 * chain starts at the genesis hash and position 0, because one folder holds
 * one chain from its start.
 */
function findFirstBreak(
	records: RecordTuple[],
	files: string[],
	suspects: Suspect[]
): FirstBreak | undefined {
	let expectedSeq = COT_GENESIS_CHAIN_SEQ + 1;
	let expectedPrev = COT_GENESIS_HASH;
	for (const record of records) {
		const file = files[record.fileIndex];
		if (record.chainSeq < 0) {
			return {
				file,
				chainSeq: record.chainSeq,
				reason: `A record claims position ${record.chainSeq}, which no record of this log can have.`,
			};
		}
		if (record.chainSeq < expectedSeq) {
			return {
				file,
				chainSeq: record.chainSeq,
				reason: `Position ${record.chainSeq} appears more than once, so two logs share this folder or a file was copied in.`,
			};
		}
		if (record.chainSeq > expectedSeq) {
			return missingBreak(expectedSeq, files, suspects, record);
		}
		if (!record.intact) {
			return {
				file,
				chainSeq: record.chainSeq,
				reason: `Record ${record.chainSeq} was changed after it was written: its contents no longer match its hash.`,
			};
		}
		if (record.prevHash !== expectedPrev) {
			return {
				file,
				chainSeq: record.chainSeq,
				reason: `Record ${record.chainSeq} does not link to the record before it, so records were reordered, replaced, or spliced in.`,
			};
		}
		expectedPrev = record.hash;
		expectedSeq += 1;
	}
	return undefined;
}

/**
 * Checks every turn file under `folder` as one chain.
 *
 * `expectedHead` is the hash of the newest record Maestro sealed, as stored
 * outside the folder. Pass `null` when Maestro has recorded no head: that is
 * the same as the genesis hash, so an empty folder verifies and a folder with
 * records in it does not (no head means nothing vouches for them).
 *
 * `ok` is true only when there is no break AND the head matches.
 *
 * It does not reject for a file it cannot read: that file's records are then
 * absent, and the chain shows it as a missing position or a head mismatch,
 * with the file named when it can be. It does reject when the folder itself
 * cannot be listed, since no verdict can be given then.
 */
export async function verifyAgentChain(
	folder: string,
	expectedHead: string | null
): Promise<CotVerifyResult> {
	const files = await listTurnFiles(folder);
	const records: RecordTuple[] = [];
	const suspects: Suspect[] = [];
	const misplaced: FirstBreak[] = [];
	let filesChecked = 0;
	for (let index = 0; index < files.length; index++) {
		if (await readTurnFile(files[index], index, records, suspects, misplaced)) filesChecked += 1;
	}

	// Concurrent turns of one agent write to different files, so file order is
	// not chain order. The position inside each record is the order.
	records.sort((a, b) => a.chainSeq - b.chainSeq);

	// The earliest problem, whichever kind it is.
	const firstBreak = [findFirstBreak(records, files, suspects), ...misplaced]
		.filter((found): found is FirstBreak => found !== undefined)
		.sort((a, b) => a.chainSeq - b.chainSeq)[0];
	const newestHash = records.length > 0 ? records[records.length - 1].hash : COT_GENESIS_HASH;
	const headMatches = newestHash === (expectedHead ?? COT_GENESIS_HASH);

	const result: CotVerifyResult = {
		ok: firstBreak === undefined && headMatches,
		filesChecked,
		recordsChecked: records.length,
		headMatches,
	};
	if (firstBreak) result.firstBreak = firstBreak;
	return result;
}
