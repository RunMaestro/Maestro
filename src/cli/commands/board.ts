/**
 * `maestro-cli board` - drive the persistent Board (task DAG) headlessly.
 *
 * Mirrors the `board:*` IPC surface by delegating to the SAME Electron-free
 * storage module the desktop handlers use (`src/main/board/board-storage`), so
 * CLI and desktop never drift. Every command needs a project root, resolved
 * from a target agent (`--agent <id-or-name>` -> that agent's `projectRoot`).
 *
 * `board tick` runs one dispatcher pass headlessly. It reuses the PURE
 * orchestration helpers from the Phase 3 dispatcher (promote / claim / apply)
 * and the existing CLI spawn path (`spawnAgent`) - it does not fork a second
 * spawn implementation. SSH remote config and profile model/effort/role
 * overrides are honored exactly as the desktop dispatcher honors them.
 */

import { generateUUID } from '../../shared/uuid';
import {
	listBoards,
	getBoard,
	createBoard,
	renameBoard,
	deleteBoard,
	addCard,
	updateCard,
	updateCardStatus,
	deleteCard,
	saveBoard,
} from '../../main/board/board-storage';
import type { Board, BoardCard, CardStatus } from '../../shared/board/types';
import { CARD_PRIORITIES, CARD_STATUSES } from '../../shared/board/types';
import { getBlockers } from '../../shared/board/graph';
import { CARD_HANDOFF_REMINDER } from '../../shared/board/cardMarkers';
import {
	promoteEligibleCards,
	claimReadyCardsPooled,
	applyCardResult,
	reclaimStaleRunning,
	DEFAULT_MAX_IN_PROGRESS,
	DEFAULT_MAX_FAILURES,
	DEFAULT_STALE_RUNNING_MS,
	type CardAssignment,
	type CardSpawnResult,
} from '../../main/board/board-dispatcher';
import {
	resolveProfileSpawnOverrides,
	type ProfileBaseAgentValues,
	type ProfileSpawnOverrides,
} from '../../shared/profiles/types';
import { selectPoolAgentIds } from '../../shared/board/pool';
import { buildCardWorktreeRef } from '../../shared/board/worktree';
import { ensureCardWorktree, WORKTREE_SSH_UNSUPPORTED } from '../../main/board/board-worktree';
import { listProfiles } from '../../main/profiles/profile-storage';
import { autoDecomposeBoard, type DecomposeSpawn } from '../../main/board/board-decompose';
import { readSessions, getSessionById, resolveAgentId } from '../services/storage';
import { spawnAgent } from '../services/agent-spawner';
import { getCliPrompt } from '../services/prompt-loader';
import { PROMPT_IDS } from '../../shared/promptDefinitions';
import { formatError, formatSuccess, formatWarning } from '../output/formatter';
import type { SessionInfo, ToolType } from '../../shared/types';

interface BoardCommonOptions {
	agent: string;
	json?: boolean;
}

interface BoardShowOptions extends BoardCommonOptions {}

interface BoardCreateOptions extends BoardCommonOptions {
	/** `--max-in-progress <n>`: WIP cap for the dispatcher. Commander hands strings. */
	maxInProgress?: string;
	/** `--auto-decompose`: opt the board into the LLM triage fan-out pass. */
	autoDecompose?: boolean;
}

interface BoardDeleteOptions extends BoardCommonOptions {
	/** `--force`: delete even when the board still has cards that are not done. */
	force?: boolean;
}

interface BoardAddCardOptions extends BoardCommonOptions {
	title: string;
	body?: string;
	/** Role profile id (`--assignee`). Optional if `assigneeAgent` is set. */
	assignee?: string;
	/** Pinned agent id (`--assignee-agent`). Optional if `assignee` is set. */
	assigneeAgent?: string;
	parents?: string;
	/** Dispatch priority (`--priority high|normal|low`). Defaults to normal. */
	priority?: string;
	worktree?: boolean;
}

interface BoardUpdateCardOptions extends BoardCommonOptions {
	board?: string;
	title?: string;
	body?: string;
	/** Role profile id. An explicit empty string clears it. */
	assignee?: string;
	/** Pinned agent id. An explicit empty string clears it. */
	assigneeAgent?: string;
	/** Comma-separated parent ids. An explicit empty string clears them all. */
	parents?: string;
	priority?: string;
	/** `--worktree` records the advisory ref, `--no-worktree` clears it. */
	worktree?: boolean;
}

interface BoardRemoveCardOptions extends BoardCommonOptions {
	board?: string;
	/** `--force`: allow removing a card that is currently `running`. */
	force?: boolean;
}

interface BoardSetStatusOptions extends BoardCommonOptions {
	board?: string;
}

interface BoardTickOptions extends BoardCommonOptions {
	board?: string;
}

interface BoardWatchOptions extends BoardTickOptions {
	/** Seconds between ticks (`--interval`). Commander hands strings. */
	interval?: string;
}

/** Default seconds between `board watch` ticks. */
export const DEFAULT_WATCH_INTERVAL_SECONDS = 30;
/** Floor for `--interval`: below this the loop spends its life re-reading YAML. */
export const MIN_WATCH_INTERVAL_SECONDS = 5;

/** Print an error (JSON or human-readable) and exit non-zero. Called once, at
 * each command's boundary, so a mocked `process.exit` in tests never continues
 * into post-error code (matches the repo's try/catch-at-boundary convention). */
function reportError(error: unknown, json: boolean | undefined): never {
	const message = error instanceof Error ? error.message : String(error);
	if (json) {
		console.log(JSON.stringify({ type: 'error', error: message }));
	} else {
		console.error(formatError(message));
	}
	process.exit(1);
}

/** Resolve `--agent` (id or name) to a session. Throws on missing/not-found. */
function resolveAgentSession(partial: string | undefined): SessionInfo {
	if (!partial || !partial.trim()) {
		throw new Error('An agent is required (--agent <id-or-name>).');
	}
	const id = resolveAgentId(partial);
	const session = getSessionById(id);
	if (!session) throw new Error(`Agent "${partial}" not found.`);
	return session;
}

/** `board list --agent <id>` - list boards in the agent's project. */
export async function boardList(options: BoardCommonOptions): Promise<void> {
	try {
		const session = resolveAgentSession(options.agent);
		const boards = listBoards(session.projectRoot);

		if (options.json) {
			console.log(JSON.stringify(boards, null, 2));
			return;
		}
		if (boards.length === 0) {
			console.log('No boards found.');
			return;
		}
		const lines: string[] = [`Boards (${boards.length}):\n`];
		for (const b of boards) {
			const byStatus = countByStatus(b);
			const cap = b.maxInProgress ? `  |  WIP cap: ${b.maxInProgress}` : '';
			lines.push(`  ${b.name}  [${b.id.slice(0, 8)}]`);
			lines.push(`     ${b.cards.length} card(s)  |  ${byStatus}${cap}`);
			lines.push('');
		}
		console.log(lines.join('\n'));
	} catch (error) {
		reportError(error, options.json);
	}
}

/**
 * `board create <name> --agent <id>` - stand up a new, empty board.
 *
 * The bootstrap command for a pure CLI/CI workflow: without it a headless user
 * had to open the desktop app once to get a board id to add cards to. Goes
 * through the same `createBoard` storage function the `board:create` IPC handler
 * uses, so the two can never drift.
 */
export async function boardCreate(name: string, options: BoardCreateOptions): Promise<void> {
	try {
		const session = resolveAgentSession(options.agent);
		const trimmed = (name ?? '').trim();
		if (!trimmed) throw new Error('A board name is required (board create <name>).');

		// Validate the cap here rather than letting a typo silently become "no cap":
		// a board the user believes is capped at 3 running everything at once is the
		// kind of surprise that costs real tokens.
		let maxInProgress: number | undefined;
		const rawCap = (options.maxInProgress ?? '').toString().trim();
		if (rawCap) {
			const parsed = Number(rawCap);
			if (!Number.isInteger(parsed) || parsed < 1) {
				throw new Error(`Invalid --max-in-progress "${rawCap}". Use a positive integer.`);
			}
			maxInProgress = parsed;
		}

		const board = createBoard(session.projectRoot, trimmed, {
			maxInProgress,
			autoDecompose: options.autoDecompose === true,
		});

		if (options.json) {
			console.log(JSON.stringify(board, null, 2));
			return;
		}
		console.log(formatSuccess(`Created board "${board.name}".`));
		console.log(board.id);
	} catch (error) {
		reportError(error, options.json);
	}
}

/** `board rename <boardId> <newName> --agent <id>` - rename a board in place. */
export async function boardRename(
	boardId: string,
	newName: string,
	options: BoardCommonOptions
): Promise<void> {
	try {
		const session = resolveAgentSession(options.agent);
		const board = resolveBoard(session.projectRoot, boardId);
		const trimmed = (newName ?? '').trim();
		if (!trimmed) throw new Error('A new board name is required (board rename <boardId> <name>).');

		const previous = board.name;
		const renamed = renameBoard(session.projectRoot, board.id, trimmed);

		if (options.json) {
			console.log(JSON.stringify(renamed, null, 2));
			return;
		}
		console.log(formatSuccess(`Renamed board "${previous}" to "${renamed.name}".`));
	} catch (error) {
		reportError(error, options.json);
	}
}

/**
 * `board delete <boardId> --agent <id> [--force]` - delete a board and its cards.
 *
 * The guard rail (refuse when any card is not `done`) lives in the storage layer
 * so the desktop path gets it too; this command just surfaces it and forwards
 * `--force`.
 */
export async function boardDelete(boardId: string, options: BoardDeleteOptions): Promise<void> {
	try {
		const session = resolveAgentSession(options.agent);
		const board = resolveBoard(session.projectRoot, boardId);
		const remaining = deleteBoard(session.projectRoot, board.id, { force: options.force === true });

		if (options.json) {
			console.log(
				JSON.stringify(
					{ deleted: board.id, cards: board.cards.length, remaining: remaining.length },
					null,
					2
				)
			);
			return;
		}
		console.log(
			formatSuccess(
				`Deleted board "${board.name}" (${board.id.slice(0, 8)}) and its ${board.cards.length} card(s).`
			)
		);
	} catch (error) {
		reportError(error, options.json);
	}
}

/** `board show <boardId> --agent <id>` - print a board and its cards. */
export async function boardShow(boardId: string, options: BoardShowOptions): Promise<void> {
	try {
		const session = resolveAgentSession(options.agent);
		const board = resolveBoard(session.projectRoot, boardId);

		if (options.json) {
			console.log(JSON.stringify(board, null, 2));
			return;
		}
		const lines: string[] = [`${board.name}  [${board.id.slice(0, 8)}]`];
		lines.push(`${board.cards.length} card(s)  |  ${countByStatus(board)}`);
		lines.push('');
		for (const card of board.cards) {
			lines.push(`  [${card.status}]  ${card.title}  (${card.id.slice(0, 8)})`);
			lines.push(`     assignee: ${assigneeLabel(card)}`);
			if (card.parents.length > 0) {
				const blockers = getBlockers(card, board);
				const parentList = card.parents.map((p) => p.slice(0, 8)).join(', ');
				lines.push(
					`     parents: ${parentList}${blockers.length > 0 ? `  (waiting on ${blockers.length})` : ''}`
				);
			}
			const latest = card.runs?.[card.runs.length - 1];
			if (latest?.summary) {
				const s = latest.summary.replace(/\s+/g, ' ').trim();
				lines.push(`     last run: ${s.length > 100 ? `${s.slice(0, 97)}...` : s}`);
			}
			lines.push('');
		}
		console.log(lines.join('\n'));
	} catch (error) {
		reportError(error, options.json);
	}
}

/** `board add-card <boardId> --title ... --assignee ...` - append a card. */
export async function boardAddCard(boardId: string, options: BoardAddCardOptions): Promise<void> {
	try {
		const session = resolveAgentSession(options.agent);
		const board = resolveBoard(session.projectRoot, boardId);

		const title = (options.title ?? '').trim();
		if (!title) throw new Error('A card title is required (--title <title>).');
		// Board Phase 6: a card names a role (--assignee <profileId>) and/or pins a
		// specific agent (--assignee-agent <agentId>). At least one is required. A
		// role-only card floats to the free opt-in worker pool; an agent-only card
		// runs on that agent with its own settings.
		const assignee = (options.assignee ?? '').trim();
		const assigneeAgent = (options.assigneeAgent ?? '').trim();
		if (!assignee && !assigneeAgent) {
			throw new Error(
				'An assignee is required: --assignee <profileId> (role) and/or --assignee-agent <agentId> (pin).'
			);
		}

		const parents = parseParents(options.parents);

		// Priority is optional and validated up front: a typo must not silently
		// become a normal-priority card the user thinks is high.
		const priority = parsePriority(options.priority);

		const now = new Date().toISOString();
		const cardId = generateUUID();
		const card: BoardCard = {
			id: cardId,
			title,
			body: options.body ?? '',
			parents,
			status: 'todo',
			createdAt: now,
			updatedAt: now,
		};
		if (assignee) card.assigneeProfileId = assignee;
		if (assigneeAgent) card.assigneeAgentId = assigneeAgent;
		// `normal` is the default and is never serialized.
		if (priority === 'high' || priority === 'low') card.priority = priority;
		if (options.worktree)
			card.worktree = buildCardWorktreeRef(session.projectRoot, board.id, cardId);

		addCard(session.projectRoot, board.id, card);

		if (options.json) {
			console.log(JSON.stringify(card, null, 2));
			return;
		}
		console.log(
			formatSuccess(`Added card "${title}" (${cardId.slice(0, 8)}) to board "${board.name}".`)
		);
	} catch (error) {
		reportError(error, options.json);
	}
}

/**
 * `board update-card <cardId> [--title ...] [--body ...] ...` - edit a card.
 *
 * Goes through the same `updateCard` storage path as the desktop editor, so
 * validation and cycle rejection come for free (a `--parents` edit that would
 * close a loop is refused by `saveBoards`). Only the flags actually passed are
 * touched; an explicitly empty `--assignee ''` / `--parents ''` clears that
 * field. Editing a `running` card is refused: the dispatcher is mid-flight with
 * the old title/body, and the finished run would be applied to a card the author
 * has since redefined.
 */
export async function boardUpdateCard(
	cardId: string,
	options: BoardUpdateCardOptions
): Promise<void> {
	try {
		const session = resolveAgentSession(options.agent);
		const located = locateCard(session.projectRoot, cardId, options.board);
		const { board, card } = located;
		if (card.status === 'running') {
			throw new Error(
				`Card "${card.title}" (${card.id.slice(0, 8)}) is running and cannot be edited. ` +
					`Stop it first (desktop stop button), or wait for the run to finish.`
			);
		}

		const next: BoardCard = { ...card, parents: [...card.parents] };
		let changed = false;

		if (options.title !== undefined) {
			const title = options.title.trim();
			if (!title) throw new Error('--title cannot be empty.');
			next.title = title;
			changed = true;
		}
		if (options.body !== undefined) {
			next.body = options.body;
			changed = true;
		}
		if (options.assignee !== undefined) {
			const value = options.assignee.trim();
			if (value) next.assigneeProfileId = value;
			else delete next.assigneeProfileId;
			changed = true;
		}
		if (options.assigneeAgent !== undefined) {
			const value = options.assigneeAgent.trim();
			if (value) next.assigneeAgentId = value;
			else delete next.assigneeAgentId;
			changed = true;
		}
		// A card with no assignee at all fails validation deep inside storage with
		// "invalid card shape"; say what actually went wrong instead.
		if (!next.assigneeProfileId && !next.assigneeAgentId) {
			throw new Error(
				'A card must keep an assignee: --assignee <profileId> and/or --assignee-agent <agentId>.'
			);
		}
		if (options.parents !== undefined) {
			next.parents = parseParents(options.parents);
			changed = true;
		}
		if (options.priority !== undefined) {
			const priority = parsePriority(options.priority);
			// `normal` is the default and is never serialized, so it clears the field.
			if (priority === 'high' || priority === 'low') next.priority = priority;
			else delete next.priority;
			changed = true;
		}
		if (options.worktree === true) {
			next.worktree = buildCardWorktreeRef(session.projectRoot, board.id, card.id);
			changed = true;
		} else if (options.worktree === false) {
			delete next.worktree;
			changed = true;
		}

		if (!changed) {
			throw new Error(
				'Nothing to update. Pass at least one of --title, --body, --assignee, ' +
					'--assignee-agent, --parents, --priority, --worktree/--no-worktree.'
			);
		}

		updateCard(session.projectRoot, board.id, next);

		if (options.json) {
			const fresh = getBoard(session.projectRoot, board.id);
			console.log(JSON.stringify(fresh?.cards.find((c) => c.id === next.id) ?? next, null, 2));
			return;
		}
		console.log(formatSuccess(`Updated card "${next.title}" (${next.id.slice(0, 8)}).`));
	} catch (error) {
		reportError(error, options.json);
	}
}

/**
 * `board remove-card <cardId> [--force]` - delete a card.
 *
 * Reuses the storage `deleteCard`, which keeps the DAG intact (children of the
 * removed card inherit its parents). A `running` card needs `--force`: the CLI
 * has no handle on the in-flight process (it belongs to whatever dispatcher
 * claimed the card, in another process entirely), so it cannot cancel it first
 * and says so rather than pretending the agent was stopped.
 */
export async function boardRemoveCard(
	cardId: string,
	options: BoardRemoveCardOptions
): Promise<void> {
	try {
		const session = resolveAgentSession(options.agent);
		const { board, card } = locateCard(session.projectRoot, cardId, options.board);

		if (card.status === 'running' && !options.force) {
			throw new Error(
				`Card "${card.title}" (${card.id.slice(0, 8)}) is running. Stop it from the desktop ` +
					`Board first, or re-run with --force (the CLI cannot cancel the in-flight run).`
			);
		}

		const dependents = board.cards.filter((c) => c.parents.includes(card.id));
		deleteCard(session.projectRoot, board.id, card.id);

		if (options.json) {
			console.log(
				JSON.stringify(
					{
						removed: card.id,
						board: board.id,
						wasRunning: card.status === 'running',
						reparented: dependents.map((c) => c.id),
					},
					null,
					2
				)
			);
			return;
		}
		if (card.status === 'running') {
			console.log(
				formatWarning(
					'The card was running. Its agent process is owned by another process and keeps going; stop it there if it is still live.'
				)
			);
		}
		const inherited =
			dependents.length > 0 ? ` ${dependents.length} dependent card(s) inherited its parents.` : '';
		console.log(
			formatSuccess(`Removed card "${card.title}" (${card.id.slice(0, 8)}).${inherited}`)
		);
	} catch (error) {
		reportError(error, options.json);
	}
}

/** `board set-status <cardId> <status> --agent <id>` - move a card. */
export async function boardSetStatus(
	cardId: string,
	status: string,
	options: BoardSetStatusOptions
): Promise<void> {
	try {
		const session = resolveAgentSession(options.agent);
		if (!(CARD_STATUSES as readonly string[]).includes(status)) {
			throw new Error(`Invalid status "${status}". Valid: ${CARD_STATUSES.join(', ')}.`);
		}

		const located = locateCard(session.projectRoot, cardId, options.board);
		updateCardStatus(session.projectRoot, located.board.id, located.card.id, status as CardStatus);

		if (options.json) {
			console.log(
				JSON.stringify({ card: located.card.id, board: located.board.id, status }, null, 2)
			);
			return;
		}
		console.log(
			formatSuccess(`Card "${located.card.title}" (${located.card.id.slice(0, 8)}) -> ${status}.`)
		);
	} catch (error) {
		reportError(error, options.json);
	}
}

/** `board tick --agent <id> [--board <id>]` - run one dispatcher pass headlessly. */
export async function boardTick(options: BoardTickOptions): Promise<void> {
	try {
		const session = resolveAgentSession(options.agent);
		const summaries = await tickBoardsOnce(session.projectRoot, options.board, options.json);
		if (summaries.length === 0) {
			if (options.json) console.log(JSON.stringify({ type: 'tick', boards: [] }));
			else console.log('No boards to tick.');
			return;
		}

		if (options.json) {
			console.log(JSON.stringify({ type: 'tick', boards: summaries }, null, 2));
			return;
		}
		for (const s of summaries) {
			console.log(`Board "${s.name}" [${s.boardId.slice(0, 8)}]:`);
			console.log(
				`  promoted: ${s.promoted}  |  decomposed: ${s.decomposed}  |  ran: ${s.ran}  |  done: ${s.done}  |  blocked: ${s.blocked}`
			);
			for (const note of s.notes) console.log(`  - ${note}`);
		}
	} catch (error) {
		reportError(error, options.json);
	}
}

/**
 * `board watch --agent <id> [--interval <seconds>] [--board <id>]`
 *
 * A deliberately dumb loop over the same single-tick pass `board tick` runs: no
 * daemonization, no lock file, no PID file. It exists so a CI box or a headless
 * host can keep a board moving without the desktop app open. Stops on SIGINT.
 *
 * A storage failure is fatal by design: after Phase 1, `loadBoards` throws
 * rather than silently returning `[]` for a damaged board.yaml, and a watcher
 * that shrugged that off would spin forever on a file no human is looking at.
 * It exits non-zero so a supervisor notices.
 */
export async function boardWatch(options: BoardWatchOptions): Promise<void> {
	let projectRoot: string;
	let intervalMs: number;
	try {
		projectRoot = resolveAgentSession(options.agent).projectRoot;
		intervalMs = parseWatchInterval(options.interval) * 1000;
	} catch (error) {
		return reportError(error, options.json);
	}

	// SIGINT sets the flag AND wakes an in-progress sleep, so Ctrl-C is felt
	// immediately instead of after the rest of the interval.
	let stopped = false;
	let wake: (() => void) | null = null;
	const onSigint = () => {
		stopped = true;
		wake?.();
	};
	process.on('SIGINT', onSigint);

	if (!options.json) {
		console.log(
			`Watching board(s) every ${intervalMs / 1000}s. Press Ctrl-C to stop.\n` +
				'Note: the desktop Cue engine ticks the same boards. Overlapping runs are safe ' +
				'(board.yaml writes are atomic and serialized), but running both is still discouraged.'
		);
	}

	try {
		while (!stopped) {
			try {
				const summaries = await tickBoardsOnce(projectRoot, options.board, options.json);
				printWatchTick(summaries, options.json);
			} catch (error) {
				return reportError(error, options.json);
			}
			if (stopped) break;
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					wake = null;
					resolve();
				}, intervalMs);
				wake = () => {
					clearTimeout(timer);
					wake = null;
					resolve();
				};
			});
		}
	} finally {
		process.off('SIGINT', onSigint);
	}

	if (!options.json) console.log('Board watch stopped.');
}

/** Validate `--interval`, defaulting and enforcing the floor. Returns seconds. */
function parseWatchInterval(raw: string | undefined): number {
	const value = (raw ?? '').toString().trim();
	if (!value) return DEFAULT_WATCH_INTERVAL_SECONDS;
	const seconds = Number(value);
	if (!Number.isFinite(seconds) || !Number.isInteger(seconds)) {
		throw new Error(`Invalid --interval "${raw}". Use a whole number of seconds.`);
	}
	if (seconds < MIN_WATCH_INTERVAL_SECONDS) {
		throw new Error(`--interval must be at least ${MIN_WATCH_INTERVAL_SECONDS} seconds.`);
	}
	return seconds;
}

/** One line per board per tick (or one JSON object per tick when `--json`). */
function printWatchTick(summaries: TickSummary[], json: boolean | undefined): void {
	const at = new Date().toISOString();
	if (json) {
		console.log(JSON.stringify({ type: 'watch-tick', at, boards: summaries }));
		return;
	}
	if (summaries.length === 0) {
		console.log(`[${at}] no boards`);
		return;
	}
	for (const s of summaries) {
		console.log(
			`[${at}] ${s.name}: promoted ${s.promoted}  |  claimed ${s.ran}  |  done ${s.done}  |  blocked ${s.blocked}`
		);
	}
}

// ─── Headless dispatch (reuses the Phase 3 pure helpers) ─────────────────────

/**
 * Run one dispatch pass across every board in the project (or just `boardHint`).
 * Shared by `board tick` (one pass, then exit) and `board watch` (the same pass
 * on a timer) so the two can never drift. Returns an empty array when the
 * project has no boards. Storage failures propagate (fail-closed, Phase 1).
 */
async function tickBoardsOnce(
	projectRoot: string,
	boardHint: string | undefined,
	json: boolean | undefined
): Promise<TickSummary[]> {
	let boards = listBoards(projectRoot);
	if (boardHint) {
		boards = [resolveBoard(projectRoot, boardHint)];
	}
	if (boards.length === 0) return [];

	const sessions = readSessions();
	// Load the editable decompose template once; only used when a board opts in.
	const decomposeTemplate = boards.some((b) => b.autoDecompose)
		? await getCliPrompt(PROMPT_IDS.BOARD_DECOMPOSE).catch(() => undefined)
		: undefined;

	const summaries: TickSummary[] = [];
	for (const board of boards) {
		summaries.push(await tickBoard(projectRoot, board.id, sessions, decomposeTemplate, json));
	}
	return summaries;
}

interface TickSummary {
	boardId: string;
	name: string;
	promoted: number;
	decomposed: number;
	ran: number;
	done: number;
	blocked: number;
	notes: string[];
}

/**
 * Run one headless dispatch pass for a single board: reclaim stale -> promote
 * -> (optional) auto-decompose -> claim up to the WIP cap -> spawn each claimed
 * card (awaited) -> apply markers/exit-status. Persists after each mutation so a
 * subsequent `board tick` observes the new state, mirroring the desktop engine.
 */
async function tickBoard(
	projectRoot: string,
	boardId: string,
	sessions: SessionInfo[],
	decomposeTemplate: string | undefined,
	json: boolean | undefined
): Promise<TickSummary> {
	const summary: TickSummary = {
		boardId,
		name: '',
		promoted: 0,
		decomposed: 0,
		ran: 0,
		done: 0,
		blocked: 0,
		notes: [],
	};

	let board = getBoard(projectRoot, boardId);
	if (!board) {
		summary.notes.push('board disappeared');
		return summary;
	}
	summary.name = board.name;

	const nowIso = new Date().toISOString();

	// 1. Reclaim stale running cards (no live CLI processes across ticks).
	const reclaimed = reclaimStaleRunning(
		board,
		new Set<string>(),
		DEFAULT_STALE_RUNNING_MS,
		Date.now(),
		nowIso
	);

	// 2. Optional auto-decompose (off by default; gated on board.autoDecompose).
	const decomposed = await autoDecomposeBoard(board, {
		spawn: makeDecomposeSpawn(projectRoot, sessions),
		promptTemplate: decomposeTemplate,
		now: () => new Date().toISOString(),
		onLog: (level, message) => {
			if (!json && level !== 'info') console.error(`  [decompose] ${message}`);
		},
	});
	summary.decomposed = decomposed;

	// 3. Promote eligible todo cards to ready.
	const promoted = promoteEligibleCards(board, nowIso);
	summary.promoted = promoted.length;

	// 4. Claim ready cards to FREE pool workers up to the WIP cap (Phase 6).
	const cap = board.maxInProgress ?? DEFAULT_MAX_IN_PROGRESS;
	const { claimed, unresolvable } = claimReadyCardsPooled(board, cap, nowIso, (card, busy) =>
		resolveCliAssignment(projectRoot, card, busy, sessions)
	);

	// Force-block cards that named a missing profile/agent (config error).
	for (const { card, reason } of unresolvable) {
		const target = board.cards.find((c) => c.id === card.id);
		if (!target) continue;
		target.status = 'blocked';
		target.updatedAt = nowIso;
		target.runs = [
			...(target.runs ?? []),
			{
				attempt: (target.runs?.length ?? 0) + 1,
				startedAt: nowIso,
				endedAt: nowIso,
				outcome: 'error',
				summary: reason ?? 'Assignee could not be resolved.',
			},
		];
		summary.blocked++;
		summary.notes.push(
			`${card.title} (${card.id.slice(0, 8)}) -> blocked (${reason ?? 'unresolvable'})`
		);
	}

	// Persist BEFORE spawning so a crash / next tick sees the cards as running.
	if (
		reclaimed.length > 0 ||
		decomposed > 0 ||
		promoted.length > 0 ||
		claimed.length > 0 ||
		unresolvable.length > 0
	) {
		saveBoard(projectRoot, board);
	}

	// 5. Spawn each claimed card on its chosen worker, await, and apply its result.
	for (const { card, agentId, overrides } of claimed) {
		summary.ran++;
		const base = sessions.find((s) => s.id === agentId);
		const result = base
			? await spawnCard(projectRoot, card, base, overrides)
			: {
					output: '',
					exitCode: null,
					error: `Board card "${card.id}": worker agent "${agentId}" not found.`,
				};
		// Reload fresh so we don't clobber concurrent edits between claim and finish.
		const fresh = getBoard(projectRoot, boardId);
		if (!fresh) break;
		const status = applyCardResult(
			fresh,
			card.id,
			result,
			new Date().toISOString(),
			DEFAULT_MAX_FAILURES
		);
		saveBoard(projectRoot, fresh);
		if (status === 'done') summary.done++;
		else if (status === 'blocked') summary.blocked++;
		summary.notes.push(`${card.title} (${card.id.slice(0, 8)}) -> ${status}`);
		board = fresh;
	}

	return summary;
}

/**
 * Resolve a card to a FREE pool worker for the CLI `board tick` (Board Phase 6).
 * Mirrors the desktop `resolveCardAssignment`: a named-but-missing profile is a
 * config error; a pinned agent (`assigneeAgentId` or a legacy profile's
 * `baseAgentId`) yields a single candidate; a role-only card floats to the
 * opt-in project pool. The first non-busy candidate wins.
 */
function resolveCliAssignment(
	projectRoot: string,
	card: BoardCard,
	busyAgentIds: ReadonlySet<string>,
	sessions: SessionInfo[]
): CardAssignment {
	let profile;
	if (card.assigneeProfileId) {
		profile = listProfiles(projectRoot).find((p) => p.id === card.assigneeProfileId);
		if (!profile) {
			return { kind: 'unresolvable', reason: `Profile "${card.assigneeProfileId}" not found.` };
		}
	}

	const pinnedId = card.assigneeAgentId ?? profile?.baseAgentId;
	const candidates = pinnedId
		? [pinnedId]
		: selectPoolAgentIds(
				projectRoot,
				sessions.map((s) => ({
					id: s.id,
					dir: s.projectRoot,
					boardWorker: s.boardWorker === true,
				}))
			);
	if (candidates.length === 0) return { kind: 'no-free-worker' };

	const chosen = candidates.find((id) => !busyAgentIds.has(id));
	if (!chosen) return { kind: 'no-free-worker' };

	const base = sessions.find((s) => s.id === chosen);
	if (!base) return { kind: 'unresolvable', reason: `Agent "${chosen}" not found.` };

	const baseValues: ProfileBaseAgentValues = {
		customModel: base.customModel,
		customEffort: base.customEffort,
		customArgs: base.customArgs,
		appendSystemPrompt: (base as unknown as { appendSystemPrompt?: string }).appendSystemPrompt,
	};
	const overrides: ProfileSpawnOverrides = profile
		? resolveProfileSpawnOverrides(profile, baseValues)
		: {
				customModel: baseValues.customModel,
				customEffort: baseValues.customEffort,
				appendSystemPrompt: baseValues.appendSystemPrompt,
				customArgs: baseValues.customArgs,
			};
	return { kind: 'assigned', agentId: chosen, overrides };
}

/**
 * Run a claimed card's assignee through the CLI spawn path (`spawnAgent`) on the
 * resolved base session, honoring SSH + role model/effort/args overrides. Returns
 * a {@link CardSpawnResult} the pure `applyCardResult` can evaluate for markers /
 * exit status.
 */
async function spawnCard(
	projectRoot: string,
	card: BoardCard,
	base: SessionInfo,
	overrides: ProfileSpawnOverrides
): Promise<CardSpawnResult> {
	// The role/system prompt is prepended to the card prompt (parity with the
	// desktop board-spawn path, whose Cue executor has no system-prompt field).
	const rolePreamble = overrides.appendSystemPrompt
		? `${overrides.appendSystemPrompt}\n\n${CARD_HANDOFF_REMINDER}\n\n---\n\n`
		: `${CARD_HANDOFF_REMINDER}\n\n---\n\n`;
	const prompt = `${rolePreamble}${card.title}\n\n${card.body}`.trim();

	// Phase 4: a card that opted into isolation runs in its own checkout, created
	// on first claim and reused by later attempts. Same provisioning helper the
	// desktop path uses, so CLI and desktop cannot drift. A failure blocks the
	// card rather than silently sharing the project root with other cards.
	let worktree: { path: string; branch: string } | undefined;
	if (card.worktree) {
		if (base.sessionSshRemoteConfig?.enabled) {
			return { output: `<!-- maestro:card-block: ${WORKTREE_SSH_UNSUPPORTED} -->`, exitCode: 0 };
		}
		const ensured = await ensureCardWorktree(projectRoot, card.worktree);
		if (!ensured.ok) {
			return {
				output: `<!-- maestro:card-block: Card worktree unavailable: ${ensured.reason} -->`,
				exitCode: 0,
			};
		}
		worktree = { path: ensured.path, branch: ensured.branch };
	}

	const result = await spawnAgent(
		base.toolType as ToolType,
		worktree?.path ?? projectRoot,
		prompt,
		undefined,
		{
			customModel: overrides.customModel,
			customEffort: overrides.customEffort,
			customArgs: overrides.customArgs,
			customEnvVars: base.customEnvVars,
			sshRemoteConfig: base.sessionSshRemoteConfig,
			enableMaestroP: base.enableMaestroP,
			maestroPMode: base.maestroPMode,
			maestroPPath: base.maestroPPath,
		}
	);

	return {
		output: result.response ?? '',
		exitCode: result.success ? 0 : 1,
		error: result.success ? undefined : result.error,
		...(worktree ? { worktreePath: worktree.path, worktreeBranch: worktree.branch } : {}),
	};
}

/** Build the auto-decompose spawn callback backed by the CLI spawn path. */
function makeDecomposeSpawn(projectRoot: string, sessions: SessionInfo[]): DecomposeSpawn {
	return async (prompt: string, triageCard: BoardCard) => {
		const assignment = resolveCliAssignment(projectRoot, triageCard, new Set(), sessions);
		// Decomposition just needs any capable model: prefer the resolved worker,
		// else fall back to the first agent in the project.
		const chosenId = assignment.kind === 'assigned' ? assignment.agentId : undefined;
		const base =
			(chosenId ? sessions.find((s) => s.id === chosenId) : undefined) ??
			sessions.find((s) => s.projectRoot === projectRoot);
		if (!base) return null;
		const overrides = assignment.kind === 'assigned' ? assignment.overrides : undefined;
		const result = await spawnAgent(base.toolType as ToolType, projectRoot, prompt, undefined, {
			customModel: overrides?.customModel,
			customEffort: overrides?.customEffort,
			customEnvVars: base.customEnvVars,
			sshRemoteConfig: base.sessionSshRemoteConfig,
			enableMaestroP: base.enableMaestroP,
			maestroPMode: base.maestroPMode,
			maestroPPath: base.maestroPPath,
		});
		return result.success ? (result.response ?? '') : null;
	};
}

// ─── Small helpers ───────────────────────────────────────────────────────────

/** Split a `--parents a,b,c` value into trimmed, non-empty ids. */
function parseParents(raw: string | undefined): string[] {
	return (raw ?? '')
		.split(',')
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
}

/**
 * Normalize a `--priority` value, throwing on a typo. Returns `''` when the flag
 * was not passed; callers treat `normal` as "clear the field" since the default
 * is never serialized.
 */
function parsePriority(raw: string | undefined): string {
	const priority = (raw ?? '').trim().toLowerCase();
	if (priority && !(CARD_PRIORITIES as readonly string[]).includes(priority)) {
		throw new Error(`Invalid --priority "${raw}". Use one of: high, normal, low.`);
	}
	return priority;
}

/** Short human-facing assignee label: role profile and/or pinned agent. */
function assigneeLabel(card: BoardCard): string {
	const parts: string[] = [];
	if (card.assigneeProfileId) parts.push(`role ${card.assigneeProfileId.slice(0, 8)}`);
	if (card.assigneeAgentId) parts.push(`agent ${card.assigneeAgentId.slice(0, 8)}`);
	return parts.join(' + ') || '(pool)';
}

function countByStatus(board: Board): string {
	const counts = new Map<CardStatus, number>();
	for (const card of board.cards) {
		counts.set(card.status, (counts.get(card.status) ?? 0) + 1);
	}
	return (
		CARD_STATUSES.filter((s) => counts.has(s))
			.map((s) => `${s}: ${counts.get(s)}`)
			.join(', ') || 'empty'
	);
}

/** Resolve a board by id (exact or 8-char prefix). Throws on ambiguous/missing. */
function resolveBoard(projectRoot: string, boardId: string): Board {
	const boards = listBoards(projectRoot);
	const exact = boards.find((b) => b.id === boardId);
	if (exact) return exact;
	const prefix = boards.filter((b) => b.id.startsWith(boardId));
	if (prefix.length === 1) return prefix[0];
	if (prefix.length > 1) {
		throw new Error(`Board id "${boardId}" is ambiguous (${prefix.length} matches).`);
	}
	throw new Error(`Board "${boardId}" not found in project.`);
}

/** Find the board that owns a card id (exact or prefix), scoped by --board. */
function locateCard(
	projectRoot: string,
	cardId: string,
	boardHint: string | undefined
): { board: Board; card: BoardCard } {
	const boards = boardHint ? [resolveBoard(projectRoot, boardHint)] : listBoards(projectRoot);
	const matches: Array<{ board: Board; card: BoardCard }> = [];
	for (const board of boards) {
		for (const card of board.cards) {
			if (card.id === cardId || card.id.startsWith(cardId)) matches.push({ board, card });
		}
	}
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) {
		throw new Error(`Card id "${cardId}" is ambiguous (${matches.length} matches). Use --board.`);
	}
	throw new Error(`Card "${cardId}" not found in project.`);
}
