/**
 * What Maestro attaches to its Sentry events beyond the SDK defaults, as pure
 * functions so the shape can be tested without an Electron or Sentry runtime.
 *
 * Privacy contract: nothing here may carry a path, a prompt, an agent name, or
 * anything a user typed. The identity is the random per-install GUID that is
 * already the `installationId` tag, and the agent context is counts plus agent
 * TYPE ids drawn from the fixed `AGENT_IDS` list.
 *
 * Noise filtering lives in `sentryFilters.ts` and issue grouping in
 * `sentryGrouping.ts`; this module only adds context to events that are going
 * to be sent anyway.
 */

import { isValidAgentId } from './agentIds';

/**
 * The Sentry `user` for this install. Sentry's Users column, "users affected"
 * alert conditions, and crash-free-user rates all count `user.id`, so without
 * it every issue reads "Users 0" no matter how many installs hit it. The id is
 * the install GUID, never anything about the person.
 */
export function sentryUserForInstallation(
	installationId: string | null | undefined
): { id: string } | undefined {
	const id = typeof installationId === 'string' ? installationId.trim() : '';
	return id ? { id } : undefined;
}

/** Background work in flight, derived from the power manager's block reasons. */
export interface SentryWorkContext {
	/**
	 * Agents running an Auto Run right now (one `autorun:` reason per agent, held
	 * from the run's start to its end). Desktop Auto Runs only: a CLI playbook
	 * run is a separate process and never registers a reason here.
	 */
	autorunRuns: number;
	/**
	 * Agent processes running (one `session:` reason per spawned process, keyed
	 * by the PROCESS id). An agent with two busy tabs counts twice, and Auto Run
	 * tasks, consults and group chat participants count too, so this is load,
	 * not a count of agents.
	 */
	agentProcesses: number;
	/** Cue runs executing. */
	cueRuns: number;
	/** Group chat rounds in flight. */
	groupChats: number;
}

/**
 * Count the work behind the power manager's block reasons. Those reasons are
 * the one place in the main process that already learns when an Auto Run, an
 * agent turn, a Cue run, or a group chat round starts and stops (see the
 * naming convention in `power-manager.ts`), and they are recorded whether or
 * not the user enabled sleep prevention. Only the prefix is read; the ids after
 * it never leave this function.
 */
export function summarizeWorkReasons(reasons: Iterable<string>): SentryWorkContext {
	const context: SentryWorkContext = {
		autorunRuns: 0,
		agentProcesses: 0,
		cueRuns: 0,
		groupChats: 0,
	};
	for (const reason of reasons) {
		if (reason.startsWith('autorun:')) context.autorunRuns += 1;
		else if (reason.startsWith('session:')) context.agentProcesses += 1;
		else if (reason.startsWith('cue:run:')) context.cueRuns += 1;
		else if (reason.startsWith('groupchat:')) context.groupChats += 1;
	}
	return context;
}

/** Sentry tags for the work context. Tags (not contexts) so issues and alerts can filter on them. */
export function workContextTags(context: SentryWorkContext): Record<string, string> {
	return {
		'autorun.count': String(context.autorunRuns),
		'agents.processes': String(context.agentProcesses),
		'cue.active': context.cueRuns > 0 ? 'true' : 'false',
		'groupchat.active': context.groupChats > 0 ? 'true' : 'false',
	};
}

/** The configured agents, reduced to what is safe to report. */
export interface SentryAgentInventory {
	count: number;
	/** Distinct agent type ids, sorted. Unknown values collapse to `other`. */
	providers: string[];
}

/**
 * Reduce the stored agent list to a count and the set of provider TYPE ids.
 * `toolType` comes off disk, so anything that is not a known agent id is
 * reported as `other` rather than echoed: a hand-edited or corrupted store must
 * not be able to put arbitrary text into a crash report.
 */
export function summarizeAgentInventory(
	sessions: ReadonlyArray<{ toolType?: unknown }>
): SentryAgentInventory {
	const providers = new Set<string>();
	for (const session of sessions) {
		const toolType = session?.toolType;
		if (typeof toolType !== 'string' || toolType === '') continue;
		providers.add(isValidAgentId(toolType) ? toolType : 'other');
	}
	return { count: sessions.length, providers: [...providers].sort() };
}

/** Sentry tags for the agent inventory. */
export function agentInventoryTags(inventory: SentryAgentInventory): Record<string, string> {
	return {
		'agents.count': String(inventory.count),
		'agents.providers': inventory.providers.length > 0 ? inventory.providers.join(',') : 'none',
	};
}
