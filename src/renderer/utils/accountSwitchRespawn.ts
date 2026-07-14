/**
 * Account switch respawn (Virtuosos).
 *
 * After the main process switches a session to a different account (throttle
 * or auth recovery), the renderer must respawn the agent and replay the
 * interrupted prompt. This helper builds that spawn config THROUGH the shared
 * buildSpawnConfigForAgent path so a respawned turn stays byte-for-byte
 * equivalent to a normal turn:
 *
 * - Windows stdin transport flags: cmd.exe caps the command line around 8191
 *   chars, and this path replays exactly the long interrupted prompts that
 *   hit that limit. Without the flags the replayed prompt can truncate or
 *   corrupt on argv.
 * - appendSystemPrompt: agents deliver system prompts per-invocation, so a
 *   resume without it silently drops the Maestro system prompt.
 * - images: an image-bearing turn must not resume as text-only.
 * - Per-tab model/effort overrides, matching agentStore.processQueuedItem.
 */

import type { Session, AITab, ProcessConfig } from '../types';
import { getActiveTab } from './tabHelpers';
import { buildSpawnConfigForAgent } from './sessionHelpers';
import { prepareMaestroSystemPrompt } from './spawnHelpers';

/** Subset of the account:switch-respawn payload needed to rebuild the turn. */
export interface AccountSwitchRespawnData {
	toAccountId: string;
	configDir: string;
	lastPrompt: string;
	lastImages?: string[] | null;
}

/**
 * Build the spawn config that replays the interrupted prompt on the new
 * account. Returns null when the session's agent is unavailable (the caller
 * surfaces the error).
 *
 * `tabOverride` should be the tab whose turn was interrupted (resolved from
 * the decorated process session id); without it the active tab is used.
 */
export async function buildAccountSwitchRespawnConfig(
	session: Session,
	data: AccountSwitchRespawnData,
	tabOverride?: AITab
): Promise<ProcessConfig | null> {
	const tab = tabOverride ?? getActiveTab(session);
	const targetSessionId = `${session.id}-ai-${tab?.id || 'default'}`;

	const appendSystemPrompt = await prepareMaestroSystemPrompt({
		session,
		activeTabId: tab?.id,
	});

	// Prefer the images recorded with the interrupted prompt (lastImages);
	// events that predate the field fall back to the tab's staged images so
	// an interrupted image turn retains its attachments.
	const images = data.lastImages ?? tab?.stagedImages;

	return buildSpawnConfigForAgent({
		sessionId: targetSessionId,
		toolType: session.toolType,
		cwd: session.cwd,
		prompt: data.lastPrompt,
		images: images && images.length > 0 ? images : undefined,
		appendSystemPrompt,
		agentSessionId: tab?.agentSessionId ?? undefined,
		readOnlyMode: tab?.readOnlyMode === true || tab?.permissionMode === 'readonly',
		permissionMode: tab?.permissionMode,
		sessionCustomPath: session.customPath,
		sessionCustomArgs: session.customArgs,
		sessionCustomEnvVars: {
			...session.customEnvVars,
			CLAUDE_CONFIG_DIR: data.configDir,
		},
		sessionCustomModel: tab?.customModel ?? session.customModel,
		sessionCustomEffort: tab?.customEffort ?? session.customEffort,
		sessionCustomContextWindow: session.customContextWindow,
		accountId: data.toAccountId,
		sessionSshRemoteConfig: session.sessionSshRemoteConfig,
		sshRemoteId: session.sshRemoteId,
	});
}
