/**
 * The main-process check every provider launch for an existing agent record passes through when
 * it does not go through `process:spawn` (group chat, a consult, a Cue run, a groomed one-shot).
 *
 * It is keyed on the AGENT id, not on a process id prefix, so a launch under any id is seen. A
 * hosted agent's launch of a feature that `HOSTED_STATELESS_HELPERS` does not allow is reported
 * through Sentry with the feature name: a future path cannot start a real turn of a hosted agent
 * from this machine unnoticed. The check never blocks; the caller owns what it does with the
 * verdict.
 *
 * The records come from the desktop's stores, installed once by the process handlers. A process
 * with no stores installed (the headless Cue engine, a test) reads every agent as not hosted.
 */

import {
	hostedLaunchVerdict,
	type HostedLaunchFeature,
} from '../../shared/maestro-lib/agents/hosted-launch';
import { captureMessage } from './sentry';
import { logger } from './logger';

const LOG_CONTEXT = '[HostedLaunchGuard]';

export interface HostedLaunchRecords {
	/** The stored agent records. */
	sessions(): readonly { id: string; liftedTo?: unknown }[];
	/** `HOSTED_AGENTS_SETTING`, read at the launch. */
	hostedEnabled(): boolean;
}

let records: HostedLaunchRecords | null = null;

/** Point the check at the desktop's stores. Called once, where those stores are wired. */
export function installHostedLaunchGuard(source: HostedLaunchRecords | null): void {
	records = source;
}

/**
 * Check one launch of `feature` for agent record `agentId`. Absent `agentId` (a launch that runs
 * for no agent, such as a moderator) is not checked.
 */
export function checkHostedAgentLaunch(
	agentId: string | undefined,
	feature: HostedLaunchFeature
): 'not-hosted' | 'allowed' | 'unlisted' {
	if (!agentId || !records) return 'not-hosted';
	const agent = records.sessions().find((session) => session?.id === agentId);
	const verdict = hostedLaunchVerdict(agent, feature, agent ? records.hostedEnabled() : false);
	if (verdict === 'unlisted') {
		logger.warn('A hosted agent launched a provider on this machine', LOG_CONTEXT, {
			agentId,
			feature,
		});
		void captureMessage(`Hosted agent launch on this machine: ${feature}`, 'warning', {
			feature,
			agentId,
		});
	}
	return verdict;
}
