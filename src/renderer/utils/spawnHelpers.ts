import { gitService } from '../services/git';
import { useSettingsStore } from '../stores/settingsStore';
import type { AITab } from '../types';
import { getSessionSshRemoteId } from './sessionHelpers';
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

/**
 * The MaestroRun launcher while it is installed, verified, and granted on the
 * Maestro machine, else undefined. Asked on every spawn (never cached here):
 * main owns the answer and re-inspects it when it is stale, so a grant the user
 * just switched on, or just revoked, is reflected in the next agent's prompt.
 */
async function getMaestroRunReadyPath(): Promise<string | undefined> {
	try {
		return (await window.maestro.maestroRun.readyPath()) || undefined;
	} catch {
		// Older preload or main not ready: not ready, so the section stays out.
		return undefined;
	}
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
 * The agent's User Journey file for {{AGENT_JOURNEY_PATH}}, shared by the spawn
 * and the Maestro Prompts preview. Undefined for an SSH agent (the path is on
 * this machine) or when the lookup fails.
 */
export async function loadJourneyFilePath(
	agentId: string,
	isSsh: boolean
): Promise<string | undefined> {
	if (isSsh) return undefined;
	try {
		return (await window.maestro.journey.getPath(agentId)) || undefined;
	} catch {
		// Ignore journey errors
		return undefined;
	}
}

/**
 * Prepare the Maestro system prompt for an agent spawn.
 *
 * Loads the prompt template, resolves git branch, history and journey file
 * paths, and conductor profile, then hands everything to the shared assembler
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
		sessionSshRemoteConfig?: { enabled: boolean; remoteId?: string | null } | null;
		aiTabs?: Pick<AITab, 'id' | 'agentSessionId'>[];
		orphanedThinkingTabs?: Pick<AITab, 'id' | 'agentSessionId'>[];
	};
	activeTabId?: string;
}): Promise<string | undefined> {
	// Configuration chooses the next AI launch. Observed sshRemoteId/remoteCwd
	// may belong to a previous connection or the terminal's current directory.
	const isSsh = opts.session.sessionSshRemoteConfig?.enabled === true;
	const sshRemoteId = isSsh
		? getSessionSshRemoteId({
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: opts.session.sessionSshRemoteConfig?.remoteId ?? null,
				},
			})
		: undefined;
	const selectedTab = opts.activeTabId
		? (opts.session.aiTabs?.find((tab) => tab.id === opts.activeTabId) ??
			opts.session.orphanedThinkingTabs?.find((tab) => tab.id === opts.activeTabId))
		: undefined;
	const templateSession = {
		...opts.session,
		// An explicit new/missing tab must not inherit another tab's native identity.
		// Headless callers retain their legacy session-level identity.
		agentSessionId: opts.activeTabId
			? (selectedTab?.agentSessionId ?? undefined)
			: opts.session.agentSessionId,
	};
	const result = await window.maestro.prompts.get(PROMPT_IDS.MAESTRO_SYSTEM_PROMPT);
	if (!result.success || !result.content) return undefined;

	let gitBranch: string | undefined;
	// An unresolved SSH selection must never query the local repository.
	if (opts.session.isGitRepo && (!isSsh || sshRemoteId)) {
		try {
			const status = sshRemoteId
				? await gitService.getStatus(templateSession.cwd, sshRemoteId)
				: await gitService.getStatus(templateSession.cwd);
			gitBranch = status.branch;
		} catch {
			// Ignore git errors
		}
	}

	// History file path for task recall - skip for SSH (path is local-only)
	let historyFilePath: string | undefined;
	if (!isSsh) {
		try {
			historyFilePath = (await window.maestro.history.getFilePath(opts.session.id)) || undefined;
		} catch {
			// Ignore history errors
		}
	}

	const journeyFilePath = await loadJourneyFilePath(opts.session.id, isSsh);

	const { conductorProfile, encoreFeatures } = useSettingsStore.getState();

	// The pinned Pianola manager agent gets its manager instructions appended on
	// top of the standard Maestro system context. This is what turns a plain
	// Claude Code chat into Maestro's orchestrator. The CLI path and the agent's
	// own id are supplied to the spawn as env vars (see process.ts), so the
	// prompt references them as shell variables, not template variables.
	// Only while the `pianola` flag is on: a dormant Pianola gets no manager role.
	const roleSections =
		opts.session.isPianola && encoreFeatures?.pianola === true
			? [await loadPrompt(PROMPT_IDS.PIANOLA_SYSTEM)]
			: [];

	// Only asked when the feature is on, so every other spawn skips the round trip.
	const maestroRunPath =
		!isSsh && encoreFeatures?.maestroRun === true ? await getMaestroRunReadyPath() : undefined;
	const sectionRefs = systemPromptSectionsFor(encoreFeatures, {
		isSsh,
		readyFlags: maestroRunPath ? ['maestroRun'] : [],
	});
	const pluginSections = await Promise.all(sectionRefs.map((ref) => loadPrompt(ref.promptId)));
	// Only a local agent's shell can reach the store on this machine.
	const computerHistoryDir = isSsh ? undefined : await getComputerHistoryDir();

	return assembleMaestroSystemPrompt({
		template: result.content,
		context: {
			// Keep the shared assembler's path/name aliases unchanged.
			session: templateSession as any,
			gitBranch,
			groupId: opts.session.groupId,
			activeTabId: opts.activeTabId,
			historyFilePath,
			journeyFilePath,
			conductorProfile,
			computerHistoryDir,
			maestroRunPath,
		},
		roleSections,
		pluginSections,
	});
}
