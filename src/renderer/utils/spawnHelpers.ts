import { isWindowsPlatform } from './platformUtils';
import { substituteTemplateVariables } from './templateVariables';
import { gitService } from '../services/git';
import { useSettingsStore } from '../stores/settingsStore';

/**
 * Prepare the Maestro system prompt for a new agent session.
 *
 * Loads the prompt template, resolves git branch, history file path,
 * and conductor profile, then substitutes all template variables.
 *
 * Returns undefined if the session already has an agentSessionId (resume),
 * or if the prompt cannot be loaded.
 *
 * Every spawn site that creates a new interactive or batch session
 * MUST call this and pass the result as `appendSystemPrompt`.
 */
export async function prepareMaestroSystemPrompt(opts: {
	session: Record<string, any> & {
		id: string;
		cwd: string;
		isGitRepo?: boolean;
		groupId?: string;
		sshRemoteId?: string;
		sessionSshRemoteConfig?: { enabled: boolean } | null;
	};
	activeTabId?: string;
	agentSessionId?: string | null;
}): Promise<string | undefined> {
	// Only inject on new sessions
	if (opts.agentSessionId) return undefined;

	const result = await window.maestro.prompts.get('maestro-system-prompt');
	if (!result.success || !result.content) return undefined;

	let gitBranch: string | undefined;
	if (opts.session.isGitRepo) {
		try {
			const status = await gitService.getStatus(opts.session.cwd);
			gitBranch = status.branch;
		} catch {
			// Ignore git errors
		}
	}

	// History file path for task recall — skip for SSH (path is local-only)
	let historyFilePath: string | undefined;
	const isSSH = opts.session.sshRemoteId || opts.session.sessionSshRemoteConfig?.enabled;
	if (!isSSH) {
		try {
			historyFilePath = (await window.maestro.history.getFilePath(opts.session.id)) || undefined;
		} catch {
			// Ignore history errors
		}
	}

	const conductorProfile = useSettingsStore.getState().conductorProfile;

	return substituteTemplateVariables(result.content, {
		session: opts.session as any,
		gitBranch,
		groupId: opts.session.groupId,
		activeTabId: opts.activeTabId,
		historyFilePath,
		conductorProfile,
	});
}

/**
 * Compute stdin transport flags for spawning agents on Windows.
 *
 * On Windows the cmd.exe command line is limited to ~8 KB and special
 * characters cause escaping issues.  Sending the prompt via stdin
 * side-steps both problems.
 *
 * SSH sessions must NOT use these flags - they have a dedicated
 * stdin-script path handled by ChildProcessSpawner.
 *
 * Stream-json stdin is only used when images are present AND the agent
 * supports it. Text-only messages use raw stdin for efficiency (avoids
 * wrapping in API format JSON).
 */
export function getStdinFlags(opts: {
	isSshSession: boolean;
	supportsStreamJsonInput: boolean;
	hasImages: boolean;
}): {
	sendPromptViaStdin: boolean;
	sendPromptViaStdinRaw: boolean;
} {
	const isWindows = isWindowsPlatform();
	const useStdin = isWindows && !opts.isSshSession;

	return {
		// Only use stream-json stdin when there are images AND agent supports it
		sendPromptViaStdin: useStdin && opts.supportsStreamJsonInput && !!opts.hasImages,
		// Use raw stdin for text-only messages (or for agents that don't support stream-json)
		sendPromptViaStdinRaw: useStdin && (!opts.supportsStreamJsonInput || !opts.hasImages),
	};
}
