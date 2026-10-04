import { gitService } from '../services/git';
import { useSettingsStore } from '../stores/settingsStore';
import { PROMPT_IDS } from '../../shared/promptDefinitions';
import {
	assembleMaestroSystemPrompt,
	systemPromptSectionsFor,
} from '../../shared/maestroSystemPrompt';

/**
 * `<userData>/computer-history`, fetched from main once per renderer lifetime
 * (the userData path never changes while the app runs). Undefined when main
 * cannot answer; a failed lookup is retried on the next spawn.
 */
let computerHistoryDirPromise: Promise<string | undefined> | null = null;
async function fetchComputerHistoryDir(): Promise<string | undefined> {
	try {
		const result = await window.maestro.prompts.getSystemPromptPaths();
		return result?.success && result.computerHistoryDir ? result.computerHistoryDir : undefined;
	} catch {
		// Older preload or main not ready.
		return undefined;
	}
}
async function getComputerHistoryDir(): Promise<string | undefined> {
	const pending = computerHistoryDirPromise ?? fetchComputerHistoryDir();
	computerHistoryDirPromise = pending;
	const dir = await pending;
	// Only a real answer is cached; a failed lookup is retried on the next spawn.
	if (!dir && computerHistoryDirPromise === pending) computerHistoryDirPromise = null;
	return dir;
}

/** A core prompt's text, or undefined when it cannot be loaded. */
async function loadPrompt(id: string): Promise<string | undefined> {
	try {
		const result = await window.maestro.prompts.get(id);
		return result.success && result.content ? result.content : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Prepare the Maestro system prompt for an agent spawn.
 *
 * Loads the prompt template, resolves git branch, history file path,
 * and conductor profile, then hands everything to the shared assembler
 * (`src/shared/maestroSystemPrompt.ts`), which also appends the Pianola role
 * section and every enabled first-party plugin section.
 *
 * Must be called on every spawn (fresh AND resume): agents like Claude Code
 * deliver system prompts via a per-invocation flag (`--append-system-prompt`)
 * that is NOT persisted into the session transcript, so resuming with
 * `--resume` does not carry the prompt forward. Skipping on resume silently
 * drops all Maestro system-prompt content from turn 2 onward.
 *
 * Returns undefined only if the prompt template cannot be loaded.
 *
 * Every spawn site that creates or resumes an interactive or batch session
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
}): Promise<string | undefined> {
	const result = await window.maestro.prompts.get(PROMPT_IDS.MAESTRO_SYSTEM_PROMPT);
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

	// History file path for task recall - skip for SSH (path is local-only)
	let historyFilePath: string | undefined;
	const isSsh = !!(opts.session.sshRemoteId || opts.session.sessionSshRemoteConfig?.enabled);
	if (!isSsh) {
		try {
			historyFilePath = (await window.maestro.history.getFilePath(opts.session.id)) || undefined;
		} catch {
			// Ignore history errors
		}
	}

	const { conductorProfile, encoreFeatures } = useSettingsStore.getState();

	// The pinned Pianola manager agent gets its manager instructions appended on
	// top of the standard Maestro system context. This is what turns a plain
	// Claude Code chat into Maestro's orchestrator. The CLI path and the agent's
	// own id are supplied to the spawn as env vars (see process.ts), so the
	// prompt references them as shell variables, not template variables.
	const roleSections = opts.session.isPianola ? [await loadPrompt(PROMPT_IDS.PIANOLA_SYSTEM)] : [];

	const sectionRefs = systemPromptSectionsFor(encoreFeatures, { isSsh });
	const pluginSections = await Promise.all(sectionRefs.map((ref) => loadPrompt(ref.promptId)));
	// Only a local agent's shell can reach the store on this machine.
	const computerHistoryDir = isSsh ? undefined : await getComputerHistoryDir();

	return assembleMaestroSystemPrompt({
		template: result.content,
		context: {
			session: opts.session as any,
			gitBranch,
			groupId: opts.session.groupId,
			activeTabId: opts.activeTabId,
			historyFilePath,
			conductorProfile,
			computerHistoryDir,
		},
		roleSections,
		pluginSections,
	});
}
