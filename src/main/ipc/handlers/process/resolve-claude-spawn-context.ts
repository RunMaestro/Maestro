import Store from 'electron-store';
import type { AgentConfig } from '../../../agents/definitions';
import { resolveClaudeSpawnMode } from '../../../agents/resolveClaudeSpawnMode';
import { ensureRemoteMaestroPProbed } from '../../../agents/probeRemoteMaestroP';
import { getClaudeTokenMode } from '../../../../shared/claudeTokenMode';
import { resolveConfigDirKey } from '../../../stores/claudeUsageStore';
import { REGEX_AI_SUFFIX } from '../../../constants';
import {
	getSshRemoteConfig,
	createSshRemoteStoreAdapter,
} from '../../../utils/ssh-remote-resolver';
import { MaestroSettings } from '../persistence';
import { sanitizeClaudeTranscriptBeforeApiResume } from './claude-transcript-sanitize';
import type { SpawnProcessConfig } from './spawn-types';

/** Resolved Claude token-source state for a desktop spawn turn. */
export interface ClaudeSpawnContext {
	isClaudeCode: boolean;
	isSshEnabled: boolean;
	baseSessionId: string;
	claudeResolvedMode: 'interactive' | 'api';
	claudeResolvedReason: 'auto' | 'limit';
	resolvedMaestroPBinPath: string | null;
	resolvedConfigDirKey: string | undefined;
	claudeDecisionRealBinPath: string | undefined;
	claudeResolvedRemote: boolean;
}

type PersistedSessionRecord = {
	id?: string;
	enableMaestroP?: boolean;
	maestroPMode?: 'interactive' | 'dynamic';
	maestroPPath?: string;
	claudeInteractive?: {
		mode?: 'interactive' | 'api';
		modeReason?: 'auto' | 'limit';
	};
};

/**
 * Resolve Claude Code token source (maestro-p TUI vs `claude --print`) and
 * sanitize API-resume transcripts when needed.
 */
export async function resolveClaudeSpawnContext(
	config: SpawnProcessConfig,
	agent: AgentConfig | null,
	deps: {
		sessionsStore: Store<{ sessions: unknown[] }>;
		settingsStore: Store<MaestroSettings>;
	}
): Promise<ClaudeSpawnContext> {
	const isClaudeCode =
		agent?.id === 'claude-code' && !!agent?.interactiveCommand && !!agent?.interactiveModeArgs;
	const isSshEnabled = !!config.sessionSshRemoteConfig?.enabled;
	// Desktop turns spawn with a COMPOUND session id (`{agentId}-ai-{tabId}`,
	// built in agentStore.processQueuedItem), but persisted session records are
	// keyed by the bare agent id. Strip the `-ai-…` suffix so both the token-mode
	// lookup and the `claudeInteractive` write-back below match the right record.
	// Without this every desktop claude-code turn missed the persisted record,
	// fell through to the inline `config.enableMaestroP` (which the desktop caller
	// never sends), and silently resolved to `api` (`claude --print`) even when the
	// agent was set to TUI/Dynamic. Background surfaces (tab naming, synopsis, group
	// chat, Cue) pass their token-mode fields inline, so they were unaffected. The
	// renderer mirror (`process:claude-mode-resolved`) already strips this suffix on
	// its side, so it still receives `config.sessionId` unchanged.
	const baseSessionId = config.sessionId.replace(REGEX_AI_SUFFIX, '');

	let claudeResolvedMode: 'interactive' | 'api' = 'api';
	let claudeResolvedReason: 'auto' | 'limit' = 'auto';
	let resolvedMaestroPBinPath: string | null = null;
	let resolvedConfigDirKey: string | undefined;
	// The real claude binary maestro-p should drive, as decided by the
	// resolver. Consumed by the interactive command swap below.
	let claudeDecisionRealBinPath: string | undefined;
	// Interactive resolved for an SSH remote spawn: maestro-p runs on the
	// remote host (not a local script). Realized in the SSH block below.
	let claudeResolvedRemote = false;

	// Resolve the Claude token source (maestro-p TUI vs `claude --print`)
	// through the shared resolver. Token-mode fields are read from the
	// persisted session record (authoritative) with the spawn payload as
	// a fallback, so every desktop spawn surface that reaches this handler
	// (main turn, Auto Run, background synopsis) honors the per-agent
	// selection. The resolver folds in the former three branches:
	// dynamic/interactive selection, the direct-maestro-p-Path power-user
	// case, and stale `claudeInteractive` cleanup.
	if (isClaudeCode) {
		const persistedSession = (
			deps.sessionsStore.get('sessions', []) as PersistedSessionRecord[]
		).find((s) => s?.id === baseSessionId);

		// Over SSH, warm the remote maestro-p probe BEFORE resolving so the
		// resolver's TUI->API backstop fires on the very first spawn - the
		// readiness probe / config modal that would otherwise warm the cache
		// may never have run (app just launched, agent sent to directly).
		// Without this an unconfigured/interactive SSH agent resolves to the
		// remote TUI on a cold cache and exits 127 when maestro-p is absent.
		let remoteMaestroPAvailable: boolean | undefined;
		if (isSshEnabled) {
			const sshRemote = getSshRemoteConfig(createSshRemoteStoreAdapter(deps.settingsStore), {
				sessionSshConfig: config.sessionSshRemoteConfig,
			}).config;
			if (sshRemote) {
				remoteMaestroPAvailable = await ensureRemoteMaestroPProbed(sshRemote);
			}
		}

		const tokenMode = getClaudeTokenMode(
			{
				enableMaestroP: persistedSession?.enableMaestroP ?? config.enableMaestroP,
				// Fall back to the inline config when the persisted lookup misses
				// (e.g. background synopsis spawns under a synthetic sessionId that
				// won't match any persisted session, so they forward the token-mode
				// fields explicitly on the spawn payload).
				maestroPMode: persistedSession?.maestroPMode ?? config.maestroPMode,
			},
			// Remote agents default to the TUI when the user hasn't chosen,
			// unless the remote has no maestro-p to run it (then API).
			{ sshEnabled: isSshEnabled, sshMaestroPAvailable: remoteMaestroPAvailable }
		);

		const decision = resolveClaudeSpawnMode({
			agent,
			tokenMode,
			sshEnabled: isSshEnabled,
			// Lets the resolver fall a remote TUI spawn back to API when the
			// remote has no maestro-p on its PATH (avoids exit 127).
			sshRemoteId: config.sessionSshRemoteConfig?.remoteId ?? undefined,
			command: config.command,
			sessionCustomPath: config.sessionCustomPath,
			sessionCustomEnvVars: config.sessionCustomEnvVars,
			maestroPPath: persistedSession?.maestroPPath ?? config.maestroPPath,
			persisted: persistedSession?.claudeInteractive,
			now: new Date(),
		});

		claudeResolvedMode = decision.mode;
		claudeResolvedReason = decision.reason;
		resolvedMaestroPBinPath = decision.maestroPBinPath;
		resolvedConfigDirKey = decision.configDirKey;
		claudeDecisionRealBinPath = decision.claudeRealBinPath;
		claudeResolvedRemote = !!decision.remote;
	}

	// Resuming a Claude Code conversation under the API token source? Strip
	// any subscription-account thinking shells first. The sanitizer is
	// narrowly scoped to empty-thinking blocks (maestro-p's signature-only
	// shells); validly-signed API thinking blocks always carry non-empty
	// reasoning text and are preserved, so this is safe to run on any
	// transcript - including pure-API sessions that never touched
	// Adaptive Mode. If `resolvedConfigDirKey` wasn't already computed
	// (Batch Mode currently off, no maestro-p Path, no stale interactive
	// state), compute it now so we can locate the transcript on disk.
	if (claudeResolvedMode === 'api' && config.agentSessionId && isClaudeCode && !isSshEnabled) {
		const configDirKey =
			resolvedConfigDirKey ??
			resolveConfigDirKey({
				...(process.env as NodeJS.ProcessEnv),
				...(agent?.defaultEnvVars ?? {}),
				...(config.sessionCustomEnvVars ?? {}),
			});
		sanitizeClaudeTranscriptBeforeApiResume({
			configDirKey,
			cwd: config.cwd,
			agentSessionId: config.agentSessionId,
			sessionId: config.sessionId,
		});
	}

	return {
		isClaudeCode,
		isSshEnabled,
		baseSessionId,
		claudeResolvedMode,
		claudeResolvedReason,
		resolvedMaestroPBinPath,
		resolvedConfigDirKey,
		claudeDecisionRealBinPath,
		claudeResolvedRemote,
	};
}
