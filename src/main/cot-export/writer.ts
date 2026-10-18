/**
 * Chain of thought export: the writer.
 *
 * This is the one place a record gets its position and its hashes, and the
 * one place a line reaches disk. A producer hands over a draft (the turn, the
 * time, the payload). The writer stamps `v`, `agentId`, `seq` and `chainSeq`,
 * seals the record against the head of the chain, and appends one line.
 *
 * WHAT IT GUARANTEES
 * - One agent, one line at a time. Writes for an agent go through a queue, so
 *   `chainSeq` has no holes and no repeats when two tabs of the agent write at
 *   the same moment. Different agents do not wait for each other.
 * - The head moves only after the line is on disk. A failed write changes
 *   nothing: not the head, not `seq`.
 * - A lost record is never silent. The writer counts what it could not write
 *   and puts a `capture-gap` in front of the next line that lands. The count
 *   lives in memory, so a gap that is still owed when the app quits is not
 *   written.
 * - It only appends. It never rewrites or shortens a file. A write that fails
 *   part of the way through can leave the start of a line behind, so the next
 *   append to that file begins on a new line. A reader must expect a blank
 *   line, and a line that is not a record.
 * - `append` and `recover` never reject. A failure goes to `onError`, so a
 *   throw cannot reach the process listener that feeds the writer.
 *
 * ONE FOLDER, ONE CHAIN
 * A file names its chain by the folder it lies in (`turnFileFolder`), not by
 * the folder the agent uses now. A change of folder applies from the next
 * turn, so a turn that started before the change goes on writing to its old
 * folder and its old chain, and `onHeadAdvanced` reports that folder.
 *
 * NO OPEN HANDLES
 * Every write is open, append, close. Nothing here keeps a file handle, so
 * the log folder does not sit in the list of files Maestro has open.
 * Recovery opens a file to read its end and closes it in the same call.
 *
 * This feature is hidden from agents on purpose. Read the header of
 * `src/shared/cotExport/types.ts` before you change or expose anything here.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createKeyedWriteQueue } from '../utils/atomic-json-store';
import { COT_EXPORT_FORMAT_VERSION, COT_GENESIS_CHAIN_SEQ } from '../../shared/cotExport/types';
import type {
	CotCaptureGapPayload,
	CotChainState,
	CotRecord,
	CotRecordBase,
	CotRecordPayload,
	CotUnsealedRecord,
} from '../../shared/cotExport/types';
import { isLinked, readChainLink, sealRecord } from './hash-chain';
import type { CotChainLink } from './hash-chain';
import { listTurnFiles, turnFileFolder } from './layout';

// ============================================================================
// Contract
// ============================================================================

/**
 * A record as its producer hands it over: the turn, the time of the event,
 * and the payload. The writer adds the rest, because only the writer knows
 * where a record lands once gaps and the agent's other turns are counted.
 */
export type CotRecordDraft = Pick<CotRecordBase, 'turnId' | 'ts'> & CotRecordPayload;

/** Everything the writer needs from outside. It reads no store and no clock itself. */
export interface CotWriterDeps {
	/**
	 * The stored state of the agent's chain in `folder`, or null when the agent
	 * has no chain there. The writer asks once per chain and holds the head in
	 * memory after that. A state for another folder is refused.
	 */
	getChainState: (agentId: string, folder: string) => CotChainState | null;
	/**
	 * A line landed, and `state` is the chain's new head. `state.folder` names
	 * the chain. It is not always the agent's current folder: a turn that
	 * started before a folder change still advances the old chain.
	 */
	onHeadAdvanced: (agentId: string, state: CotChainState) => void;
	/** A record could not be written, or the head could not be checked. */
	onError: (agentId: string, error: Error) => void;
	/** The clock, in epoch milliseconds. It times the writer's own `capture-gap` records. */
	now: () => number;
}

export interface CotWriter {
	/**
	 * Seals `draft` against the head of the chain `filePath` lies in and
	 * appends it as one line. `filePath` must come from `turnFilePath`.
	 *
	 * Resolves with the record as written, or with null when it was lost. It
	 * never rejects.
	 */
	append(agentId: string, filePath: string, draft: CotRecordDraft): Promise<CotRecord | null>;
	/**
	 * Checks the stored head of the agent's chain in `folder` against the disk
	 * now, in place of at the first write. It runs once per chain. Call it
	 * before a verify, so a head that was not saved before a crash is not
	 * reported as a removed record. It never rejects.
	 */
	recover(agentId: string, folder: string): Promise<void>;
	/**
	 * Runs `work` while nothing is written to the agent's chains: the agent's
	 * writes wait behind it, in order, and none is lost. `work` is given the
	 * newest record of the chain in `folder` that is sealed and on disk, after
	 * the stored head was checked against the disk as `recover` checks it; or
	 * null when the agent has no chain there.
	 *
	 * This is how a chain is read back and compared with its head. A walk that
	 * runs beside the writer can read one file before a record lands in it and
	 * the next file after, and then reports a record as missing that was only
	 * late. It rejects only when `work` does.
	 */
	whileQuiet<T>(
		agentId: string,
		folder: string,
		work: (state: CotChainState | null) => Promise<T>
	): Promise<T>;
}

/** What `recoverHead` found when it compared a stored head with the disk. */
export interface CotHeadRecovery {
	/**
	 * - `unchanged`: the newest record on disk is the stored head.
	 * - `adopted`: the disk holds records past the stored head, and they link
	 *   from it with no break. `state` is the newest of them.
	 * - `mismatch`: the disk contradicts the stored head. `state` is the stored
	 *   head, kept as it was.
	 */
	outcome: 'unchanged' | 'adopted' | 'mismatch';
	state: CotChainState;
}

// ============================================================================
// Head recovery
// ============================================================================

/**
 * How many hour folders, newest first, recovery reads. A turn that was still
 * running when the app stopped started in one of them, unless it had run for
 * the better part of a day.
 */
const RECOVERY_HOUR_FOLDERS = 24;

/** How much of a file recovery reads at a time, from the end. */
const TAIL_CHUNK_BYTES = 64 * 1024;

const NEWLINE_BYTE = 0x0a;

/** Reason of the gap written when the disk contradicts the stored head. */
const HEAD_MISMATCH_REASON = 'head-mismatch-on-start';

/** Reason of the gap written when the stored head could not be checked at all. */
const HEAD_UNCHECKED_REASON = 'head-unchecked-on-start';

/**
 * How many times the check of a stored head may fail before the writer goes on
 * without it. A file that is busy for a moment (a virus scanner, a sync
 * client) passes at the next record. A file that can never be read must not
 * stop the log for good, and must not cost a full walk at every record.
 */
const MAX_RECOVERY_ATTEMPTS = 3;

/**
 * The records at the end of one turn file, newest first: every record past
 * `chainSeq`, then the first one at or before it, where reading stops. A
 * line that is not a record (a blank one, or one cut short by a failed
 * write) is passed over.
 *
 * It reads from the end toward the start, a chunk at a time, so a long file
 * costs only as much as the part that matters.
 */
async function readLinksBackTo(filePath: string, chainSeq: number): Promise<CotChainLink[]> {
	const links: CotChainLink[] = [];
	const handle = await fs.promises.open(filePath, 'r');
	try {
		let position = (await handle.stat()).size;
		// The end of a line whose start has not been read yet.
		let partial: Buffer = Buffer.alloc(0);
		while (position > 0) {
			const length = Math.min(TAIL_CHUNK_BYTES, position);
			position -= length;
			const chunk = Buffer.alloc(length);
			const { bytesRead } = await handle.read(chunk, 0, length, position);
			const data = Buffer.concat([chunk.subarray(0, bytesRead), partial]);
			// A line is whole once the newline before it, or the start of the
			// file, has been read. A newline byte is never part of another
			// character in UTF-8, so a cut there never splits one.
			const firstNewline = position === 0 ? -1 : data.indexOf(NEWLINE_BYTE);
			if (position > 0 && firstNewline === -1) {
				partial = data;
				continue;
			}
			partial = data.subarray(0, firstNewline + 1);
			const lines = data.toString('utf8', firstNewline + 1).split('\n');
			for (let i = lines.length - 1; i >= 0; i--) {
				const link = readChainLink(lines[i]);
				if (!link) continue;
				links.push(link);
				if (link.chainSeq <= chainSeq) return links;
			}
		}
	} finally {
		await handle.close();
	}
	return links;
}

/**
 * Compares the stored head of a chain with what is on disk in `folder`.
 *
 * The head is saved a moment after a write, so an app that stopped hard can
 * leave records on disk that the stored head does not know. Those records are
 * Maestro's own, and treating them as foreign would break the chain at the
 * first write after every crash. So when every record past the stored head
 * links from it, one after the other, the newest of them is the head. They
 * can lie in more than one file: a turn can end and the next begin, or two
 * tabs can write, before the head is saved.
 *
 * Anything else is a contradiction: the record the head names is not the
 * newest on disk and nothing links forward from it (records were removed), or
 * the records past it do not form one unbroken line (something was edited,
 * removed, or put in). The stored head is kept, and the caller owes the chain
 * a `capture-gap`.
 *
 * It reads only the newest hour folders, and changes nothing on disk. It
 * throws when the folder cannot be read. A folder that does not exist holds
 * no records, which is not an error.
 *
 * A chain with no stored head is the one case that reads every folder. It is
 * either new, with nothing on disk to read, or it was set up again over a log
 * whose state Maestro lost. Every record of that log is then past the stored
 * head, and the chain can be taken up only from all of them: a record that is
 * not position 0, read from the newest folders alone, links to nothing here.
 *
 * A limit, stated plainly: a forward record is taken on trust. After a hard
 * stop Maestro cannot tell a record it wrote and did not save from one that
 * someone who knew the head appended. That is inside the limit this feature
 * already states: it gives tamper evidence, not protection from a process
 * that runs as the same user and sets out to forge the log.
 */
export async function recoverHead(folder: string, stored: CotChainState): Promise<CotHeadRecovery> {
	const forward: CotChainLink[] = [];
	// The newest record on disk at or before the stored head.
	let newestBehind: CotChainLink | null = null;
	const files = await listTurnFiles(
		folder,
		stored.chainSeq === COT_GENESIS_CHAIN_SEQ ? {} : { newestHourFolders: RECOVERY_HOUR_FOLDERS }
	);
	for (const file of files) {
		for (const link of await readLinksBackTo(file, stored.chainSeq)) {
			if (link.chainSeq > stored.chainSeq) forward.push(link);
			else if (!newestBehind || link.chainSeq > newestBehind.chainSeq) newestBehind = link;
		}
	}

	const mismatch: CotHeadRecovery = { outcome: 'mismatch', state: stored };

	if (forward.length === 0) {
		// A chain with no records yet has nothing on disk to agree with.
		if (stored.chainSeq === COT_GENESIS_CHAIN_SEQ) return { outcome: 'unchanged', state: stored };
		const headIsOnDisk =
			newestBehind !== null &&
			newestBehind.chainSeq === stored.chainSeq &&
			newestBehind.hash === stored.head &&
			newestBehind.intact;
		return headIsOnDisk ? { outcome: 'unchanged', state: stored } : mismatch;
	}

	forward.sort((a, b) => a.chainSeq - b.chainSeq);
	let head = stored.head;
	let chainSeq = stored.chainSeq;
	for (const link of forward) {
		if (!link.intact || link.chainSeq !== chainSeq + 1 || !isLinked(link, head)) return mismatch;
		head = link.hash;
		chainSeq = link.chainSeq;
	}
	return { outcome: 'adopted', state: { folder: stored.folder, head, chainSeq } };
}

// ============================================================================
// Writer
// ============================================================================

/** What the writer remembers about one turn file. */
interface TurnFileState {
	/** `seq` of the next record in the file. */
	nextSeq: number;
	/**
	 * An append to the file failed, and may have left the start of a line at
	 * its end. The next append begins with a newline, so the new record is not
	 * joined to that piece.
	 */
	cut: boolean;
}

/** What the writer remembers about one chain: one agent, one folder. */
interface ChainSlot {
	/** The newest record that is sealed into the chain AND on disk. */
	state: CotChainState;
	/** Whether the stored head was checked against the disk since the app started. */
	recovered: boolean;
	/** How many times that check failed. See `MAX_RECOVERY_ATTEMPTS`. */
	recoveryFailures: number;
	/**
	 * The reason of the gap the chain is owed for its head: the disk
	 * contradicted it, or it could not be checked. Null when nothing is owed.
	 */
	headGap: string | null;
	/** Records lost since the last line that landed. */
	dropped: number;
	/** Why the first of those records was lost. */
	dropCode: string | null;
	/**
	 * One entry per turn file, removed when the turn's `turn-end` is handled.
	 * A turn that never ends keeps its small entry until the app quits.
	 */
	files: Map<string, TurnFileState>;
}

/**
 * A record canonical JSON refused. It has no hash, so it cannot join the
 * chain. The message says what kind of value was refused and never its
 * content.
 */
class UnserializableRecordError extends Error {
	readonly code = 'unserializable';

	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : 'The record holds a value that is not JSON.');
		this.name = 'UnserializableRecordError';
	}
}

/**
 * The word a failure gets in a gap's `reason`: the system's error code when
 * there is one (`ENOSPC`, `EACCES`), `unserializable` for a record that could
 * not be sealed.
 */
function failureCode(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === 'string' && code !== '' ? code : 'unknown';
}

/**
 * `draft` with the fields only the writer can give. The writer's values go
 * last, so a draft that carries a stray position or agent id cannot set them.
 */
function stamp(
	draft: CotRecordDraft,
	agentId: string,
	seq: number,
	chainSeq: number
): CotUnsealedRecord {
	const { turnId, ts, ...payload } = draft;
	const base: Omit<CotRecordBase, 'prevHash' | 'hash'> = {
		v: COT_EXPORT_FORMAT_VERSION,
		kind: payload.kind,
		agentId,
		turnId,
		seq,
		chainSeq,
		ts,
	};
	return { ...base, ...payload, v: COT_EXPORT_FORMAT_VERSION, agentId, seq, chainSeq };
}

/** The gaps a chain is owed, oldest cause first. */
function owedGaps(slot: ChainSlot): CotCaptureGapPayload[] {
	const gaps: CotCaptureGapPayload[] = [];
	if (slot.headGap !== null) gaps.push({ kind: 'capture-gap', reason: slot.headGap });
	if (slot.dropped > 0) {
		gaps.push({
			kind: 'capture-gap',
			reason: `write-failed:${slot.dropCode ?? 'unknown'}`,
			droppedRecords: slot.dropped,
		});
	}
	return gaps;
}

export function createCotWriter(deps: CotWriterDeps): CotWriter {
	const queue = createKeyedWriteQueue();
	// Keyed by agent id, a newline, and the chain's folder. An agent id holds
	// no newline, so two chains cannot share a key.
	const slots = new Map<string, ChainSlot>();

	function report(agentId: string, error: unknown): void {
		try {
			deps.onError(agentId, error instanceof Error ? error : new Error(String(error)));
		} catch {
			// `onError` is the last place a failure can go. When it throws too,
			// there is nowhere left to send it, and it must not reject `append`.
		}
	}

	function announce(agentId: string, state: CotChainState): void {
		try {
			deps.onHeadAdvanced(agentId, { ...state });
		} catch (error) {
			// The line is on disk and the head moved in memory. Only the caller's
			// copy is behind, and recovery mends that at the next start.
			report(agentId, error);
		}
	}

	/** The chain `agentId` writes in `folder`, or null when the agent has none there. */
	function slotFor(agentId: string, folder: string): ChainSlot | null {
		const key = `${agentId}\n${folder}`;
		let slot = slots.get(key);
		if (!slot) {
			const stored = deps.getChainState(agentId, folder);
			if (!stored || path.resolve(stored.folder) !== folder) return null;
			slot = {
				state: { ...stored },
				recovered: false,
				recoveryFailures: 0,
				headGap: null,
				dropped: 0,
				dropCode: null,
				files: new Map(),
			};
			slots.set(key, slot);
		}
		return slot;
	}

	/**
	 * Checks the stored head against the disk, the first time the chain is used.
	 *
	 * It throws while the check keeps failing, so the record that asked for it
	 * is counted as lost and the next one tries again. After
	 * `MAX_RECOVERY_ATTEMPTS` it stops trying: the chain goes on from the stored
	 * head, and a gap says the head was never checked.
	 */
	async function recoverOnce(agentId: string, folder: string, slot: ChainSlot): Promise<void> {
		if (slot.recovered) return;
		let recovery: CotHeadRecovery;
		try {
			recovery = await recoverHead(folder, slot.state);
		} catch (error) {
			slot.recoveryFailures += 1;
			if (slot.recoveryFailures < MAX_RECOVERY_ATTEMPTS) throw error;
			report(agentId, error);
			slot.recovered = true;
			slot.headGap = HEAD_UNCHECKED_REASON;
			return;
		}
		slot.recovered = true;
		if (recovery.outcome === 'mismatch') slot.headGap = HEAD_MISMATCH_REASON;
		if (recovery.outcome === 'adopted') {
			slot.state = recovery.state;
			announce(agentId, slot.state);
		}
	}

	/**
	 * Seals what the chain is owed and then `draft`, and writes them with one
	 * append. Nothing the writer remembers changes unless the append lands.
	 */
	async function land(
		agentId: string,
		filePath: string,
		draft: CotRecordDraft,
		slot: ChainSlot
	): Promise<CotRecord> {
		let file = slot.files.get(filePath);
		if (!file) {
			file = { nextSeq: 0, cut: false };
			slot.files.set(filePath, file);
		}
		let { head, chainSeq } = slot.state;
		let seq = file.nextSeq;
		let text = file.cut ? '\n' : '';
		const seal = (item: CotRecordDraft): CotRecord => {
			let record: CotRecord;
			try {
				record = sealRecord(stamp(item, agentId, seq, chainSeq + 1), head);
			} catch (error) {
				throw new UnserializableRecordError(error);
			}
			head = record.hash;
			chainSeq += 1;
			seq += 1;
			text += `${JSON.stringify(record)}\n`;
			return record;
		};

		// A gap carries the id of the turn whose file it is written into.
		const gaps = owedGaps(slot);
		if (gaps.length > 0) {
			const ts = new Date(deps.now()).toISOString();
			for (const gap of gaps) seal({ turnId: draft.turnId, ts, ...gap });
		}
		const record = seal(draft);

		await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
		file.cut = true;
		await fs.promises.appendFile(filePath, text, { mode: 0o600 });
		file.cut = false;

		file.nextSeq = seq;
		slot.state = { folder: slot.state.folder, head, chainSeq };
		slot.headGap = null;
		slot.dropped = 0;
		slot.dropCode = null;
		announce(agentId, slot.state);
		return record;
	}

	async function appendNow(
		agentId: string,
		filePath: string,
		draft: CotRecordDraft
	): Promise<CotRecord | null> {
		const folder = turnFileFolder(filePath);
		let slot: ChainSlot | null = null;
		try {
			slot = slotFor(agentId, folder);
			if (!slot)
				throw new Error('The record belongs to a folder that holds no chain for its agent.');
			await recoverOnce(agentId, folder, slot);
			return await land(agentId, filePath, draft, slot);
		} catch (error) {
			// With no chain there is nothing to count the loss against.
			if (slot) {
				slot.dropped += 1;
				slot.dropCode ??= failureCode(error);
			}
			report(agentId, error);
			return null;
		} finally {
			// The turn is over whether or not its last record landed.
			if (slot && draft.kind === 'turn-end') slot.files.delete(filePath);
		}
	}

	return {
		append(agentId, filePath, draft) {
			return queue.enqueue(agentId, () => appendNow(agentId, filePath, draft));
		},
		recover(agentId, folder) {
			return queue.enqueue(agentId, async () => {
				const resolved = path.resolve(folder);
				try {
					// An agent with no chain in the folder has nothing to check.
					const slot = slotFor(agentId, resolved);
					if (slot) await recoverOnce(agentId, resolved, slot);
				} catch (error) {
					report(agentId, error);
				}
			});
		},
		whileQuiet(agentId, folder, work) {
			return queue.enqueue(agentId, async () => {
				const resolved = path.resolve(folder);
				let slot: ChainSlot | null = null;
				try {
					slot = slotFor(agentId, resolved);
					if (slot) await recoverOnce(agentId, resolved, slot);
				} catch (error) {
					// The head could not be checked this time. The chain is still
					// read back against the head as it is held: that is the best
					// answer there is, and the failure is on record.
					report(agentId, error);
				}
				return work(slot ? { ...slot.state } : null);
			});
		},
	};
}
