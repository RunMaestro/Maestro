/**
 * The Cue readiness report: its shape and its wording.
 *
 * `checkCueReadiness()` in `src/main/cue/cue-readiness.ts` builds the report;
 * this module holds only what every surface that SHOWS it needs, so the Cue
 * modal's Readiness tab reads the same words as `maestro-cli cue engine check`
 * without bundling the checker (which reads the filesystem and probes binaries).
 */

export type CueReadinessGapKind =
	/** The provider is unknown, has no output parser, or cannot run a turn without a terminal. */
	| 'unsupported-provider'
	/** The provider's binary is not at its configured path, or not found on this machine. */
	| 'binary-missing'
	/** The agent's working directory or project root does not exist. */
	| 'workspace-missing'
	/** A secret an agent or webhook needs is set nowhere. */
	| 'secret-missing'
	/** A secret file exists but cannot be used (unreadable, empty, too large). */
	| 'secret-unusable'
	/** The agent runs over SSH and its remote is missing or disabled. */
	| 'ssh-remote'
	/**
	 * cue.yaml does not parse or validate, names a prompt file that is missing,
	 * or has a settings.owner_agent_id that leaves its unpinned subscriptions with no owner.
	 */
	| 'cue-config'
	/** A subscription names an agent that does not exist in this data directory, or pins one from another workspace. */
	| 'unknown-agent'
	/** A host tool something needs (gh) is not installed. */
	| 'tool-missing'
	/**
	 * A `github.*` trigger has no `repo:`. Its trigger source refuses it, so it
	 * never polls or receives webhooks; the engine does not detect the repo.
	 */
	| 'github-repo-missing'
	/**
	 * The data directory has no agents, or no enabled subscription runs on any
	 * of them: an engine started on it would sit idle while reporting healthy,
	 * which on a server almost always means the bundle was never imported.
	 */
	| 'nothing-to-run';

export interface CueReadinessGap {
	kind: CueReadinessGapKind;
	/** One actionable sentence. Names and paths only, never a secret value. */
	message: string;
	agentId?: string;
	agentName?: string;
	subscription?: string;
	/** The project root (workspace folder) the gap belongs to. */
	workspace?: string;
	/** The secret's NAME. */
	secret?: string;
	tool?: string;
}

export interface CueReadinessReport {
	ready: boolean;
	/** ISO time the check ran; the status endpoint reports how fresh it is. */
	checkedAt: string;
	/** Agents checked: those that run an enabled subscription (owner rule applied), and every fan-out target of one. */
	agents: number;
	/** Project roots with a cue.yaml. */
	workspaces: number;
	/** Subscriptions that loaded, disabled ones included (readiness checks only the enabled). */
	subscriptions: number;
	gaps: CueReadinessGap[];
}

/** The one-line verdict: ready, or how many gaps across how much was checked. */
export function formatCueReadinessSummary(report: CueReadinessReport): string {
	const summary = `${report.agents} agent(s), ${report.workspaces} workspace(s), ${report.subscriptions} subscription(s)`;
	if (report.ready) return `Ready: ${summary} checked, no gaps.`;
	return `Not ready: ${report.gaps.length} gap(s) across ${summary}.`;
}

/** The report as text lines, one per gap, for a terminal. */
export function formatCueReadiness(report: CueReadinessReport): string[] {
	if (report.ready) return [formatCueReadinessSummary(report)];
	return [
		formatCueReadinessSummary(report),
		...report.gaps.map((gap) => `  - [${gap.kind}] ${gap.message}`),
	];
}
