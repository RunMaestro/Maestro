/**
 * The agent a New Agent draft describes.
 *
 * Two create paths turn the New Agent modal's settings into an agent, and an
 * agent a script makes must come out the same as one made in the modal:
 *
 * - `createNewSession()` in `useSessionCrud.ts` (the New Agent modal)
 * - `maestro:remoteCreateSession` in `useAppRemoteEventListeners.ts` (the CLI /
 *   web `create_session` request: `maestro-cli create-agent` and
 *   `duplicate-agent`)
 *
 * Each path checks its own input and resolves it into a `NewAgentDraft` first.
 * This module only probes the working directory and builds the `Session`: it
 * adds nothing to the store and starts no process.
 */

import type { Session, ThinkingMode, ToolType } from '../types';
import type { NewAgentDraft } from '../components/NewInstanceModal/types';
import { buildNewAgentRecord, newAgentClaudeInteractive } from '../../shared/newAgentRecord';
import { definedOnly } from '../../shared/objectUtils';
import { gitService } from '../services/git';
import { generateId } from './ids';
import { permissionModeFields } from './tabHelpers/focusFields';

/** What a new agent knows about the git repository it starts in. */
export interface NewAgentGitState {
	isGitRepo: boolean;
	gitBranches?: string[];
	gitTags?: string[];
	gitRefsCacheTime?: number;
}

export interface NewAgentSessionContext {
	/** The new agent's id. */
	id: string;
	/** From `probeNewAgentGitState()`. */
	git: NewAgentGitState;
	/** `defaultSaveToHistory` from settings, for the initial tab. */
	saveToHistory?: boolean;
	/** `defaultShowThinking` from settings, for the initial tab. */
	showThinking?: ThinkingMode;
}

/** Whether the draft's agent runs on an SSH remote. */
export function isRemoteNewAgent(draft: Pick<NewAgentDraft, 'sessionSshRemoteConfig'>): boolean {
	const ssh = draft.sessionSshRemoteConfig;
	return !!(ssh?.enabled && ssh.remoteId);
}

/**
 * The git state of the draft's working directory, so the header shows the
 * branch instead of "LOCAL". An SSH agent starts as no repository: its
 * directory is on the remote, so the check waits until the remote connects
 * (`onSshRemote` in `useAgentListeners`). `gitService` reports an IPC failure
 * to Sentry and answers with its default instead of throwing.
 */
export async function probeNewAgentGitState(
	draft: Pick<NewAgentDraft, 'workingDir' | 'sessionSshRemoteConfig'>
): Promise<NewAgentGitState> {
	if (isRemoteNewAgent(draft)) return { isGitRepo: false };
	const isGitRepo = await gitService.isRepo(draft.workingDir);
	if (!isGitRepo) return { isGitRepo };
	const [gitBranches, gitTags] = await Promise.all([
		gitService.getBranches(draft.workingDir),
		gitService.getTags(draft.workingDir),
	]);
	return { isGitRepo, gitBranches, gitTags, gitRefsCacheTime: Date.now() };
}

/**
 * Build the agent a draft describes. Each value is stored as the draft holds
 * it, except the three opt-ins below, and a field the draft leaves unset
 * leaves no key on the record.
 */
export function buildNewAgentSession(
	draft: NewAgentDraft,
	context: NewAgentSessionContext
): Session {
	const { git } = context;
	const session: Session = {
		...buildNewAgentRecord(
			{
				id: context.id,
				name: draft.name,
				toolType: draft.agentId,
				cwd: draft.workingDir,
				groupId: draft.groupId,
				saveToHistory: context.saveToHistory,
				showThinking: context.showThinking,
			},
			{ generateId }
		),
		toolType: draft.agentId as ToolType,
		isGitRepo: git.isGitRepo,
		...definedOnly({
			gitBranches: git.gitBranches,
			gitTags: git.gitTags,
			gitRefsCacheTime: git.gitRefsCacheTime,
			additionalDirectories: draft.additionalDirectories,
			nudgeMessage: draft.nudgeMessage,
			newSessionMessage: draft.newSessionMessage,
			customPath: draft.customPath,
			customArgs: draft.customArgs,
			customEnvVars: draft.customEnvVars,
			customModel: draft.customModel,
			customContextWindow: draft.customContextWindow,
			customProviderPath: draft.customProviderPath,
			customEffort: draft.customEffort,
			sessionSshRemoteConfig: draft.sessionSshRemoteConfig,
			enableMaestroP: draft.enableMaestroP,
			maestroPPath: draft.maestroPPath,
			maestroPMode: draft.maestroPMode,
			// Agent Resilience: an absent flag reads as ON (`resilienceEnabled`), so
			// the default needs no stored value.
			retryOnAvailabilityErrors: draft.retryOnAvailabilityErrors,
			retryOnTokenExhaustion: draft.retryOnTokenExhaustion,
			// Only the opt-ins are stored. Absent already means the default (no
			// automatic reset, the `exec` transport, current control), so writing
			// the default onto every agent would be noise in every session record.
			codexAutoResetOnExhaustion: draft.codexAutoResetOnExhaustion === true ? true : undefined,
			codexTransport: draft.codexTransport === 'app-server' ? ('app-server' as const) : undefined,
			harnessControlMode: draft.harnessControlMode === 'native' ? ('native' as const) : undefined,
		}),
		claudeInteractive: newAgentClaudeInteractive(draft.agentId),
	};
	const { permissionMode } = draft;
	if (permissionMode === undefined) return session;
	return {
		...session,
		aiTabs: session.aiTabs.map((tab) => ({ ...tab, ...permissionModeFields(permissionMode) })),
	};
}
