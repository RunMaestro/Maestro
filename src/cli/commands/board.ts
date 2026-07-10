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

import * as path from 'path';
import { generateUUID } from '../../shared/uuid';
import {
	listBoards,
	getBoard,
	addCard,
	updateCardStatus,
	saveBoard,
} from '../../main/board/board-storage';
import type { Board, BoardCard, CardStatus } from '../../shared/board/types';
import { CARD_STATUSES } from '../../shared/board/types';
import { getBlockers } from '../../shared/board/graph';
import { CARD_HANDOFF_REMINDER } from '../../shared/board/cardMarkers';
import {
	promoteEligibleCards,
	claimReadyCards,
	applyCardResult,
	reclaimStaleRunning,
	DEFAULT_MAX_IN_PROGRESS,
	DEFAULT_MAX_FAILURES,
	DEFAULT_STALE_RUNNING_MS,
	type CardSpawnResult,
} from '../../main/board/board-dispatcher';
import {
	resolveProfileSpawnOverrides,
	type ProfileBaseAgentValues,
} from '../../shared/profiles/types';
import { listProfiles } from '../../main/profiles/profile-storage';
import { autoDecomposeBoard, type DecomposeSpawn } from '../../main/board/board-decompose';
import { readSessions, getSessionById, resolveAgentId } from '../services/storage';
import { spawnAgent } from '../services/agent-spawner';
import { getCliPrompt } from '../services/prompt-loader';
import { PROMPT_IDS } from '../../shared/promptDefinitions';
import { formatError, formatSuccess } from '../output/formatter';
import type { SessionInfo, ToolType } from '../../shared/types';

interface BoardCommonOptions {
	agent: string;
	json?: boolean;
}

interface BoardShowOptions extends BoardCommonOptions {}

interface BoardAddCardOptions extends BoardCommonOptions {
	title: string;
	body?: string;
	assignee: string;
	parents?: string;
	worktree?: boolean;
}

interface BoardSetStatusOptions extends BoardCommonOptions {
	board?: string;
}

interface BoardTickOptions extends BoardCommonOptions {
	board?: string;
}

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
			lines.push(`     assignee: ${card.assigneeProfileId.slice(0, 8)}`);
			if (card.parents.length > 0) {
				const blockers = getBlockers(board, card.id);
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
		const assignee = (options.assignee ?? '').trim();
		if (!assignee) throw new Error('An assignee profile is required (--assignee <profileId>).');

		const parents = (options.parents ?? '')
			.split(',')
			.map((p) => p.trim())
			.filter((p) => p.length > 0);

		const now = new Date().toISOString();
		const cardId = generateUUID();
		const card: BoardCard = {
			id: cardId,
			title,
			body: options.body ?? '',
			assigneeProfileId: assignee,
			parents,
			status: 'todo',
			createdAt: now,
			updatedAt: now,
		};
		if (options.worktree) {
			// Advisory worktree intent: a conventional isolated checkout path for this
			// card. The dispatcher currently runs cards in the project root; this ref
			// is metadata the desktop worktree-aware path can honor later.
			card.worktree = {
				path: path.join(session.projectRoot, '.maestro', 'worktrees', cardId),
				branch: `board/${cardId.slice(0, 8)}`,
			};
		}

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
		const projectRoot = session.projectRoot;

		let boards = listBoards(projectRoot);
		if (options.board) {
			boards = [resolveBoard(projectRoot, options.board)];
		}
		if (boards.length === 0) {
			if (options.json) console.log(JSON.stringify({ type: 'tick', boards: [] }));
			else console.log('No boards to tick.');
			return;
		}

		const sessions = readSessions();
		// Load the editable decompose template once; only used when a board opts in.
		const decomposeTemplate = boards.some((b) => b.autoDecompose)
			? await getCliPrompt(PROMPT_IDS.BOARD_DECOMPOSE).catch(() => undefined)
			: undefined;
		const summaries: TickSummary[] = [];
		for (const board of boards) {
			summaries.push(
				await tickBoard(projectRoot, board.id, sessions, decomposeTemplate, options.json)
			);
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

// ─── Headless dispatch (reuses the Phase 3 pure helpers) ─────────────────────

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
		spawn: makeDecomposeSpawn(projectRoot, board, sessions),
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

	// 4. Claim ready cards up to the WIP cap.
	const cap = board.maxInProgress ?? DEFAULT_MAX_IN_PROGRESS;
	const claims = claimReadyCards(board, cap, nowIso);

	// Persist BEFORE spawning so a crash / next tick sees the cards as running.
	if (reclaimed.length > 0 || decomposed > 0 || promoted.length > 0 || claims.length > 0) {
		saveBoard(projectRoot, board);
	}

	// 5. Spawn each claimed card, await, and apply its result.
	for (const card of claims) {
		summary.ran++;
		const result = await spawnCard(projectRoot, card, sessions);
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

/** Resolve a card's assignee profile + base session into spawn overrides. */
function resolveCardBase(
	projectRoot: string,
	card: BoardCard,
	sessions: SessionInfo[]
): { base: SessionInfo; overrides: ReturnType<typeof resolveProfileSpawnOverrides> } | null {
	const profile = listProfiles(projectRoot).find((p) => p.id === card.assigneeProfileId);
	if (!profile) return null;
	const base = sessions.find((s) => s.id === profile.baseAgentId);
	if (!base) return null;
	const baseValues: ProfileBaseAgentValues = {
		customModel: base.customModel,
		customEffort: base.customEffort,
		customArgs: base.customArgs,
		appendSystemPrompt: (base as Record<string, unknown>).appendSystemPrompt as string | undefined,
	};
	return { base, overrides: resolveProfileSpawnOverrides(profile, baseValues) };
}

/**
 * Run a claimed card's assignee through the CLI spawn path (`spawnAgent`),
 * honoring SSH + profile model/effort/args overrides. Returns a
 * {@link CardSpawnResult} the pure `applyCardResult` can evaluate for markers /
 * exit status. A missing profile / base agent is a hard failure (never
 * dispatched as a mystery agent), returned as an errored result.
 */
async function spawnCard(
	projectRoot: string,
	card: BoardCard,
	sessions: SessionInfo[]
): Promise<CardSpawnResult> {
	const resolved = resolveCardBase(projectRoot, card, sessions);
	if (!resolved) {
		return {
			output: '',
			exitCode: null,
			error: `Board card "${card.id}": assignee profile "${card.assigneeProfileId}" or its base agent could not be resolved.`,
		};
	}
	const { base, overrides } = resolved;
	// The role/system prompt is prepended to the card prompt (parity with the
	// desktop board-spawn path, whose Cue executor has no system-prompt field).
	const rolePreamble = overrides.appendSystemPrompt
		? `${overrides.appendSystemPrompt}\n\n${CARD_HANDOFF_REMINDER}\n\n---\n\n`
		: `${CARD_HANDOFF_REMINDER}\n\n---\n\n`;
	const prompt = `${rolePreamble}${card.title}\n\n${card.body}`.trim();

	const result = await spawnAgent(base.toolType as ToolType, projectRoot, prompt, undefined, {
		customModel: overrides.customModel,
		customEffort: overrides.customEffort,
		customArgs: overrides.customArgs,
		customEnvVars: base.customEnvVars,
		sshRemoteConfig: base.sessionSshRemoteConfig,
		enableMaestroP: base.enableMaestroP,
		maestroPMode: base.maestroPMode,
		maestroPPath: base.maestroPPath,
	});

	return {
		output: result.response ?? '',
		exitCode: result.success ? 0 : 1,
		error: result.success ? undefined : result.error,
	};
}

/** Build the auto-decompose spawn callback backed by the CLI spawn path. */
function makeDecomposeSpawn(
	projectRoot: string,
	board: Board,
	sessions: SessionInfo[]
): DecomposeSpawn {
	return async (prompt: string, triageCard: BoardCard) => {
		const resolved = resolveCardBase(projectRoot, triageCard, sessions);
		// Fall back to the first agent in the project when the triage card has no
		// resolvable assignee - decomposition just needs any capable model.
		const base = resolved?.base ?? sessions.find((s) => s.projectRoot === projectRoot);
		if (!base) return null;
		const overrides = resolved?.overrides;
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
