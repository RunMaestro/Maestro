/**
 * Which provider launches a hosted agent may still start on this machine.
 *
 * A hosted agent's turns run on its Federation host. Its local record keeps its SSH fields, so any
 * launch that reads them would quietly run the agent from here. Two checks keep that from
 * happening unnoticed:
 *
 * - `process:spawn` refuses a process id that starts with a hosted agent's id
 *   (`liftedOwnerOfProcess`), unless the id names one of the stateless helpers below.
 * - Every other launch for an existing agent record (group chat, a consult, a Cue run, a groomed
 *   one-shot) names the agent and its feature; main reports a feature this file does not allow
 *   (`HOSTED_STATELESS_HELPERS` and `HOSTED_SSH_RUNS` are the allowed ones).
 *
 * A stateless helper writes nothing into the agent's transcript or tabs: it may run over the
 * record's SSH remote exactly as it does for an SSH agent. A real turn (`-ai-`, `-batch-`,
 * `-synopsis-`) is never one.
 *
 * Pure.
 */

import { readLiftedTo } from './lift-pointer';

/**
 * The launches that may run here for a hosted agent, each with the reason it is safe. A new
 * feature that launches a provider for an agent record must be added here on purpose, or it is
 * reported.
 */
export const HOSTED_STATELESS_HELPERS = {
	/** The Cue YAML editor's assistant: its own conversation, edits only `cue.yaml`. */
	'cue-assist': 'a helper conversation of its own; writes nothing into the agent',
	/** Rename Tab "Auto" and automatic tab naming: one cheap answer, pushed to the host by name. */
	'tab-naming': 'one cheap answer; the name reaches the host through renameHostedTab',
	/** AI command mode's shell suggestion: one cheap answer, never written to the transcript. */
	'ai-command': 'one cheap answer; never written to the transcript',
	/**
	 * `/btw` in a tab kept from before the move (a host tab asks its host): an ephemeral fork of
	 * the tab's own provider session, which reads the conversation and never writes it.
	 */
	'side-question': 'an ephemeral fork; reads the conversation, never writes it',
} as const;

export type HostedStatelessHelper = keyof typeof HOSTED_STATELESS_HELPERS;

/**
 * Real runs that still start here for a hosted agent, over the SSH remote its record keeps, by a
 * recorded decision (docs/parity/agent-ux-parity.md). Each writes nothing into the agent's tabs,
 * and the reason names what keeps the user's view the same as for a local agent.
 */
export const HOSTED_SSH_RUNS = {
	/** A Cue prompt run: a fresh provider session per run, shown in Cue activity. */
	'cue-run':
		"a fresh session per run; its entry reaches the agent's History through withHostedCueRuns()",
	/** A group chat turn: writes only to the group chat's own transcript. */
	'group-chat-participant':
		'writes only to the group chat transcript; the moderator reads the host busy state through isBusyOnHost()',
} as const;

export type HostedSshRun = keyof typeof HOSTED_SSH_RUNS;

/** A launch for an agent record that does not go through `process:spawn`. */
export type HostedLaunchFeature =
	| HostedStatelessHelper
	| HostedSshRun
	| 'consult'
	| 'groom-context';

export function isHostedStatelessHelper(feature: string): feature is HostedStatelessHelper {
	return Object.prototype.hasOwnProperty.call(HOSTED_STATELESS_HELPERS, feature);
}

export function isHostedSshRun(feature: string): feature is HostedSshRun {
	return Object.prototype.hasOwnProperty.call(HOSTED_SSH_RUNS, feature);
}

/** The process id the Cue YAML editor's assistant runs under: `{agentId}-cue-assist-{at}`. */
export function cueAssistProcessId(agentId: string, at: number): string {
	return `${agentId}-cue-assist-${at}`;
}

/**
 * The stateless helper a process id of this agent names, or undefined for anything else (a real
 * turn included). Only helpers that launch through `process:spawn` under the agent's id appear
 * here; the others launch under their own ids and never reach the prefix backstop.
 */
export function statelessHelperOfProcess(
	processSessionId: string,
	agentId: string
): HostedStatelessHelper | undefined {
	if (processSessionId.startsWith(`${agentId}-cue-assist-`)) return 'cue-assist';
	return undefined;
}

/**
 * What a launch of `feature` for this agent record is: `not-hosted` (no pointer, or hosted agents
 * are off: it runs as the SSH or local agent it is), `allowed` (a stateless helper, or a run
 * `HOSTED_SSH_RUNS` names), or `unlisted` (a hosted agent's launch this file does not allow: the
 * caller reports it; today a consult that did not go to the host, and an unnamed one-shot).
 */
export function hostedLaunchVerdict(
	agent: { liftedTo?: unknown } | undefined,
	feature: HostedLaunchFeature,
	hostedEnabled: boolean
): 'not-hosted' | 'allowed' | 'unlisted' {
	if (!agent || !hostedEnabled || !readLiftedTo(agent.liftedTo)) return 'not-hosted';
	return isHostedStatelessHelper(feature) || isHostedSshRun(feature) ? 'allowed' : 'unlisted';
}
