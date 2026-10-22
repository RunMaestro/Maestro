import { gitService } from '../services/git';
import { useSettingsStore } from '../stores/settingsStore';
import { useSessionStore } from '../stores/sessionStore';
import { PROMPT_IDS } from '../../shared/promptDefinitions';
import { resolvePeerRosterForPrompt } from '../../shared/peerAgents';
import type { ConsultBudgetStatus, ConsultChain } from '../../shared/consultBudget';
import type { SystemOneAgentAccess } from '../../shared/local-models/system-one-agent';
import {
	assembleMaestroSystemPrompt,
	coreSystemPromptContext,
	coreSystemPromptSectionsFor,
	systemPromptSectionsFor,
	type CoreSystemPromptInput,
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

/**
 * Whether a System One request from this agent would be answered right now, or
 * undefined when main cannot say. Asked on every spawn (never cached here):
 * main owns the answer, so an engine the user just switched off, an agent they
 * just opted out, or a budget that just ran out is gone from the next spawn's
 * prompt. It reads a small file and sends nothing to an engine.
 */
async function getSystemOneAccess(agentId: string): Promise<SystemOneAgentAccess | undefined> {
	try {
		return (await window.maestro.localModels.systemOne.agentAccess(agentId)) || undefined;
	} catch {
		// Older preload or main not ready: no answer, so the section stays out.
		return undefined;
	}
}

/**
 * Where the consultation budget stands for the turn about to be spawned, or
 * undefined when main cannot say. Asked on every spawn of an agent that has
 * peers (never cached here): the count moves with every consult in the chain.
 * Main owns the answer because the counter is a file and a root turn's chain
 * is minted in `process:spawn`, neither of which the renderer can see.
 */
async function getConsultBudget(
	consultChain: ConsultChain | undefined
): Promise<ConsultBudgetStatus | undefined> {
	try {
		return (await window.maestro.crossAgent.consultBudget(consultChain)) || undefined;
	} catch {
		// Older preload or main not ready: no answer, so the sentence stays out.
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
 * Prepare the Maestro system prompt for an agent spawn.
 *
 * Loads the prompt template, resolves git branch, history file path,
 * and conductor profile, then hands everything to the shared assembler
 * (`src/shared/maestroSystemPrompt.ts`), which also appends the Pianola role
 * section, the core sections that are ready for this agent (System One), and
 * every enabled first-party plugin section.
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
	/**
	 * The place this turn takes in a consult chain, when another agent delegated
	 * it (the same value the spawn sends as `consultChain`). Unset for a turn
	 * the user or an automation started: that turn roots a chain of its own.
	 */
	consultChain?: ConsultChain;
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
	// `maestro-cli s1` reaches this desktop, so an SSH agent is never asked about.
	const core: CoreSystemPromptInput = {
		isSsh,
		systemOne: isSsh ? undefined : await getSystemOneAccess(opts.session.id),
	};
	const coreSections = await Promise.all(
		coreSystemPromptSectionsFor(core).map((ref) => loadPrompt(ref.promptId))
	);
	// Only a local agent's shell can reach the store on this machine.
	const computerHistoryDir = isSsh ? undefined : await getComputerHistoryDir();

	// {{PEER_AGENTS}}. The grants come from the session being spawned; the
	// agent list comes from the store, because a group grant needs every
	// agent and the session carries only itself. The store is read only
	// when the agent has a grant.
	const peerRoster = resolvePeerRosterForPrompt(
		opts.session,
		() => useSessionStore.getState().sessions
	);
	// The budget sentence of that block. Only an agent that has peers pays the
	// round trip.
	const consultBudget = peerRoster?.length ? await getConsultBudget(opts.consultChain) : undefined;

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
			maestroRunPath,
			peerRoster,
			consultBudget,
			...coreSystemPromptContext(core),
		},
		roleSections,
		coreSections,
		pluginSections,
	});
}
