/**
 * Launch agents - how the Playbook Launch dialog describes and gates the agent a launch runs on.
 *
 * Pure functions over `Session` and `NewAgentDraft`; `PlaybookLaunchModal` owns the state. The
 * dialog never edits an agent, so everything here only READS one: the card that names it, the
 * list of agents "Existing agent" offers, the first draft the New Agent modal opens with, and
 * whether the playbook may launch on it.
 */

import { getAgentDisplayName } from '../../../../shared/agentMetadata';
import type { PlaybookLaunchSpec } from '../../../../shared/marketplace-types';
import { definedOnly } from '../../../../shared/objectUtils';
import { isLaunchAvailable } from '../../../../shared/playbookLaunch';
import type { Session } from '../../../types';
import { isRemoteNewAgent } from '../../../utils/newAgentSession';
import { getSessionSshRemoteId, isSessionRemote } from '../../../utils/sessionHelpers';
import type { NewAgentDraft } from '../../NewInstanceModal/types';

/** What the read-only agent card shows. */
export interface LaunchAgentSummary {
	name: string;
	/** Provider display name, such as "Claude Code". */
	provider: string;
	/** The model the agent is set to; `null` when it runs the provider's own default. */
	model: string | null;
	/** The agent's working folder. */
	folder: string;
	/** The agent works on an SSH remote, so `folder` is a path on that machine. */
	remote: boolean;
	/** Why a launch cannot run on this agent, written for the person. Set only when it cannot. */
	problem?: string;
}

const NO_AUTO_RUN_FOLDER_PROBLEM =
	'This agent has no Auto Run folder. Set one in its Auto Run panel, then launch again.';

/** A stored agent as the card shows it. */
export function summarizeLaunchSession(session: Session): LaunchAgentSummary {
	return definedOnly({
		name: session.name,
		provider: getAgentDisplayName(session.toolType),
		model: session.customModel || null,
		folder: session.cwd,
		remote: isSessionRemote(session),
		problem: session.autoRunFolderPath ? undefined : NO_AUTO_RUN_FOLDER_PROBLEM,
	});
}

/** A new agent's captured draft as the card shows it. A draft always gets an Auto Run folder. */
export function summarizeLaunchDraft(draft: NewAgentDraft): LaunchAgentSummary {
	return {
		name: draft.name,
		provider: getAgentDisplayName(draft.agentId),
		model: draft.customModel || null,
		folder: draft.workingDir,
		remote: isRemoteNewAgent(draft),
	};
}

/**
 * The agents "Existing agent" offers: those with an Auto Run folder, because a launch imports
 * its documents into that folder. In the order given, which is the order the store keeps.
 */
export function launchableSessions(sessions: readonly Session[]): Session[] {
	return sessions.filter((session) => Boolean(session.autoRunFolderPath));
}

/**
 * What the New Agent modal opens with on its first visit: a name from the playbook and the
 * working folder of the agent the user launched from. When that agent works on an SSH remote the
 * folder is a path on that machine, so the remote goes with it; otherwise the new agent would be
 * local with a remote path.
 */
export function initialNewAgentDraft(
	playbookTitle: string,
	current: Session | undefined
): Partial<NewAgentDraft> {
	if (!current) return { name: playbookTitle };
	const remoteId = getSessionSshRemoteId(current);
	return {
		name: playbookTitle,
		workingDir: current.cwd,
		...(isSessionRemote(current) && remoteId
			? { sessionSshRemoteConfig: { enabled: true, remoteId } }
			: {}),
	};
}

/** What the launch gate needs to know about this machine and the chosen agent. */
export interface LaunchGateContext {
	/** The running Maestro version. */
	runningVersion: string;
	/**
	 * The OS Maestro runs on (`hostPlatform()`), or `''` when this client cannot tell (a
	 * web-desktop browser). Main checks the platform again at launch, so an unknown host is not
	 * refused here.
	 */
	platform: string;
	/** The chosen agent works on an SSH remote, which the `maestro-cli` on this machine cannot reach. */
	sshRemote: boolean;
	/** `maestro-cli` is installed on this machine. */
	maestroCliInstalled: boolean;
}

/** Whether the playbook may launch on the chosen agent, split by who owns the explanation. */
export interface LaunchGate {
	/** Nothing in the playbook's own preconditions stops the launch. */
	available: boolean;
	/** Maestro version or platform: the playbook cannot launch on this machine at all. */
	blockedReason?: string;
	/** `maestro-cli` is the only thing in the way; the maestro-cli row explains it. */
	cliReason?: string;
	/** Things to tell the user that do not stop the launch (the skipped steps without `maestro-cli`). */
	notes: string[];
}

/** The same spec with the platform list emptied, which restricts nothing. */
function withoutPlatformList(spec: PlaybookLaunchSpec): PlaybookLaunchSpec {
	if (!spec.preconditions?.platforms) return spec;
	return { ...spec, preconditions: { ...spec.preconditions, platforms: [] } };
}

/**
 * Ask `isLaunchAvailable` twice, once for this machine and once for the chosen agent, so the
 * dialog can tell a playbook that cannot launch here (its platform or version, shown with the
 * requirements) from one that waits for `maestro-cli` (shown in the maestro-cli row, with its
 * Install button). `isLaunchAvailable` reports only the first problem it finds, and the machine
 * checks come first.
 */
export function evaluateLaunchGate(
	spec: PlaybookLaunchSpec,
	context: LaunchGateContext
): LaunchGate {
	const { runningVersion, platform, sshRemote, maestroCliInstalled } = context;
	const checked = platform === '' ? withoutPlatformList(spec) : spec;
	const playbook = { launch: checked };

	const machine = isLaunchAvailable(playbook, runningVersion, platform);
	if (!machine.available) return { available: false, blockedReason: machine.reason, notes: [] };

	const agent = isLaunchAvailable(playbook, runningVersion, platform, {
		sshRemote,
		maestroCliInstalled,
	});
	if (!agent.available) return { available: false, cliReason: agent.reason, notes: [] };
	return { available: true, notes: agent.notes };
}

/** What stands between the person and the Launch button, for the first thing to fix. */
export interface LaunchBlockers {
	gate: LaunchGate;
	/** `maestro-cli` has not been checked yet, and the playbook needs it. */
	checkingMaestroCli: boolean;
	/** The chosen agent cannot be launched on, or no agent is chosen yet. */
	targetProblem?: string;
	/** The playbook asks for a confirmation that is not ticked. */
	confirmationPending: boolean;
	/** How many answers fail validation. */
	invalidAnswers: number;
}

/**
 * The first reason Launch is off, in the order a person fixes them, or `null` when it is on. The
 * dialog shows it beside the button so a disabled button always says why.
 */
export function firstLaunchBlocker(blockers: LaunchBlockers): string | null {
	const { gate, checkingMaestroCli, targetProblem, confirmationPending, invalidAnswers } = blockers;
	if (gate.blockedReason) return gate.blockedReason;
	if (targetProblem) return targetProblem;
	if (gate.cliReason) {
		return checkingMaestroCli ? 'Checking whether maestro-cli is installed...' : gate.cliReason;
	}
	if (invalidAnswers > 0) {
		return invalidAnswers === 1
			? '1 answer needs attention.'
			: `${invalidAnswers} answers need attention.`;
	}
	if (confirmationPending) return 'Tick the confirmation to continue.';
	return null;
}
