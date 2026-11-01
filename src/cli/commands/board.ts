import { boardMigrationSourceKey } from '../../main/board/board-migration';
import { BOARD_SOURCE_PROJECT_PREFIX } from '../../shared/board/types';
import { requireEncore } from '../utils/encore-gate';
/** Board capture/CRUD uses the running host's central workspace and validation.
 * Dispatch and control use the same owning runtime as desktop.
 */

import {
	withMaestroClient,
	MaestroNotRunningError,
	CommandTimeoutError,
} from '../services/maestro-client';
import { requestBoardCommand } from '../../shared/maestro-lib/client/board';
import type { BoardCommand, BoardCommandTarget } from '../../shared/board/commands';
import type { BoardWorkspaceQueryResult, BoardWorkspaceCollection } from '../../shared/board/types';
import { generateUUID } from '../../shared/uuid';
import { type CardPrResult } from '../../main/board/board-pr';
import type { Board, BoardCard, CardPrOnDone, CardStatus } from '../../shared/board/types';
import { CARD_PRIORITIES, CARD_STATUSES } from '../../shared/board/types';
import { buildCardWorktreeRef } from '../../shared/board/worktree';
import { getBlockers } from '../../shared/board/graph';
import { getSessionById, resolveAgentId } from '../services/storage';
import { formatError, formatSuccess, formatWarning } from '../output/formatter';
import type { SessionInfo } from '../../shared/types';

interface BoardCommonOptions {
	kind?: string;
	reviewOf?: string;
	reviewAttempt?: string;
	agent?: string;
	projectRoot?: string;
	source?: string;
	collection?: string;
	revision?: string;
	cardRevision?: string;
	scopeAgent?: string;
	scopeGroup?: string;
	profileNamespace?: string;
	repository?: string;
	workingDirectory?: string;
	startMode?: string;
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
	/**
	 * `--pr-on-done [targetBranch]`: open a PR when the card lands in `done`.
	 * Commander hands `true` for the bare flag (repo default branch at PR time)
	 * and the string for an explicit base.
	 */
	prOnDone?: string | boolean;
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
	/**
	 * `--pr-on-done [targetBranch]` sets the opt-in (bare flag = repo default
	 * branch), `--no-pr-on-done` clears it. Commander hands `false` for the
	 * negated form, mirroring `--worktree` / `--no-worktree`.
	 */
	prOnDone?: string | boolean;
}

interface BoardRemoveCardOptions extends BoardCommonOptions {
	board?: string;
	/** Deprecated compatibility flag; never permits deleting a running card. */
	force?: boolean;
}

interface BoardSetStatusOptions extends BoardCommonOptions {
	board?: string;
}

interface BoardTickOptions extends BoardCommonOptions {
	requestId?: string;
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
	const details =
		error instanceof Error && 'boardError' in error
			? error.boardError
			: {
					code:
						error instanceof MaestroNotRunningError || error instanceof CommandTimeoutError
							? 'runtime-unavailable'
							: 'invalid-input',
					message,
				};
	if (json) {
		console.log(JSON.stringify({ type: 'error', error: message, details }));
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

/**
 * Resolve `--assignee-agent` (id, id prefix or name) to a FULL agent id.
 *
 * Stored verbatim, a prefix or a typo still writes a valid-looking card and only
 * fails much later at dispatch with `blocked (Agent "<id>" not found.)`, wasting
 * a whole dispatch cycle. Resolving at write time makes `--assignee-agent`
 * behave exactly like `--agent` does.
 */
function resolveAssigneeAgentId(value: string): string {
	const id = resolveAgentId(value);
	const session = getSessionById(id);
	if (!session) throw new Error(`Agent "${value}" not found (--assignee-agent).`);
	return session.id;
}

/** `board list --agent <id>` - list boards in the agent's project. */
export async function boardList(options: BoardCommonOptions): Promise<void> {
	try {
		const boards = (await queryHost(options)).collections
			.filter((entry) => !options.collection || entry.collectionKey === options.collection)
			.map((entry) => entry.board);

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
			if (b.storage)
				lines.push(
					`     source: ${b.storage.sourceKey}  collection: ${b.storage.collectionKey}  revision: ${b.storage.expectedRevision}`
				);
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

		const projectRoot = selectedProjectRoot(options);
		const snapshot = await queryHost(options);
		const sourceKey =
			options.source ?? (snapshot.sources.length === 1 ? snapshot.sources[0].sourceKey : undefined);
		if (!projectRoot || !sourceKey)
			throw new Error('Create requires --project-root and an unambiguous --source.');
		const board = await hostCommand<Board>({
			action: 'create',
			projectRoot,
			sourceKey,
			name: trimmed,
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
		const board = (await selectHostBoard(boardId, options)).board;
		const trimmed = (newName ?? '').trim();
		if (!trimmed) throw new Error('A new board name is required (board rename <boardId> <name>).');

		const previous = board.name;
		const renamed = await hostCommand<Board>({
			action: 'rename',
			target: hostTarget(board, options),
			name: trimmed,
		});

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
		const board = (await selectHostBoard(boardId, options)).board;
		const remaining = await hostCommand<Board[]>({
			action: 'delete',
			target: hostTarget(board, options),
			force: options.force === true,
		});

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
		const board = (await selectHostBoard(boardId, options)).board;

		if (options.json) {
			console.log(JSON.stringify(board, null, 2));
			return;
		}
		const lines: string[] = [`${board.name}  [${board.id.slice(0, 8)}]`];
		lines.push(`${board.cards.length} card(s)  |  ${countByStatus(board)}`);
		if (board.storage)
			lines.push(
				`source: ${board.storage.sourceKey}  collection: ${board.storage.collectionKey}  revision: ${board.storage.expectedRevision}`
			);
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
		const board = (await selectHostBoard(boardId, options)).board;

		const title = (options.title ?? '').trim();
		if (!title) throw new Error('A card title is required (--title <title>).');
		// Board Phase 6: a card names a role (--assignee <profileId>) and/or pins a
		// specific agent (--assignee-agent <agentId>). At least one is required. A
		// role-only card floats to the free opt-in worker pool; an agent-only card
		// runs on that agent with its own settings.
		const assignee = (options.assignee ?? '').trim();
		const assigneeAgent = (options.assigneeAgent ?? '').trim();

		const parents = parseParents(options.parents);
		if (options.reviewOf) {
			if (options.kind && options.kind !== 'review')
				throw new Error('--review-of requires --kind review.');
			if (!parents.includes(options.reviewOf)) parents.push(options.reviewOf);
		}

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
		// Store the RESOLVED id so a prefix behaves like `--agent` does.
		if (assigneeAgent) card.assigneeAgentId = resolveAssigneeAgentId(assigneeAgent);
		// `normal` is the default and is never serialized.
		if (priority === 'high' || priority === 'low') card.priority = priority;
		applyCaptureOptions(card, options);
		if (options.worktree && !card.workingDirectory)
			throw new Error('--worktree requires --working-directory.');
		if (options.worktree)
			card.worktree = buildCardWorktreeRef(card.workingDirectory!, board.id, cardId);
		// Board F3 opt-in. Only meaningful together with `--worktree` (the PR is
		// opened for that worktree's branch), but not enforced here: a card can gain
		// its worktree later via `update-card --worktree`.
		if (options.prOnDone !== undefined && options.prOnDone !== false) {
			card.prOnDone = parsePrOnDone(options.prOnDone);
		}

		const saved = await captureHost(board, card, options);
		const captured = saved.cards.find((value) => value.id === card.id)!;

		if (options.json) {
			console.log(JSON.stringify(captured, null, 2));
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
		const located = await selectHostCard(cardId, options);
		const { board, card } = located;
		if (options.cardRevision !== undefined)
			card.storageRevision = readRevision(options.cardRevision);
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
			// Store the RESOLVED id so a prefix behaves like `--agent` does.
			if (value) next.assigneeAgentId = resolveAssigneeAgentId(value);
			else delete next.assigneeAgentId;
			changed = true;
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
		if (applyCaptureOptions(next, options)) changed = true;
		if (options.worktree === true) {
			if (!next.workingDirectory) throw new Error('--worktree requires --working-directory.');
			next.worktree = buildCardWorktreeRef(next.workingDirectory!, board.id, card.id);
			changed = true;
		} else if (options.worktree === false) {
			delete next.worktree;
			changed = true;
		}
		if (options.prOnDone !== undefined) {
			if (options.prOnDone === false) delete next.prOnDone;
			else next.prOnDone = parsePrOnDone(options.prOnDone);
			changed = true;
		}

		if (!changed) {
			throw new Error(
				'Nothing to update. Pass at least one of --title, --body, --assignee, ' +
					'--assignee-agent, --parents, --priority, --worktree/--no-worktree, ' +
					'--pr-on-done/--no-pr-on-done.'
			);
		}

		const saved = await captureHost(board, next, options);

		if (options.json) {
			const fresh = saved;
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
 * removed card inherit its parents). Running cards must be stopped by their
 * owning dispatcher before removal; --force cannot orphan an active agent.
 */
export async function boardRemoveCard(
	cardId: string,
	options: BoardRemoveCardOptions
): Promise<void> {
	try {
		const { board, card } = await selectHostCard(cardId, options);

		if (card.status === 'running') {
			throw new Error(
				`Card "${card.title}" (${card.id.slice(0, 8)}) is running. Stop it from the desktop ` +
					`Board first; --force cannot remove an active run.`
			);
		}

		const dependents = board.cards.filter((c) => c.parents.includes(card.id));
		await hostCommand({
			action: 'delete-card',
			target: hostTarget(board, options),
			cardId: card.id,
			cardRevision: readRevision(options.cardRevision, card.storageRevision),
		});

		if (options.json) {
			console.log(
				JSON.stringify(
					{
						removed: card.id,
						board: board.id,
						wasRunning: false,
						reparented: dependents.map((c) => c.id),
					},
					null,
					2
				)
			);
			return;
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

/**
 * `board set-status <cardId> <status> --agent <id>` - move a card.
 *
 * A move into `done` fires the same PR-on-done flow the `board:setCardStatus` IPC
 * handler fires, so a headless board behaves like the desktop one. It is AWAITED
 * rather than fire-and-forget (`startCardPr`): this process exits as soon as the
 * command returns, which would kill the push mid-flight. The opt-in gate lives in
 * `maybeCreateCardPr`, so a card without `prOnDone` costs one board read.
 */
export async function boardSetStatus(
	cardId: string,
	status: string,
	options: BoardSetStatusOptions
): Promise<void> {
	try {
		if (!(CARD_STATUSES as readonly string[]).includes(status)) {
			throw new Error(`Invalid status "${status}". Valid: ${CARD_STATUSES.join(', ')}.`);
		}

		const located = await selectHostCard(cardId, options);
		await hostCommand({
			action: 'status',
			target: hostTarget(located.board, options),
			cardId: located.card.id,
			cardRevision: readRevision(options.cardRevision, located.card.storageRevision),
			status: status as CardStatus,
		});

		const pr =
			status === 'done'
				? await hostCommand<CardPrResult | null>({
						action: 'card-pr',
						target: hostTarget((await selectHostBoard(located.board.id, options)).board, {
							...options,
							revision: undefined,
						}),
						cardId: located.card.id,
					})
				: null;

		if (options.json) {
			console.log(
				JSON.stringify(
					{
						card: located.card.id,
						board: located.board.id,
						status,
						// Only present when a PR was actually attempted (the gate passed).
						...(pr ? { prUrl: pr.prUrl, prError: pr.success ? undefined : pr.error } : {}),
					},
					null,
					2
				)
			);
			return;
		}
		console.log(
			formatSuccess(`Card "${located.card.title}" (${located.card.id.slice(0, 8)}) -> ${status}.`)
		);
		if (pr?.success && pr.prUrl) console.log(formatSuccess(`Opened PR: ${pr.prUrl}`));
		else if (pr) console.log(formatWarning(`PR not opened: ${pr.error ?? 'unknown error'}`));
	} catch (error) {
		reportError(error, options.json);
	}
}

/** `board tick --agent <id> [--board <id>]` - run one dispatcher pass headlessly. */
export async function boardTick(options: BoardTickOptions): Promise<void> {
	requireEncore('board', options.json);
	requireEncore('maestroCue', options.json);
	try {
		resolveAgentSession(options.agent);
		const summaries = await tickBoardsOnce(
			selectedProjectRoot(options)!,
			options.board,
			options.json,
			options
		);
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
				`  accepted: ${s.accepted} (durable attempts; execution and outcome remain host-owned)`
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
 * host can request passes from the existing owner. Stops on SIGINT. An absent
 * host is an error; this command never starts a scheduler.
 *
 * A storage failure is fatal by design: after Phase 1, `loadBoards` throws
 * rather than silently returning `[]` for a damaged board.yaml, and a watcher
 * that shrugged that off would spin forever on a file no human is looking at.
 * It exits non-zero so a supervisor notices.
 */
export async function boardWatch(options: BoardWatchOptions): Promise<void> {
	requireEncore('board', options.json);
	requireEncore('maestroCue', options.json);
	let projectRoot: string;
	let intervalMs: number;
	try {
		resolveAgentSession(options.agent);
		projectRoot = selectedProjectRoot(options)!;
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
				'Requests use the existing host runtime; accepted runs remain owned by the host.'
		);
	}

	try {
		while (!stopped) {
			try {
				const summaries = await tickBoardsOnce(projectRoot, options.board, options.json, options);
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
		console.log(`[${at}] ${s.name}: accepted ${s.accepted}`);
	}
}

/** Request the owner; CLI never claims, reclaims, decomposes or spawns locally. */
async function tickBoardsOnce(
	projectRoot: string,
	boardHint: string | undefined,
	json: boolean | undefined,
	options: BoardTickOptions = {}
): Promise<TickSummary[]> {
	requireEncore('board', json);
	requireEncore('maestroCue', json);
	const selected = { ...options, projectRoot };
	const entries = boardHint
		? [await selectHostBoard(boardHint, selected)]
		: (await queryHost(selected)).collections.filter(
				(c) => !options.collection || c.collectionKey === options.collection
			);
	const summaries: TickSummary[] = [];
	for (const entry of entries) {
		const results = await hostCommand<import('../../shared/board/commands').BoardTickResult[]>({
			action: 'tick',
			target: hostTarget(entry.board, selected),
			operationId: options.requestId ?? generateUUID(),
		});
		summaries.push({
			boardId: entry.board.id,
			name: entry.board.name,
			accepted: results.filter((r) => r.ok).length,
			notes: results.map(
				(r) => `${r.cardId}: ${r.ok ? `accepted ${r.runToken?.runId}` : r.reason}`
			),
			results,
		});
	}
	return summaries;
}
interface TickSummary {
	boardId: string;
	name: string;
	accepted: number;
	notes: string[];
	results: import('../../shared/board/commands').BoardTickResult[];
}

export async function boardControl(
	cardId: string,
	options: BoardCommonOptions & {
		board?: string;
		operation: 'hold' | 'resume' | 'approve';
		runId?: string;
		ownerEpoch?: string;
		generation?: string;
	}
): Promise<void> {
	requireEncore('board', options.json);
	try {
		const { board, card } = await selectHostCard(cardId, options);
		const value = await hostCommand({
			action: 'control',
			target: hostTarget(board, options),
			cardId: card.id,
			cardRevision: readRevision(options.cardRevision, card.storageRevision),
			operation: options.operation,
			...(options.runId
				? {
						runToken: {
							runId: options.runId,
							ownerEpoch: readRevision(options.ownerEpoch),
							generation: readRevision(options.generation),
						},
					}
				: {}),
		});
		console.log(
			options.json ? JSON.stringify(value) : formatSuccess(`Board ${options.operation} accepted.`)
		);
	} catch (error) {
		reportError(error, options.json);
	}
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

/**
 * Normalize a `--pr-on-done [targetBranch]` value into a {@link CardPrOnDone}.
 *
 * A bare flag (commander hands `true`) stores `{}`, which means "the repo's
 * default branch, resolved at PR time" rather than baking a branch name into the
 * board file. A value stores it trimmed. The shape is re-validated by the storage
 * layer's card validator on write, so a blank value degrades to the bare form.
 */
function parsePrOnDone(raw: string | boolean): CardPrOnDone {
	const targetBranch = typeof raw === 'string' ? raw.trim() : '';
	return targetBranch ? { targetBranch } : {};
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

/** Board CRUD always talks to the currently running host; it never opens a local database. */
async function hostCommand<T = unknown>(command: BoardCommand): Promise<T> {
	const reply = await withMaestroClient((client) => requestBoardCommand(client, command));
	if (!reply.ok) {
		const failure =
			typeof reply.error === 'object'
				? reply.error
				: { code: 'runtime-unavailable', message: String(reply.error) };
		throw Object.assign(new Error(failure.message), { boardError: failure });
	}
	return reply.value as T;
}
function selectedProjectRoot(options: BoardCommonOptions): string | undefined {
	if (options.projectRoot?.startsWith(BOARD_SOURCE_PROJECT_PREFIX)) return options.projectRoot;
	const session = options.agent ? resolveAgentSession(options.agent) : undefined;
	if (session?.sessionSshRemoteConfig?.enabled) {
		const remoteId = session.sessionSshRemoteConfig.remoteId;
		const root = options.projectRoot ?? session.projectRoot;
		if (!remoteId || !root)
			throw new Error('SSH source requires an explicit remote identity and project directory.');
		return (
			BOARD_SOURCE_PROJECT_PREFIX +
			boardMigrationSourceKey({ location: { kind: 'ssh', remoteId }, path: root })
		);
	}
	return (
		options.projectRoot ??
		session?.projectRoot ??
		(options.source ? BOARD_SOURCE_PROJECT_PREFIX + options.source : undefined)
	);
}
async function queryHost(options: BoardCommonOptions): Promise<BoardWorkspaceQueryResult> {
	const projectRoot = selectedProjectRoot(options);
	return hostCommand({
		action: 'query',
		query: {
			...(projectRoot ? { projectRoot } : {}),
			...(options.source ? { sourceKey: options.source } : {}),
		},
	});
}
async function selectHostBoard(
	id: string,
	options: BoardCommonOptions
): Promise<BoardWorkspaceCollection> {
	const snapshot = await queryHost(options);
	const candidates = snapshot.collections.filter(
		(entry) => !options.collection || entry.collectionKey === options.collection
	);
	const exact = candidates.filter((entry) => entry.board.id === id || entry.collectionKey === id);
	const matches = exact.length
		? exact
		: candidates.filter((entry) => entry.board.id.startsWith(id));
	if (matches.length !== 1)
		throw new Error(
			`Board "${id}" ${matches.length ? 'is ambiguous; use --source and --collection' : 'not found'}.`
		);
	return matches[0];
}
async function selectHostCard(
	id: string,
	options: BoardCommonOptions & { board?: string }
): Promise<{ board: Board; card: BoardCard }> {
	const collections = options.board
		? [await selectHostBoard(options.board, options)]
		: (await queryHost(options)).collections.filter(
				(entry) => !options.collection || entry.collectionKey === options.collection
			);
	const all = collections.flatMap(({ board }) => board.cards.map((card) => ({ board, card })));
	const exact = all.filter(({ card }) => card.id === id);
	const matches = exact.length ? exact : all.filter(({ card }) => card.id.startsWith(id));
	if (matches.length !== 1)
		throw new Error(
			`Card "${id}" ${matches.length ? 'is ambiguous; use --source and --collection' : 'not found'}.`
		);
	return matches[0];
}
function readRevision(raw: string | undefined, fallback?: number): number {
	const value = raw === undefined ? fallback : Number(raw);
	if (value === undefined || !Number.isSafeInteger(value) || value < 0 || raw?.trim() === '')
		throw new Error('A non-negative integer revision is required.');
	return value;
}
function hostTarget(board: Board, options: BoardCommonOptions): BoardCommandTarget {
	const projectRoot = selectedProjectRoot(options);
	if (!projectRoot)
		throw new Error(
			'Mutation requires --project-root or --agent; no working directory is inferred.'
		);
	if (!board.storage) throw new Error('Host returned a board without central identity.');
	return {
		projectRoot,
		sourceKey: board.storage.sourceKey,
		collectionKey: board.storage.collectionKey,
		expectedRevision: readRevision(options.revision, board.storage.expectedRevision ?? undefined),
	};
}
async function captureHost(
	board: Board,
	card: BoardCard,
	options: BoardCommonOptions
): Promise<Board> {
	const target = hostTarget(board, options);
	return hostCommand({
		action: 'capture',
		target,
		capture: {
			projectRoot: target.projectRoot,
			boardId: board.id,
			expectedRevision: target.expectedRevision,
			card,
			...(options.reviewOf
				? {
						reviewSource: {
							cardId: options.reviewOf,
							attempt: readRevision(options.reviewAttempt),
						},
					}
				: {}),
		},
	});
}
function applyCaptureOptions(
	card: BoardCard,
	options: BoardCommonOptions & { assignee?: string }
): boolean {
	let changed = false;
	if (options.kind !== undefined || options.reviewOf) {
		const kind = options.kind ?? 'review';
		if (!['work', 'review', 'test', 'documentation'].includes(kind))
			throw new Error('Invalid --kind.');
		card.kind = kind as BoardCard['kind'];
		changed = true;
	}
	if (options.reviewAttempt && !options.reviewOf)
		throw new Error('--review-attempt requires --review-of.');
	if (options.scopeAgent !== undefined && options.scopeGroup !== undefined)
		throw new Error('Choose exactly one of --scope-agent or --scope-group.');
	if (options.scopeAgent !== undefined || options.scopeGroup !== undefined) {
		card.executionScope =
			options.scopeAgent !== undefined
				? { kind: 'agent', agentId: options.scopeAgent }
				: { kind: 'group', groupId: options.scopeGroup! };
		changed = true;
	}
	if (options.profileNamespace !== undefined || options.assignee !== undefined) {
		const namespace = options.profileNamespace ?? card.role?.namespace;
		const profileId =
			options.assignee !== undefined
				? options.assignee.trim()
				: (card.role?.profileId ?? card.assigneeProfileId);
		if (profileId && namespace) card.role = { namespace, profileId };
		else if (options.assignee === '') delete card.role;
		else throw new Error('--assignee requires an explicit --profile-namespace.');
		Reflect.deleteProperty(card, 'profileNamespace');
		changed = true;
	}
	if (options.repository !== undefined) {
		card.repositoryId = options.repository;
		changed = true;
	}
	if (options.workingDirectory !== undefined) {
		card.workingDirectory = options.workingDirectory;
		changed = true;
	}
	if (options.startMode !== undefined) {
		if (options.startMode !== 'direct' && options.startMode !== 'approval')
			throw new Error('--start-mode must be direct or approval.');
		card.startModeOverride = options.startMode;
		changed = true;
	}
	return changed;
}
