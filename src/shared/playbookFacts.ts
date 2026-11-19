/**
 * The local facts pack: what Maestro can learn about an agent's workspace at
 * zero token cost before a playbook runs. The main process gathers it
 * (`src/main/services/playbook-facts.ts`, `playbooks:gatherFacts`); the
 * configure form and the guided interviewer read it to propose parameter
 * values (`proposeFromFacts()` in `./playbookParams.ts`).
 *
 * Every fact describes the place the agent RUNS. For an SSH agent that is the
 * remote host, so a probe that could not reach it is listed in
 * `unknownProbes` instead of being answered from this machine.
 */

import type { EncoreFeatureDefaults } from './encoreFeatureDefaults';

/** A probe that can come back unknown (SSH host unreachable or unresolved). */
export type PlaybookFactProbe = 'git' | 'gh' | 'python3';

export interface PlaybookFacts {
	/** The agent's working directory where it runs (the remote path for SSH). */
	cwd: string;
	/** True when the agent runs on an SSH remote. */
	isSshRemote: boolean;
	/** Current branch. Absent outside a repo or on a detached HEAD. */
	gitBranch?: string;
	/** URL of the `origin` remote. Absent when there is none. */
	gitRemoteUrl?: string;
	/** Open pull requests whose head is `gitBranch`. Empty when unknown. */
	openPrUrlsForBranch: string[];
	/** GitHub CLI on the agent's host. `false` also when listed in `unknownProbes`. */
	hasGh: boolean;
	/** `python3` on the agent's host. `false` also when listed in `unknownProbes`. */
	hasPython3: boolean;
	/** Probes that could not answer. A `false` above is only a real "no" when its probe is absent here. */
	unknownProbes: PlaybookFactProbe[];
	/** Encore Feature flags, defaults applied. */
	encoreFlags: EncoreFeatureDefaults;
	/** Cue subscriptions this agent owns. 0 when Cue is off or not loaded. */
	cueSubscriptionCount: number;
}
