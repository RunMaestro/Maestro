// Build the Maestro system prompt for CLI-spawned agents.
//
// Mirrors `src/renderer/utils/spawnHelpers.ts:prepareMaestroSystemPrompt` so a
// bot driving Maestro through `maestro-cli send` or Auto Run sees the same
// Maestro context - agent identity, git branch, history-file pointer,
// conductor profile, prompt customizations - that a desktop-spawned agent
// receives. Without this, CLI-spawned agents are missing the entire "what is
// Maestro and what can I do with it" preamble.

import type { SessionInfo } from '../../shared/types';
import { PROMPT_IDS } from '../../shared/promptDefinitions';
import { computerHistoryDir } from '../../shared/computer-history/paths';
import {
	assembleMaestroSystemPrompt,
	systemPromptSectionsFor,
} from '../../shared/maestroSystemPrompt';
import { getCliPrompt } from './prompt-loader';
import { getConfigDirectory, readSettingValue, resolveSessionHistoryFilePath } from './storage';
import { getGitBranch, isGitRepo } from './git-utils';

/** True for the known "no readable prompt file" failure from `getCliPrompt`. */
function isPromptMissingError(err: unknown): err is Error {
	return err instanceof Error && err.message.startsWith('Failed to load prompt');
}

/**
 * A role or plugin section, or undefined when its prompt file is missing (a
 * section that does not exist yet must not cost the agent its whole system
 * prompt). Other errors propagate, same as the base template.
 */
async function loadSection(promptId: string): Promise<string | undefined> {
	try {
		return await getCliPrompt(promptId);
	} catch (err) {
		// "Unknown prompt ID" covers a section whose prompt this CLI build does
		// not know about (an older bundle than the app that enabled it).
		if (
			isPromptMissingError(err) ||
			(err instanceof Error && err.message.startsWith('Unknown prompt ID'))
		) {
			console.error(`[maestro-cli] ${err.message}; skipping that system prompt section`);
			return undefined;
		}
		throw err;
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
		// treat as non-fatal - anything else (TypeError, parse bug, etc.) is a
		// real defect and should bubble up to the caller's error handler rather
		// than masquerade as "prompt missing". Log the swallow so the user has
		// a breadcrumb when their relay bot suddenly loses Maestro context.
		if (isPromptMissingError(err)) {
			console.error(`[maestro-cli] ${err.message}; spawning without Maestro system prompt`);
			return undefined;
		}
		throw err;
	}

	const sessionIsGitRepo = isGitRepo(session.cwd);
	const gitBranch = sessionIsGitRepo ? getGitBranch(session.cwd) : undefined;

	// Skip the history-file pointer for SSH sessions - the path is local to the
	// Maestro app's machine, not the remote where the agent will actually run.
	// The Computer History store is local for the same reason.
	const isSsh = !!session.sessionSshRemoteConfig?.enabled;
	const historyFilePath = isSsh ? undefined : resolveSessionHistoryFilePath(session.id);

	const conductorProfileSetting = readSettingValue('conductorProfile');
	const conductorProfile =
		typeof conductorProfileSetting === 'string' ? conductorProfileSetting : undefined;

	// Same role and plugin sections the desktop appends (see spawnHelpers.ts).
	const roleSections = session.isPianola ? [await loadSection(PROMPT_IDS.PIANOLA_SYSTEM)] : [];
	const pluginSections: Array<string | undefined> = [];
	for (const ref of systemPromptSectionsFor(readSettingValue('encoreFeatures'), { isSsh })) {
		pluginSections.push(await loadSection(ref.promptId));
	}

	return assembleMaestroSystemPrompt({
		template,
		context: {
			session: {
				id: session.id,
				name: session.name,
				toolType: session.toolType,
				cwd: session.cwd,
				projectRoot: session.projectRoot,
				autoRunFolderPath: session.autoRunFolderPath,
				additionalDirectories: session.additionalDirectories,
				worktreeConfig: session.worktreeConfig,
				isGitRepo: sessionIsGitRepo,
			},
			gitBranch,
			groupId: session.groupId,
			historyFilePath,
			conductorProfile,
			computerHistoryDir: isSsh ? undefined : computerHistoryDir(getConfigDirectory()),
		},
		roleSections,
		pluginSections,
	});
}
