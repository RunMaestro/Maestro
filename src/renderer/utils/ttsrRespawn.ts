/**
 * Building the corrective turn TTSR respawns after an abort.
 *
 * The abort happens in main (no renderer round-trip - bad output has to stop
 * immediately), but the respawn belongs here: routing it through the renderer's
 * normal spawn config keeps tab state, the message list, and the execution
 * queue coherent, and reuses every arg-building rule (permission mode, YOLO
 * filtering, per-session overrides, SSH, Windows stdin) instead of a second
 * implementation of them in main.
 *
 * The functions below are pure: the hook does the IPC, these decide the shape.
 */

import { resolveTabPermissionMode } from '../../shared/agentMetadata';
import type { TtsrTriggeredPayload } from '../../shared/ttsr-types';
import type { AITab, ProcessConfig, Session } from '../types';
import { filterYoloArgs } from './agentArgs';
import { parseSessionId } from './sessionIdParser';
import { getStdinFlags } from './spawnHelpers';

/** The slice of a resolved agent definition a corrective spawn needs. */
export interface TtsrRespawnAgent {
	command?: string;
	path?: string;
	args?: string[];
	yoloModeArgs?: string[];
	capabilities?: { supportsStreamJsonInput?: boolean };
}

export interface TtsrRespawnTarget {
	session: Session;
	tab: AITab;
}

/**
 * Find the agent + tab a `ttsr:triggered` payload belongs to.
 *
 * Goes through the shared session-id parser so the forced-parallel `-fp-<ts>`
 * suffix is handled the same way every other listener handles it. Returns null
 * when the tab is gone (session closed while the abort was in flight).
 */
export function resolveTtsrTarget(
	sessions: Session[],
	payload: TtsrTriggeredPayload
): TtsrRespawnTarget | null {
	const parsed = parseSessionId(payload.sessionId);
	if (parsed.type !== 'ai-tab' || !parsed.tabId) return null;

	const session = sessions.find((candidate) => candidate.id === parsed.actualSessionId);
	const tab = session?.aiTabs?.find((candidate) => candidate.id === parsed.tabId);
	return session && tab ? { session, tab } : null;
}

/**
 * The spawn config for a corrective turn.
 *
 * Two things differ from a normal turn:
 * - the prompt is the rendered `<system-interrupt>` block(s), already including
 *   the restated goal when main degraded to `fresh`;
 * - `agentSessionId` comes from the payload, not the tab. Main captured the
 *   provider id from the `session-id` event of the turn it just aborted (Gate
 *   B), and on the degraded `fresh` path it is deliberately absent so
 *   `buildAgentArgs` appends no `resumeArgs`.
 */
export function buildTtsrRespawnConfig(input: {
	payload: TtsrTriggeredPayload;
	session: Session;
	tab: AITab;
	agent: TtsrRespawnAgent;
	appendSystemPrompt?: string;
	/**
	 * Whether a non-worktree Auto Run is in flight for this agent, which forces
	 * concurrent manual turns read-only. Passed in rather than read here so this
	 * stays a pure function.
	 */
	autoRunForcesReadOnly?: boolean;
}): ProcessConfig {
	const { payload, session, tab, agent } = input;

	const command = agent.path || agent.command;
	if (!command) throw new Error(`${payload.agentId} agent has no command configured`);

	// The corrective turn inherits the aborted turn's permissions: a read-only
	// tab must not gain write access just because a rule fired. That includes the
	// Auto Run gate - mirrors the interactive spawn path in `useInputProcessing`,
	// where the same three inputs decide read-only. A forced-parallel turn runs
	// in its own worktree and is exempt, exactly as it is there.
	const isForcedParallel = /-fp-\d+$/.test(payload.sessionId);
	const isReadOnly =
		(input.autoRunForcesReadOnly === true && !isForcedParallel) ||
		tab.readOnlyMode === true ||
		tab.permissionMode === 'readonly';
	const baseArgs = agent.args ?? [];

	const { sendPromptViaStdin, sendPromptViaStdinRaw } = getStdinFlags({
		isSshSession: !!session.sshRemoteId || !!session.sessionSshRemoteConfig?.enabled,
		supportsStreamJsonInput: agent.capabilities?.supportsStreamJsonInput ?? false,
		hasImages: false,
	});

	return {
		sessionId: payload.sessionId,
		toolType: session.toolType,
		cwd: session.cwd,
		command,
		args: isReadOnly ? filterYoloArgs(baseArgs, agent) : [...baseArgs],
		prompt: payload.injectionPrompt,
		appendSystemPrompt: input.appendSystemPrompt,
		agentSessionId: payload.mode === 'resume' ? payload.providerSessionId : undefined,
		// Handed straight back so main recognises its own corrective turn without
		// inspecting the prompt, which anything downstream may still decorate.
		ttsrCorrelationId: payload.ttsrCorrelationId,
		readOnlyMode: isReadOnly,
		permissionMode: isReadOnly ? 'readonly' : resolveTabPermissionMode(tab),
		sessionCustomPath: session.customPath,
		sessionCustomArgs: session.customArgs,
		sessionAdditionalDirectories: session.additionalDirectories,
		sessionCustomEnvVars: session.customEnvVars,
		sessionCustomModel: tab.customModel ?? session.customModel,
		sessionCustomEffort: tab.customEffort ?? session.customEffort,
		sessionCustomContextWindow: session.customContextWindow,
		sessionSshRemoteConfig: session.sessionSshRemoteConfig,
		sendPromptViaStdin,
		sendPromptViaStdinRaw,
	};
}
