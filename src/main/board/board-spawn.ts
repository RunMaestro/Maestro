/**
 * Board card spawn wiring (Board Phase 3).
 *
 * Bridges the pure {@link BoardDispatcher} to the real, host-owned agent spawn
 * path. A claimed card's assignee profile is resolved against its base Left Bar
 * agent, and the run goes through the SAME `executeCuePrompt` plumbing the Cue
 * engine uses - so SSH config, custom env/path, batch-mode args, and Claude
 * token-source selection are all honored exactly as a Cue run would (the CLAUDE
 * SSH-awareness rule: we never bypass that path).
 *
 * This module is main-only (it imports the Cue executor). The dispatcher core
 * and its unit tests never touch it - they inject fakes.
 */

import { listProfiles } from '../profiles/profile-storage';
import {
	resolveProfileSpawnOverrides,
	type AgentProfile,
	type ProfileBaseAgentValues,
	type ProfileSpawnOverrides,
} from '../../shared/profiles/types';
import type { BoardCard } from '../../shared/board/types';
import { CARD_HANDOFF_REMINDER } from '../../shared/board/cardMarkers';
import type { CardAssignment, CardSpawnRequest, CardSpawnResult } from './board-dispatcher';
import { executeCuePrompt, stopCueRun } from '../cue/cue-executor';
import { createCueEvent } from '../cue/cue-types';
import type { TemplateContext } from '../../shared/templateVariables';
import { logger } from '../utils/logger';

/** Default per-card run budget (mirrors the Cue default `timeout_minutes: 30`). */
const DEFAULT_CARD_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Live card runs: cardId -> the Cue `runId` its process is registered under.
 *
 * `executeCuePrompt` exposes no cancellation handle of its own; the run is
 * addressable by the `runId` we mint for it, and `stopCueRun(runId)` is exactly
 * how Cue stops one of its own runs. Remembering that id per card is therefore
 * the whole cancellation mechanism - see {@link cancelBoardCardRun}.
 */
const activeCardRunIds = new Map<string, string>();

/**
 * Kill the in-flight agent process for a card. Returns `true` when a live run
 * was found and stopped, `false` when the card has no registered run (already
 * finished, or running in another process such as the CLI). Wired into the
 * dispatcher as `cancelSpawn`.
 */
export function cancelBoardCardRun(cardId: string): boolean {
	const runId = activeCardRunIds.get(cardId);
	if (!runId) return false;
	// Leave the map entry to `runCardPrompt`'s finally block: the process exit is
	// what actually clears it, and deleting here would race a second cancel.
	return stopCueRun(runId);
}

/** The host context a board spawn needs, injected from index.ts where these
 * live. Kept structural so this module doesn't import the electron-store type. */
export interface BoardSpawnContext {
	/** The persisted sessions list (Left Bar agents) - used to resolve a base agent. */
	getStoredSessions: () => Array<Record<string, any>>;
	/** Per-agent config values (customPath, customEnvVars, ...) keyed by tool type. */
	getAgentConfig: (toolType: string) => Record<string, any>;
	/** Resolve an agent's binary path (agent detector), if the config didn't supply one. */
	resolveAgentPath?: (toolType: string) => Promise<string | undefined>;
	/** SSH remote settings store adapter for `executeCuePrompt`. */
	getSshStore: () => any;
	/** Optional conductor profile string threaded into the template context. */
	getConductorProfile?: () => string | undefined;
	/**
	 * Board Phase 6 worker pool: the ids of opt-in board-worker agents whose
	 * working directory is inside `projectRoot` (or a sub-folder), in Left Bar
	 * order. Used to resolve role-only / agent-less cards to a free worker. When
	 * omitted, only pinned cards (explicit agent or legacy profile `baseAgentId`)
	 * can run.
	 */
	getPoolAgentIds?: (projectRoot: string) => string[];
	/** Monotonic-ish id suffix source (Date.now in production). */
	nowMs: () => number;
}

/** Build spawn overrides from a base session's own values (no profile / role). */
function nativeOverrides(baseSession: Record<string, any>): ProfileSpawnOverrides {
	return {
		customModel: baseSession.customModel,
		customEffort: baseSession.customEffort,
		appendSystemPrompt: baseSession.appendSystemPrompt,
		customArgs: baseSession.customArgs,
	};
}

/**
 * Resolve a card to a FREE worker (Board Phase 6). Wired into
 * `BoardDispatcherDeps.assign`. Resolution:
 *   - a named-but-missing profile is a config error -> `unresolvable`;
 *   - a pinned agent (`assigneeAgentId`, or a legacy profile's `baseAgentId`)
 *     yields a single candidate; a role-only card uses the opt-in project pool;
 *   - the first candidate not in `busyAgentIds` wins (one card per worker),
 *     layering the role's overrides (if any) over the chosen agent's values;
 *   - all candidates busy / empty pool -> `no-free-worker` (card waits).
 */
export function resolveCardAssignment(
	projectRoot: string,
	card: BoardCard,
	busyAgentIds: ReadonlySet<string>,
	ctx: BoardSpawnContext
): CardAssignment {
	let profile: AgentProfile | undefined;
	if (card.assigneeProfileId) {
		profile = listProfiles(projectRoot).find((p) => p.id === card.assigneeProfileId);
		// The card named a role that no longer exists - a config error, block it.
		if (!profile) {
			return { kind: 'unresolvable', reason: `Profile "${card.assigneeProfileId}" not found.` };
		}
	}

	// A pinned agent (explicit or legacy profile base) => single candidate.
	// Otherwise float to the opt-in worker pool for this project.
	const pinnedId = card.assigneeAgentId ?? profile?.baseAgentId;
	const candidates = pinnedId ? [pinnedId] : (ctx.getPoolAgentIds?.(projectRoot) ?? []);
	if (candidates.length === 0) {
		// No pinned agent and an empty pool: nobody to run it yet. Wait (don't
		// block) so it dispatches the moment a worker is opted in.
		return { kind: 'no-free-worker' };
	}

	const chosen = candidates.find((id) => !busyAgentIds.has(id));
	if (!chosen) return { kind: 'no-free-worker' };

	const baseSession = ctx.getStoredSessions().find((s) => s.id === chosen);
	if (!baseSession) {
		// A pinned agent that no longer exists is a config error; a stale pool id
		// (shouldn't happen) is also unrunnable. Block rather than spin.
		return { kind: 'unresolvable', reason: `Agent "${chosen}" not found.` };
	}

	const overrides = profile
		? resolveProfileSpawnOverrides(profile, {
				customModel: baseSession.customModel,
				customEffort: baseSession.customEffort,
				customArgs: baseSession.customArgs,
				appendSystemPrompt: baseSession.appendSystemPrompt,
			})
		: nativeOverrides(baseSession);

	return { kind: 'assigned', agentId: chosen, overrides };
}

/** Find the profile a card is assigned to plus its base agent session. */
function resolveProfileAndBase(
	projectRoot: string,
	card: BoardCard,
	ctx: BoardSpawnContext
): { baseSession: Record<string, any>; overrides: ProfileSpawnOverrides } | null {
	const profile = listProfiles(projectRoot).find((p) => p.id === card.assigneeProfileId);
	if (!profile) return null;
	const baseSession = ctx.getStoredSessions().find((s) => s.id === profile.baseAgentId);
	if (!baseSession) return null;
	const baseValues: ProfileBaseAgentValues = {
		customModel: baseSession.customModel,
		customEffort: baseSession.customEffort,
		customArgs: baseSession.customArgs,
		appendSystemPrompt: baseSession.appendSystemPrompt,
	};
	return { baseSession, overrides: resolveProfileSpawnOverrides(profile, baseValues) };
}

/**
 * Resolve a card's assignee profile into spawn overrides, or `null` when the
 * profile / base agent can't be resolved. Wired into `CueEngineBoardDeps.resolveOverrides`.
 */
export function resolveCardOverrides(
	projectRoot: string,
	card: BoardCard,
	ctx: BoardSpawnContext
): ProfileSpawnOverrides | null {
	return resolveProfileAndBase(projectRoot, card, ctx)?.overrides ?? null;
}

/**
 * Run a claimed card's assignee to completion and return its output + exit code
 * for the dispatcher's marker/exit-status evaluation. Wired into
 * `CueEngineBoardDeps.spawnCard`.
 */
export async function spawnBoardCard(
	projectRoot: string,
	request: CardSpawnRequest,
	ctx: BoardSpawnContext
): Promise<CardSpawnResult> {
	const { card, overrides, agentId } = request;
	// Resolve the base session: the pool-chosen worker (`agentId`) on the Phase 6
	// path, else the card's profile base agent (legacy single-agent path).
	const baseSession = resolveBaseSession(projectRoot, card, agentId, ctx);
	if (!baseSession) {
		return {
			output: '',
			exitCode: null,
			error: `Board card "${card.id}": worker agent could not be resolved.`,
		};
	}
	// The Cue executor has no system-prompt injection field, so the profile's
	// role (`appendSystemPrompt`) is prepended to the card prompt as a preamble,
	// followed by the four-question handoff reminder (structured completion
	// metadata). model/effort/args flow through the native override fields below.
	const roleLine = overrides.appendSystemPrompt ? `${overrides.appendSystemPrompt}\n\n` : '';
	const promptText =
		`${roleLine}${CARD_HANDOFF_REMINDER}\n\n---\n\n${card.title}\n\n${card.body}`.trim();
	return runCardPrompt(projectRoot, card, promptText, baseSession, overrides, ctx);
}

/**
 * Resolve the base Left Bar session a card should run on. Prefers the explicit
 * pool-chosen `agentId` (Phase 6); falls back to the card's assignee profile's
 * `baseAgentId` (legacy single-agent path). Returns `null` when neither resolves.
 */
function resolveBaseSession(
	projectRoot: string,
	card: BoardCard,
	agentId: string | undefined,
	ctx: BoardSpawnContext
): Record<string, any> | null {
	if (agentId) {
		return ctx.getStoredSessions().find((s) => s.id === agentId) ?? null;
	}
	return resolveProfileAndBase(projectRoot, card, ctx)?.baseSession ?? null;
}

/**
 * Run one auto-decompose LLM pass for a triage card, using the card's assignee
 * base agent, and return the raw agent output (or `null` on failure). Wired into
 * the board deps' `decompose` step. The `promptText` is the filled
 * `board-decompose` template (built by {@link buildDecomposePrompt}); we do NOT
 * prepend the role preamble here because decomposition is a structured task, not
 * the card's own work.
 */
export async function decomposeBoardCard(
	projectRoot: string,
	card: BoardCard,
	promptText: string,
	ctx: BoardSpawnContext
): Promise<string | null> {
	// Decomposition just needs any capable model: prefer the card's pinned/base
	// agent, else the first opt-in pool worker, else any session in the project.
	const resolved = resolveProfileAndBase(projectRoot, card, ctx);
	let baseSession = resolved?.baseSession ?? null;
	const overrides = resolved?.overrides ?? {};
	if (!baseSession) {
		const poolId = ctx.getPoolAgentIds?.(projectRoot)?.[0];
		baseSession = poolId
			? (ctx.getStoredSessions().find((s) => s.id === poolId) ?? null)
			: (ctx
					.getStoredSessions()
					.find((s) => s.projectRoot === projectRoot || s.cwd === projectRoot) ?? null);
	}
	if (!baseSession) return null;
	const result = await runCardPrompt(projectRoot, card, promptText, baseSession, overrides, ctx);
	if (result.error || result.exitCode !== 0) return null;
	return result.output;
}

/**
 * Shared runner: execute `promptText` through the resolved base agent via the
 * SAME `executeCuePrompt` plumbing Cue uses (SSH / custom config honored). The
 * caller resolves `baseSession` + `overrides` (pool worker or legacy profile
 * base) so this runner stays assignment-agnostic.
 */
async function runCardPrompt(
	projectRoot: string,
	card: BoardCard,
	promptText: string,
	baseSession: Record<string, any>,
	overrides: ProfileSpawnOverrides,
	ctx: BoardSpawnContext
): Promise<CardSpawnResult> {
	// Left loosely typed (the base session is a Record<string, any>) so it flows
	// into both the string `toolType` config field and the enum `session.toolType`
	// field, exactly as the Cue `onCueRun` path passes it through.
	const toolType = baseSession.toolType;
	const agentConfigValues = ctx.getAgentConfig(String(toolType));

	let resolvedAgentPath = agentConfigValues.customPath as string | undefined;
	if (!resolvedAgentPath && ctx.resolveAgentPath) {
		resolvedAgentPath = await ctx.resolveAgentPath(toolType);
	}

	const runId = `board-${card.id}-${ctx.nowMs()}`;
	const templateContext: TemplateContext = {
		session: {
			id: baseSession.id,
			name: baseSession.name,
			toolType,
			cwd: projectRoot,
			projectRoot,
			fullPath: baseSession.fullPath,
			autoRunFolderPath: baseSession.autoRunFolderPath,
		},
		conductorProfile: ctx.getConductorProfile?.() || undefined,
	};
	const event = createCueEvent('cli.trigger', `board:${card.id}`, { board: true });

	// Register the run id BEFORE awaiting so a cancel arriving mid-run can find it.
	activeCardRunIds.set(card.id, runId);
	try {
		const result = await executeCuePrompt({
			runId,
			session: {
				id: baseSession.id,
				name: baseSession.name,
				toolType,
				cwd: projectRoot,
				projectRoot,
				autoRunFolderPath: baseSession.autoRunFolderPath,
			},
			subscription: {
				name: `board:${card.title}`,
				event: event.type,
				enabled: true,
				prompt: promptText,
			},
			event,
			promptPath: promptText,
			toolType,
			projectRoot,
			templateContext,
			timeoutMs: DEFAULT_CARD_TIMEOUT_MS,
			// Honor the base agent's SSH + token-source config (never bypass the SSH path).
			sshRemoteConfig: baseSession.sessionSshRemoteConfig,
			customPath: resolvedAgentPath,
			customArgs: overrides.customArgs,
			customEnvVars: baseSession.customEnvVars,
			customModel: overrides.customModel,
			customEffort: overrides.customEffort,
			enableMaestroP: baseSession.enableMaestroP,
			maestroPMode: baseSession.maestroPMode,
			maestroPPath: baseSession.maestroPPath,
			onLog: (level, message) => {
				if (level === 'error') logger.error(message, 'Board');
				else if (level === 'warn') logger.warn(message, 'Board');
				else if (level === 'debug') logger.debug(message, 'Board');
				else logger.cue(message, 'Board');
			},
			sshStore: ctx.getSshStore(),
			agentConfigValues,
		});

		return { output: result.stdout, exitCode: result.exitCode };
	} finally {
		// Only clear our own registration: a retry claimed after this run started
		// would already have replaced the entry with its own run id.
		if (activeCardRunIds.get(card.id) === runId) activeCardRunIds.delete(card.id);
	}
}
