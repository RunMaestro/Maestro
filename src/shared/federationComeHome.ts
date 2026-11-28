/**
 * The report of the job that brings every moved agent home (`src/main/federation/come-home.ts`),
 * and the one text a person reads about it: the desktop's notice after the job ends, and
 * `maestro-cli federation auto`. Shared so the two never say different things.
 */

/** One agent the job settled, or could not. */
export interface ComeHomeAgentOutcome {
	id: string;
	name: string;
	/** `peer:agentId` it was hosted as. */
	from: string;
	/**
	 * `online`: back with the host's tabs and transcripts. `offline`: back with only this machine's
	 * copy (see `missing`). `failed`: still moved; tried again every {@link COME_HOME_RETRY_INTERVAL_MS} while the app runs, and at the next launch.
	 */
	result: 'online' | 'offline' | 'failed';
	/** A turn on the host held this agent back until it ended. */
	waitedForHostTurn?: boolean;
	/** Offline only: what the host may hold that this machine does not, and where it is. */
	missing?: {
		peer: string;
		hostAgentId: string;
		/** When the agent moved. Anything the host wrote after this may be missing here. */
		movedAt: number;
		/** The newest transcript row this machine holds, if any. */
		lastLocalRowAt?: number;
	};
	/** What the return reported (host copy left behind, a failure's reason). */
	notices: string[];
	/** `failed` only: why the agent is not home yet, in one sentence, for its queued messages. */
	reason?: string;
}

export interface ComeHomeReport {
	startedAt: number;
	finishedAt: number;
	agents: ComeHomeAgentOutcome[];
}

/**
 * While hosting is off, a run that leaves an agent still moved (`failed`) is tried again this often,
 * for as long as the app runs, and no more once every agent is home.
 */
export const COME_HOME_RETRY_INTERVAL_MS = 5 * 60_000;

/**
 * Main pushes each come-home report on this channel to every window, so a window that does not run
 * the job (a secondary window) still shows why a moved agent's messages wait.
 */
export const COME_HOME_REPORT_CHANNEL = 'federation:comeHomeReport';

/** The outcome of a run for an agent that run could not bring home, if any. */
export function comeHomeFailureFor(
	report: ComeHomeReport | null | undefined,
	agentId: string
): ComeHomeAgentOutcome | undefined {
	return report?.agents.find((outcome) => outcome.id === agentId && outcome.result === 'failed');
}

/**
 * Why a moved agent's messages wait in its queue, in the words its queued messages and a refused
 * spawn both show. `failure` is the last run's outcome for it; none means the job has not settled
 * it yet.
 */
export function comeHomeWaitText(peer: string, failure?: ComeHomeAgentOutcome): string {
	if (!failure) {
		return `Bringing this agent back from ${peer}. Its messages wait in its queue and run here once it is back.`;
	}
	const reason = failure.reason ?? failure.notices.join(' ');
	return `Waiting to bring this agent back from ${peer}${reason ? `: ${reason}` : '.'} Maestro tries again every ${Math.round(COME_HOME_RETRY_INTERVAL_MS / 60_000)} minutes. Its messages wait in its queue.`;
}

/** What a person reads about one run of the job: a title and one line per agent. */
export interface ComeHomeSummary {
	title: string;
	lines: string[];
	/** Some agent came back with only this machine's copy, or is still on its host. */
	needsReview: boolean;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The peer name of a `peer:agentId` reference. */
const peerOf = (from: string) => from.slice(0, from.lastIndexOf(':')) || from;

function outcomeLine(outcome: ComeHomeAgentOutcome, formatTime: (ms: number) => string): string {
	const name = `"${outcome.name}"`;
	const peer = outcome.missing?.peer ?? peerOf(outcome.from);
	const waited = outcome.waitedForHostTurn
		? ` It waited for a turn running on ${peer} to end.`
		: '';
	const notices = outcome.notices.length > 0 ? ` ${outcome.notices.join(' ')}` : '';
	if (outcome.result === 'online') {
		return `${name} is an SSH agent again, with its conversations from ${peer}.${waited}${notices}`;
	}
	if (outcome.result === 'offline' && outcome.missing) {
		const since = formatTime(outcome.missing.lastLocalRowAt ?? outcome.missing.movedAt);
		return `${name} is an SSH agent again, from this machine's copy only. Anything written on ${peer} after ${since} may be missing here: it is still on ${peer}, as agent ${outcome.missing.hostAgentId}.${waited}${notices}`;
	}
	return `${name} is still on ${peer}. Maestro tries again every ${Math.round(COME_HOME_RETRY_INTERVAL_MS / 60_000)} minutes, or run maestro-cli unlift "${outcome.name}".${waited}${notices}`;
}

/**
 * The notice for one run, or null when it settled no agent (nothing to say). `formatTime` renders
 * an epoch-ms time for the reader (the desktop and the CLI each pass their own).
 */
export function summarizeComeHomeReport(
	report: ComeHomeReport | null | undefined,
	formatTime: (ms: number) => string = (ms) => new Date(ms).toLocaleString()
): ComeHomeSummary | null {
	if (!report || report.agents.length === 0) return null;
	const home = report.agents.filter((outcome) => outcome.result !== 'failed').length;
	const stuck = report.agents.length - home;
	const parts: string[] = [];
	if (home > 0)
		parts.push(
			`${plural(home, 'agent')} moved back from ${home === 1 ? 'its host' : 'their hosts'}`
		);
	if (stuck > 0) parts.push(`${plural(stuck, 'agent')} still on a host`);
	return {
		title: parts.join(', '),
		lines: report.agents.map((outcome) => outcomeLine(outcome, formatTime)),
		needsReview: report.agents.some((outcome) => outcome.result !== 'online'),
	};
}
