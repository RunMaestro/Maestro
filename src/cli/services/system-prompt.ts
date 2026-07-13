// Build the Maestro system prompt for CLI-spawned agents.
//
// Mirrors `src/renderer/utils/spawnHelpers.ts:prepareMaestroSystemPrompt` so a
// bot driving Maestro through `maestro-cli send` or Auto Run sees the same
// Maestro context — agent identity, git branch, history-file pointer,
// conductor profile, prompt customizations — that a desktop-spawned agent
// receives. Without this, CLI-spawned agents are missing the entire "what is
// Maestro and what can I do with it" preamble.

import path from 'path';
import fs from 'fs';
import type { SessionInfo } from '../../shared/types';
import { substituteTemplateVariables } from '../../shared/templateVariables';
import { PROMPT_IDS } from '../../shared/promptDefinitions';
import { sanitizeSessionId } from '../../shared/history';
import { getCliPrompt } from './prompt-loader';
import { getConfigDirectory, readSettingValue } from './storage';
import { getGitBranch, isGitRepo } from './git-utils';

/**
 * Resolve the absolute path of an existing per-session history file, mirroring
 * `HistoryManager.getHistoryFilePath` in `src/main/history-manager.ts`. Returns
 * undefined when the file does not yet exist (e.g. a brand-new session) so the
 * `{{AGENT_HISTORY_PATH}}` placeholder renders as an empty string — matching
 * the renderer-side helper, which also returns undefined in that case.
 */
function getHistoryFilePath(sessionId: string): string | undefined {
	const filePath = path.join(
		getConfigDirectory(),
		'history',
		`${sanitizeSessionId(sessionId)}.json`
	);
	try {
		fs.accessSync(filePath, fs.constants.R_OK);
		return filePath;
	} catch {
		return undefined;
	}
}

/**
 * Build the Maestro system prompt to pass via `appendSystemPrompt` when
 * spawning a CLI agent. Returns undefined if the prompt template fails to
 * load (caller should treat that as "spawn without the system prompt" rather
 * than aborting the whole send).
 *
 * Loads via `getCliPrompt()` so user customizations from Settings → Maestro
 * Prompts win over the bundled default, and `{{REF:name}}` directives are
 * expanded to absolute on-disk paths the agent can read with its file tools.
 */
export async function prepareMaestroSystemPromptCli(
	session: SessionInfo
): Promise<string | undefined> {
	let template: string;
	try {
		template = await getCliPrompt(PROMPT_IDS.MAESTRO_SYSTEM_PROMPT);
	} catch (err) {
		// `getCliPrompt` throws a known "Failed to load prompt …" Error when no
		// candidate file is readable. That's the only failure mode we want to
		// treat as non-fatal — anything else (TypeError, parse bug, etc.) is a
		// real defect and should bubble up to the caller's error handler rather
		// than masquerade as "prompt missing". Log the swallow so the user has
		// a breadcrumb when their relay bot suddenly loses Maestro context.
		if (err instanceof Error && err.message.startsWith('Failed to load prompt')) {
			console.error(`[maestro-cli] ${err.message}; spawning without Maestro system prompt`);
			return undefined;
		}
		throw err;
	}

	const sessionIsGitRepo = isGitRepo(session.cwd);
	const gitBranch = sessionIsGitRepo ? getGitBranch(session.cwd) : undefined;

	// Skip the history-file pointer for SSH sessions — the path is local to the
	// Maestro app's machine, not the remote where the agent will actually run.
	const isSsh = !!session.sessionSshRemoteConfig?.enabled;
	const historyFilePath = isSsh ? undefined : getHistoryFilePath(session.id);

	const conductorProfileSetting = readSettingValue('conductorProfile');
	const conductorProfile =
		typeof conductorProfileSetting === 'string' ? conductorProfileSetting : undefined;

	return substituteTemplateVariables(template, {
		session: {
			id: session.id,
			name: session.name,
			toolType: session.toolType,
			cwd: session.cwd,
			projectRoot: session.projectRoot,
			autoRunFolderPath: session.autoRunFolderPath,
			additionalDirectories: session.additionalDirectories,
			isGitRepo: sessionIsGitRepo,
		},
		gitBranch,
		groupId: session.groupId,
		historyFilePath,
		conductorProfile,
	});
}
