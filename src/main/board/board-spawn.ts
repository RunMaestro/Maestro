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
	type ProfileBaseAgentValues,
	type ProfileSpawnOverrides,
} from '../../shared/profiles/types';
import type { BoardCard } from '../../shared/board/types';
import { CARD_HANDOFF_REMINDER } from '../../shared/board/cardMarkers';
import type { CardSpawnRequest, CardSpawnResult } from './board-dispatcher';
import { executeCuePrompt } from '../cue/cue-executor';
import { createCueEvent } from '../cue/cue-types';
import type { TemplateContext } from '../../shared/templateVariables';
import { logger } from '../utils/logger';

/** Default per-card run budget (mirrors the Cue default `timeout_minutes: 30`). */
const DEFAULT_CARD_TIMEOUT_MS = 30 * 60 * 1000;

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
	/** Monotonic-ish id suffix source (Date.now in production). */
	nowMs: () => number;
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
	const { card, overrides } = request;
	// The Cue executor has no system-prompt injection field, so the profile's
	// role (`appendSystemPrompt`) is prepended to the card prompt as a preamble,
	// followed by the four-question handoff reminder (structured completion
	// metadata). model/effort/args flow through the native override fields below.
	const roleLine = overrides.appendSystemPrompt ? `${overrides.appendSystemPrompt}\n\n` : '';
	const promptText =
		`${roleLine}${CARD_HANDOFF_REMINDER}\n\n---\n\n${card.title}\n\n${card.body}`.trim();
	return runCardPrompt(projectRoot, card, promptText, ctx);
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
	const result = await runCardPrompt(projectRoot, card, promptText, ctx);
	if (result.error || result.exitCode !== 0) return null;
	return result.output;
}

/**
 * Shared runner: execute `promptText` through a card's assignee base agent via
 * the SAME `executeCuePrompt` plumbing Cue uses (SSH / custom config honored).
 */
async function runCardPrompt(
	projectRoot: string,
	card: BoardCard,
	promptText: string,
	ctx: BoardSpawnContext
): Promise<CardSpawnResult> {
	const resolved = resolveProfileAndBase(projectRoot, card, ctx);
	if (!resolved) {
		return {
			output: '',
			exitCode: null,
			error: `Board card "${card.id}": assignee profile "${card.assigneeProfileId}" or its base agent could not be resolved.`,
		};
	}

	const { baseSession, overrides } = resolved;
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
}
