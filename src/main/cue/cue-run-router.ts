/**
 * One routing path from a fired Cue subscription to the executor that runs it
 * (notify / shell command / maestro-cli command / agent prompt), shared by the
 * desktop app (`src/main/index.ts`) and the standalone runner
 * (`src/cli/services/cue-standalone-engine.ts`). The two used to carry their
 * own copies of this closure, and the copies had already drifted (the
 * standalone one never passed the conductor profile to templates).
 *
 * What genuinely differs between the two runners is injected, never branched
 * on here: where sessions come from, how a toast is delivered (a desktop
 * window, or a log line on a headless host), how an agent binary is found,
 * and what an auth failure does.
 *
 * Two import rules keep this file usable from both runners:
 * - No Electron, not even as a type. `cue-electron-imports.test.ts` is a
 *   shrink-only ratchet, so the notify path is an `onNotify` callback rather
 *   than a `BrowserWindow` parameter.
 * - Executors are TYPE imports only and arrive through
 *   {@link CueRunActionDeps}. The standalone runner loads them dynamically so
 *   `electron-store` stays out of the CLI bundle's static graph (see
 *   `loadExecutors()` in `cue-standalone-engine.ts`).
 */

import * as os from 'os';
import type { CueEngineDeps } from './cue-engine';
import type {
	executeCuePrompt as ExecuteCuePrompt,
	stopCueRun as StopCueRun,
} from './cue-executor';
import type { executeCueShell as ExecuteCueShell } from './cue-shell-executor';
import type { executeCueCli as ExecuteCueCli } from './cue-cli-executor';
import type { CueNotifyExecutionConfig } from './cue-notify-executor';
import type { SshRemoteSettingsStore } from '../utils/ssh-remote-resolver';
import type { TemplateContext } from '../../shared/templateVariables';
import type { CueRunResult } from '../../shared/cue/contracts';
import type { ToolType } from '../../shared/types';
import { getAgentDisplayName } from '../../shared/agentMetadata';

/** What `CueEngine` hands its `onCueRun` dependency for one run. */
export type OnCueRunParams = Parameters<CueEngineDeps['onCueRun']>[0];

/** The persisted agent fields a Cue run reads. Both runners' stored session records satisfy it. */
export interface CueRunSessionRecord {
	id: string;
	name: string;
	toolType: ToolType;
	cwd?: string;
	projectRoot?: string;
	fullPath?: string;
	autoRunFolderPath?: string;
	sessionSshRemoteConfig?: { enabled: boolean; remoteId: string | null };
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	customModel?: string;
	customEffort?: string;
	enableMaestroP?: boolean;
	maestroPMode?: 'interactive' | 'dynamic';
	maestroPPath?: string;
}

/** A notify run's executor config minus the delivery target, which only the runner knows. */
export type CueNotifyParams = Omit<CueNotifyExecutionConfig, 'mainWindow'>;

export interface CueRunActionDeps {
	executeCuePrompt: typeof ExecuteCuePrompt;
	executeCueShell: typeof ExecuteCueShell;
	executeCueCli: typeof ExecuteCueCli;
	/** Not called by the router; carried so each runner's executor set travels as one object (see `onStopCueRun`). */
	stopCueRun: typeof StopCueRun;
	/** Look up the target agent's persisted record. Read per run, so an edit made while the engine runs is honored. */
	findSession: (sessionId: string) => CueRunSessionRecord | undefined;
	/**
	 * Fallback binary lookup when the agent's config sets no `customPath`. The
	 * desktop probes with its agent detector; without one, the bare command
	 * name is left to `spawn()`'s own PATH search.
	 */
	resolveAgentPath?: (toolType: string) => Promise<string | undefined> | string | undefined;
	sshStore: SshRemoteSettingsStore;
	getAgentConfigValues: (toolType: string) => Record<string, unknown>;
	onLog: (level: string, message: string) => void;
	/** Read on EVERY run, never cached at boot, so a profile edit applies to the next run. */
	getConductorProfile?: () => string | undefined;
	onNotify: (params: CueNotifyParams) => Promise<CueRunResult>;
	/**
	 * Hand prompt and shell runs only the server-mode env allowlist. Omit to
	 * leave it to `MAESTRO_SERVER_MODE` (see `isServerModeActive`).
	 */
	isServerMode?: boolean;
	reportAuthFailure?: (
		result: CueRunResult,
		toolType: string,
		sshRemoteId?: string
	) => Promise<void>;
}

export async function executeCueRunAction(
	deps: CueRunActionDeps,
	{
		runId,
		sessionId,
		prompt,
		subscriptionName,
		event,
		timeoutMs,
		action,
		command,
		notify,
	}: OnCueRunParams
): Promise<CueRunResult> {
	const storedSession = deps.findSession(sessionId);
	if (!storedSession) {
		throw new Error(`Cue target session not found: ${sessionId}`);
	}

	const projectRoot =
		storedSession.projectRoot || storedSession.cwd || storedSession.fullPath || os.homedir();
	const templateContext: TemplateContext = {
		session: {
			id: storedSession.id,
			name: storedSession.name,
			toolType: storedSession.toolType,
			cwd: projectRoot,
			projectRoot,
			fullPath: storedSession.fullPath,
			autoRunFolderPath: storedSession.autoRunFolderPath,
		},
		conductorProfile: deps.getConductorProfile?.(),
	};
	const sessionInfo = {
		id: storedSession.id,
		name: storedSession.name,
		toolType: storedSession.toolType,
		cwd: projectRoot,
		projectRoot,
		autoRunFolderPath: storedSession.autoRunFolderPath,
	};

	// `action: notify` surfaces a toast through the owning agent instead of
	// spawning anything - handled before command/prompt so the spawn config,
	// SSH wrap, and history-recording paths below stay agent-only. The
	// notify message is pre-resolved by the dispatch service via the
	// fallback chain (notify.message → label → prompt → name); falling
	// back here to `prompt` (which the dispatcher uses as the carrier)
	// covers the queue-restored corner where the in-memory `notify` was
	// lost but the message survived in the persisted `prompt` slot.
	if (action === 'notify') {
		// No History write here: Cue runs are served to History from
		// `cue_events` (see `getCueHistoryEntries`), so the agent's JSONL
		// file keeps only USER/AUTO entries and CUE rows can no longer
		// evict them.
		return deps.onNotify({
			runId,
			session: sessionInfo,
			subscription: {
				name: subscriptionName,
				event: event.type,
				enabled: true,
				prompt,
				action,
				notify,
				agent_id: storedSession.id,
			},
			event,
			agentId: storedSession.id,
			message: notify?.message?.trim() || prompt,
			sticky: notify?.sticky === true,
			title: storedSession.name || getAgentDisplayName(storedSession.toolType),
			onLog: deps.onLog,
		});
	}

	// `action: command` runs a shell command or maestro-cli call instead of an
	// AI prompt - skip agent path resolution and SSH wrapping.
	if (action === 'command') {
		if (!command) {
			// Should be unreachable post-validator, but guard anyway so a
			// misconfigured subscription fails loudly instead of silently
			// executing `prompt` (a shell/cli sentinel) as an AI prompt.
			throw new Error(
				`Cue subscription "${subscriptionName}" has action='command' but no command payload`
			);
		}
		const subscription = {
			name: subscriptionName,
			event: event.type,
			enabled: true,
			prompt,
			action,
			command,
		};
		// History reads Cue runs from `cue_events`, not the JSONL file -
		// see the note on the notify path above.
		return command.mode === 'shell'
			? deps.executeCueShell({
					runId,
					session: sessionInfo,
					subscription,
					event,
					shellCommand: command.shell,
					projectRoot,
					templateContext,
					timeoutMs,
					onLog: deps.onLog,
					// Forward SSH config so shell commands run on the remote
					// host when the owning session is SSH-remote-enabled.
					sshRemoteConfig: storedSession.sessionSshRemoteConfig,
					sshStore: deps.sshStore,
					isServerMode: deps.isServerMode,
				})
			: deps.executeCueCli({
					runId,
					session: sessionInfo,
					subscription,
					event,
					cli: command.cli,
					templateContext,
					timeoutMs,
					onLog: deps.onLog,
					// CLI mode intentionally stays local: `maestro-cli send`
					// targets the local Maestro daemon (routing messages to
					// sessions managed by this app), so SSH wrapping would
					// point at the wrong daemon and `maestro-cli.js` may not
					// exist on the remote host.
				});
	}

	const agentConfigValues = deps.getAgentConfigValues(storedSession.toolType);

	// Resolve the agent's binary path. Without this, Cue falls back to the bare
	// command name (e.g., 'claude'), which fails with ENOENT when spawn() can't
	// find it on PATH.
	let resolvedAgentPath =
		typeof agentConfigValues.customPath === 'string' && agentConfigValues.customPath
			? agentConfigValues.customPath
			: undefined;
	if (!resolvedAgentPath && deps.resolveAgentPath) {
		resolvedAgentPath = (await deps.resolveAgentPath(storedSession.toolType)) || undefined;
	}

	const result = await deps.executeCuePrompt({
		runId,
		session: sessionInfo,
		subscription: {
			name: subscriptionName,
			event: event.type,
			enabled: true,
			prompt,
		},
		event,
		promptPath: prompt,
		toolType: storedSession.toolType,
		projectRoot,
		templateContext,
		timeoutMs,
		sshRemoteConfig: storedSession.sessionSshRemoteConfig,
		customPath: resolvedAgentPath,
		customArgs: storedSession.customArgs,
		customEnvVars: storedSession.customEnvVars,
		customModel: storedSession.customModel,
		customEffort: storedSession.customEffort,
		// Claude token-source selection (TUI / API / dynamic), read from
		// the same persisted session record that supplies customModel
		// above, so Cue runs honor the triggering agent's choice.
		enableMaestroP: storedSession.enableMaestroP,
		maestroPMode: storedSession.maestroPMode,
		maestroPPath: storedSession.maestroPPath,
		onLog: deps.onLog,
		sshStore: deps.sshStore,
		agentConfigValues,
		isServerMode: deps.isServerMode,
	});

	// Cue spawns agents outside the ProcessManager, so a failed run is the
	// only place an expired token can surface for a pipeline. Without this
	// the whole board goes quietly red until someone types a message. The
	// remote id is forwarded only while SSH is enabled: a disabled config
	// still carries its old id, and the run happened locally.
	const ssh = storedSession.sessionSshRemoteConfig;
	await deps.reportAuthFailure?.(
		result,
		storedSession.toolType,
		ssh?.enabled ? (ssh.remoteId ?? undefined) : undefined
	);

	// History reads Cue runs from `cue_events`, not the JSONL file -
	// see the note on the notify path above.
	return result;
}
