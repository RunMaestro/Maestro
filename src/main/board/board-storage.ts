/**
 * Board storage - single owner of `.maestro/board.yaml`.
 *
 * Mirrors the Cue config (`.maestro/cue.yaml`) and Phase 1 profiles
 * (`.maestro/profiles.yaml`) conventions: all filesystem reads/writes for the
 * board file flow through this module so path resolution and directory creation
 * live in exactly one place. Uses the shared `js-yaml` helper - no new
 * dependency.
 *
 * The file format is a single top-level `boards:` list, each board holding its
 * own `cards:`:
 *
 *   boards:
 *     - id: 8f3c…
 *       name: Backend rework
 *       maxInProgress: 2
 *       cards:
 *         - id: a
 *           title: Design schema
 *           body: …
 *           assigneeProfileId: reviewer
 *           parents: []
 *           status: todo
 *           createdAt: 2026-07-10T00:00:00.000Z
 *           updatedAt: 2026-07-10T00:00:00.000Z
 *
 * Load validates each board/card via the shared validators and skips malformed
 * cards with a logged warning, so one bad entry never blocks the rest. Save
 * refuses to persist a board whose parent graph contains a cycle (Phase 3
 * relies on the DAG being acyclic).
 *
 * Writes are atomic (temp file + rename via `atomicWriteFileSync`) so a crash
 * or a concurrent reader never observes a truncated board.yaml, and async
 * read-modify-write callers serialize per file through
 * {@link enqueueBoardWrite}.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { MAESTRO_DIR, BOARD_CONFIG_PATH } from '../../shared/maestro-paths';
import {
	validateBoard,
	validateBoardCard,
	type Board,
	type BoardCard,
	type CardStatus,
} from '../../shared/board/types';
import { hasCycle } from '../../shared/board/graph';
import { generateUUID } from '../../shared/uuid';
import { logger } from '../utils/logger';
import { atomicWriteFileSync, createKeyedWriteQueue } from '../utils/atomic-json-store';

const LOG_CONTEXT = 'Board';

/**
 * Per-file write chain for board.yaml, keyed by the absolute file path (so two
 * projects never block each other). The storage mutations below are synchronous
 * and therefore cannot interleave with each other inside a single tick, but an
 * async caller that does its own read → await → write cycle can. Route those
 * through {@link enqueueBoardWrite} so the whole cycle is serialized against
 * every other queued mutation on the same file.
 *
 * Uses the shared `createKeyedWriteQueue` rather than a bespoke chain; Cue's
 * `enqueueYamlWrite` (cue-engine.ts) predates it and can adopt the same helper.
 */
const boardWriteQueue = createKeyedWriteQueue();

/**
 * Run `work` serialized against every other queued mutation for this project's
 * board.yaml. Callers that read-modify-write across an `await` MUST use this;
 * purely synchronous callers do not need it.
 */
export function enqueueBoardWrite<T>(projectRoot: string, work: () => T | Promise<T>): Promise<T> {
	return boardWriteQueue.enqueue(boardConfigPath(projectRoot), async () => work());
}

/** Absolute path to a project's board.yaml (may not exist yet). */
function boardConfigPath(projectRoot: string): string {
	return path.join(projectRoot, BOARD_CONFIG_PATH);
}

/**
 * Thrown when board.yaml exists but cannot be read or parsed.
 *
 * This is deliberately NOT the same as "no board yet". A missing file returns
 * `[]`; an unreadable or malformed one throws, because the alternative (the old
 * behavior) was catastrophic: `loadBoards` returned `[]`, the very next
 * `saveBoards` wrote that empty list over the top, and every board the user had
 * was gone. Failing closed keeps the damaged file on disk where a human can fix
 * it, at the cost of the Board being unavailable until they do.
 */
export class BoardStorageError extends Error {
	readonly filePath: string;

	constructor(filePath: string, cause: unknown) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		super(`Failed to read board file ${filePath}: ${detail}`);
		this.name = 'BoardStorageError';
		this.filePath = filePath;
	}
}

/** ISO timestamp. Kept as a helper so tests can reason about the shape. */
function nowIso(): string {
	return new Date().toISOString();
}

/**
 * Load and validate all boards for a project.
 *
 * Three distinct outcomes, and the distinction matters:
 *  - **Missing file** -> `[]`. The normal "no board yet" case.
 *  - **Read or parse failure** -> throws {@link BoardStorageError}. Every
 *    mutation path funnels through here, so a damaged file blocks writes rather
 *    than being silently replaced by an empty board.
 *  - **Valid file** -> the boards. Individual malformed cards are still skipped
 *    with a logged warning (one bad card never blocks the rest), and duplicate
 *    board ids keep the first occurrence.
 */
export function loadBoards(projectRoot: string): Board[] {
	const filePath = boardConfigPath(projectRoot);
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, 'utf-8');
	} catch (err) {
		// Missing file is the common case (no board yet) - not an error. Anything
		// else (permissions, a directory in the way, I/O failure) is real and must
		// not be mistaken for "no boards".
		if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
			return [];
		}
		throw new BoardStorageError(filePath, err);
	}

	let parsed: unknown;
	try {
		parsed = yaml.load(raw);
	} catch (err) {
		logger.warn(
			`Failed to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
			LOG_CONTEXT
		);
		throw new BoardStorageError(filePath, err);
	}

	// An empty file parses to null/undefined - treat that as "no boards yet"
	// rather than corruption, since that is what an empty `.maestro/board.yaml`
	// legitimately means.
	if (parsed === null || parsed === undefined) {
		return [];
	}
	if (typeof parsed !== 'object') {
		throw new BoardStorageError(filePath, new Error('expected a mapping at the top level'));
	}

	const list = (parsed as { boards?: unknown }).boards;
	if (list === undefined || list === null) {
		return [];
	}
	if (!Array.isArray(list)) {
		throw new BoardStorageError(filePath, new Error('`boards` is present but is not a list'));
	}

	const boards: Board[] = [];
	const seenIds = new Set<string>();
	for (const entry of list) {
		const before = Array.isArray((entry as { cards?: unknown })?.cards)
			? (entry as { cards: unknown[] }).cards.length
			: 0;
		const board = validateBoard(entry);
		if (!board) {
			logger.warn(`Skipping malformed board entry in ${filePath}`, LOG_CONTEXT);
			continue;
		}
		if (board.cards.length < before) {
			logger.warn(
				`Skipped ${before - board.cards.length} malformed card(s) in board "${board.id}"`,
				LOG_CONTEXT
			);
		}
		if (seenIds.has(board.id)) {
			logger.warn(`Skipping duplicate board id "${board.id}" in ${filePath}`, LOG_CONTEXT);
			continue;
		}
		seenIds.add(board.id);
		boards.push(board);
	}
	return boards;
}

/** Alias for {@link loadBoards} - the public "list" verb used by IPC callers. */
export function listBoards(projectRoot: string): Board[] {
	return loadBoards(projectRoot);
}

/** Return a single board by id, or `null` when it does not exist. */
export function getBoard(projectRoot: string, boardId: string): Board | null {
	return loadBoards(projectRoot).find((b) => b.id === boardId) ?? null;
}

/**
 * Persist the given boards to a project's `.maestro/board.yaml`, creating
 * `.maestro/` if needed. Invalid cards are dropped before writing so the file on
 * disk always round-trips cleanly. Rejects (throws) if any board's parent graph
 * contains a cycle - the DAG invariant Phase 3's dispatcher relies on. Returns
 * the absolute path written.
 */
export function saveBoards(projectRoot: string, boards: Board[]): string {
	const valid = boards.map((b) => validateBoard(b)).filter((b): b is Board => b !== null);

	for (const board of valid) {
		if (hasCycle(board)) {
			throw new Error(`saveBoards: board "${board.id}" has a cyclic parent graph`);
		}
	}

	const maestroDir = path.join(projectRoot, MAESTRO_DIR);
	if (!fs.existsSync(maestroDir)) {
		fs.mkdirSync(maestroDir, { recursive: true });
	}
	const filePath = boardConfigPath(projectRoot);
	const content = yaml.dump({ boards: valid }, { lineWidth: -1 });
	// Atomic (temp file + rename): a crash mid-write leaves the previous
	// board.yaml intact instead of a truncated file that would load as empty.
	atomicWriteFileSync(filePath, content);
	return filePath;
}

/**
 * Upsert a single board into a project's `.maestro/board.yaml`: replace the
 * board with the same id in place, or append it when new. All other boards are
 * preserved. Used by the Phase 3 dispatcher to persist card-status changes for
 * one board without disturbing its siblings. Returns the absolute path written.
 */
export function saveBoard(projectRoot: string, board: Board): string {
	const boards = loadBoards(projectRoot);
	const index = boards.findIndex((b) => b.id === board.id);
	if (index >= 0) {
		boards[index] = board;
	} else {
		boards.push(board);
	}
	return saveBoards(projectRoot, boards);
}

/**
 * Create a new, empty board and persist it. Mints a UUID id, trims the name
 * (required), and upserts it alongside any existing boards. Returns the created
 * board. Used by the Board UI (Phase 4) to stand up the first board on demand.
 */
export function createBoard(projectRoot: string, name: string): Board {
	const trimmed = (name ?? '').trim();
	if (!trimmed) {
		throw new Error('createBoard: name is required');
	}
	const board: Board = { id: generateUUID(), name: trimmed, cards: [] };
	saveBoard(projectRoot, board);
	return board;
}

/** Load a board by id or throw a caller-surfaceable error when it is missing. */
function requireBoard(boards: Board[], boardId: string): Board {
	const board = boards.find((b) => b.id === boardId);
	if (!board) {
		throw new Error(`Board "${boardId}" not found`);
	}
	return board;
}

/**
 * Add a card to a board. Validates the card, stamps `createdAt`/`updatedAt` when
 * absent, and rejects (via {@link saveBoards}) if the addition would introduce a
 * cycle. Throws if the board or a card with the same id already exists. Returns
 * the updated board.
 */
export function addCard(projectRoot: string, boardId: string, card: BoardCard): Board {
	const validated = validateBoardCard(card, nowIso());
	if (!validated) {
		throw new Error('addCard: invalid card shape');
	}
	const boards = loadBoards(projectRoot);
	const board = requireBoard(boards, boardId);
	if (board.cards.some((c) => c.id === validated.id)) {
		throw new Error(`addCard: card "${validated.id}" already exists on board "${boardId}"`);
	}
	board.cards.push(validated);
	saveBoards(projectRoot, boards);
	return board;
}

/**
 * Statuses the dispatcher DERIVES and therefore owns. `ready` is computed from
 * the DAG (`todo` with all parents `done`) and `running` is stamped when a card
 * is claimed and an agent is actually spawned for it. Accepting either from IPC
 * or the CLI produces a card the engine's own bookkeeping disagrees with: a
 * hand-set `running` card has no open run, so the dispatcher's stale-reclaim
 * pass eventually drags it back, and a hand-set `ready` card jumps the DAG gate
 * and can dispatch before its parents are done.
 *
 * Authors write `todo`; the engine does the rest.
 */
const DERIVED_STATUSES: ReadonlySet<CardStatus> = new Set<CardStatus>(['ready', 'running']);

/**
 * Update a card's status. Stamps `updatedAt`. Throws if the board or card is
 * missing, or if the caller tried to set a dispatcher-derived status (see
 * {@link DERIVED_STATUSES}). Returns the updated board.
 */
export function updateCardStatus(
	projectRoot: string,
	boardId: string,
	cardId: string,
	status: CardStatus
): Board {
	if (DERIVED_STATUSES.has(status)) {
		throw new Error(
			`updateCardStatus: "${status}" is set by the dispatcher, not manually. ` +
				`Move the card to "todo" instead - it is promoted to "ready" once its parents are done.`
		);
	}
	const boards = loadBoards(projectRoot);
	const board = requireBoard(boards, boardId);
	const card = board.cards.find((c) => c.id === cardId);
	if (!card) {
		throw new Error(`updateCardStatus: card "${cardId}" not found on board "${boardId}"`);
	}
	card.status = status;
	card.updatedAt = nowIso();
	saveBoards(projectRoot, boards);
	return board;
}

/**
 * Replace a card in place (used for edits to title/body/assignee/parents/etc.).
 * Stamps `updatedAt`, preserves `createdAt`, and rejects if the edit would
 * introduce a cycle. Throws if the board or card is missing. Returns the
 * updated board.
 */
export function updateCard(projectRoot: string, boardId: string, card: BoardCard): Board {
	const boards = loadBoards(projectRoot);
	const board = requireBoard(boards, boardId);
	const index = board.cards.findIndex((c) => c.id === card.id);
	if (index < 0) {
		throw new Error(`updateCard: card "${card.id}" not found on board "${boardId}"`);
	}
	const validated = validateBoardCard(
		{ ...card, createdAt: card.createdAt || board.cards[index].createdAt, updatedAt: nowIso() },
		nowIso()
	);
	if (!validated) {
		throw new Error('updateCard: invalid card shape');
	}
	board.cards[index] = validated;
	saveBoards(projectRoot, boards);
	return board;
}

/**
 * Delete a card from a board by id, keeping the DAG referentially intact.
 * Returns the updated board. A no-op (and no write) when no card matches.
 * Throws if the board is missing.
 *
 * Referential integrity, in two parts:
 *
 *  1. **Detach.** The deleted id is spliced out of every other card's `parents`.
 *     `getBlockers` and `getEligibleCards` treat a parent id with no matching
 *     card as a permanent blocker (deliberately - a dependency that does not
 *     exist yet cannot be satisfied), so leaving the dangling id behind wedged
 *     every child of a deleted card forever, with nothing in the UI explaining
 *     why they never promoted.
 *
 *  2. **Grandparent adoption.** The deleted card's own parents are reattached to
 *     its children. Deleting a middle card would otherwise sever the ordering it
 *     encoded (`A -> B -> C`, delete `B`, and `C` becomes runnable before `A` is
 *     done). Adoption preserves reachability, and cannot introduce a cycle: the
 *     new edges are a subset of paths that already existed through the deleted
 *     card, so an acyclic board stays acyclic.
 *
 * A card is never made its own parent (a self-edge, if the deleted card somehow
 * listed one of its own children as a parent).
 */
export function deleteCard(projectRoot: string, boardId: string, cardId: string): Board {
	const boards = loadBoards(projectRoot);
	const board = requireBoard(boards, boardId);
	const doomed = board.cards.find((c) => c.id === cardId);
	if (!doomed) return board;

	const inheritedParents = doomed.parents.filter((id) => id !== cardId);
	board.cards = board.cards.filter((c) => c.id !== cardId);
	for (const card of board.cards) {
		if (!card.parents.includes(cardId)) continue;
		const rest = card.parents.filter((id) => id !== cardId);
		card.parents = Array.from(new Set([...rest, ...inheritedParents])).filter(
			(id) => id !== card.id
		);
		card.updatedAt = nowIso();
	}
	saveBoards(projectRoot, boards);
	return board;
}
