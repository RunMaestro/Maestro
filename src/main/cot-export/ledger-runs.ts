/**
 * Chain of thought export: turns the command line ran outside the app.
 *
 * `maestro-cli send`, a playbook run from the command line, and a goal run all
 * start the agent inside the command line's own process. Nothing of such a
 * turn passes through the app, so the process listener never sees it, and
 * without this module the log would simply not mention it.
 *
 * The command line does leave one trace of its own accord, for every person
 * and whether or not anything is recorded: a line in the run ledger
 * (`src/cli/services/agent-run-capture.ts`), which says which agent ran, with
 * what prompt, when, and how it ended. This module is handed that ledger and
 * writes one turn for each such run, with `origin: 'cli'`:
 *
 *   turn-start    the prompt, the agent's directory, the provider, the run's id
 *   capture-gap   `output-not-captured:outside-app`
 *   turn-end      the exit code, how long it ran, how it ended
 *
 * The command line is not changed to make this work, and is told nothing. It
 * holds no word of this feature, so a run of it gives an agent no sign. This
 * module does not read the ledger itself either: whoever watches the ledger
 * hands it over (`recordPending`), so nothing here reaches into the command
 * line's code.
 *
 * WHAT SUCH A TURN IS WORTH
 * It is a report, not an observation. The ledger is a file the command line
 * wrote, and the command line can be run by the agent itself. A turn of this
 * origin shows that the ledger says a run took place. It does not prove what
 * the run did, and a run that never reached the ledger is not here at all.
 * The output is never in it: the gap says so on every such turn, so that an
 * empty turn is not read as an agent that said nothing.
 *
 * WHICH RUNS
 * - reported by the command line (`source` starts with `cli:`), and not a
 *   synopsis, which is Maestro's own prompt and is left out everywhere
 * - finished, for an agent that is recorded now and that Maestro still has
 * - started after export was last turned on for that agent, so that turning
 *   it on never picks up a run that was already going
 * - not recorded before
 *
 * ONE RUN, ONE FILE
 * "Recorded before" is answered by the run's own id, never by a time. The
 * turn id of a run is derived from its id in the ledger, so a run always maps
 * to the same turn file, and a run whose file is already there (in the
 * agent's current folder, or in one it used before) is not written again.
 * That holds through a crash right after the write and through a restart,
 * with nothing to save in between. A mark kept by time would lose a run: two
 * runs of the command line can reach the ledger in the other order than they
 * ended in, and the one that ended first would then lie behind the mark.
 *
 * The file is looked for where it would be written today, and then under the
 * days around the run's start. A turn is filed by the LOCAL clock, so after a
 * change of time zone the same run maps to another hour folder and another
 * name, and looking in one place would write every run the ledger still
 * holds a second time. Two zones are never more than 26 hours apart, so the
 * file is at most two dates away. A name carries only the start of the turn
 * id, so a file found that way is read, and counts only if it names the run.
 *
 * A file that is there is taken as the whole turn. If the app stopped while
 * the turn was being written, the file stays as it is: a turn with no
 * `turn-end`, which is what the format says a turn cut short looks like.
 *
 * A run that finished while the app was closed is recorded at the next start,
 * as long as the ledger still holds it. The ledger keeps a bounded number of
 * finished runs, so a very long absence can lose some.
 *
 * Nothing here throws into its caller. A failure goes to `onError`.
 *
 * This feature is hidden from agents on purpose. Read the header of
 * `src/shared/cotExport/types.ts` before you change or expose anything here.
 */

import * as fs from 'fs';
import { isTerminalAgentRunStatus } from '../../shared/agent-run';
import type { AgentRun } from '../../shared/agent-run';
import { DURATION_MS } from '../../shared/duration';
import { sha256Hex } from './hash-chain';
import { isTurnFileNameOf, listTurnFilesOnDay, turnFilePath } from './layout';
import { recordCompletedRun } from './turn-assembler';
import type { CotCueRecorderDeps } from './turn-assembler';

/** How the command line names itself in a run's `source`. */
const CLI_SOURCE_PREFIX = 'cli:';

/** The end of a `source` that names a synopsis turn: Maestro's own prompt. */
const SYNOPSIS_SOURCE_SUFFIX = '-synopsis';

/**
 * The dates around a run's start a turn file can be filed under, as days from
 * that start: the same date first, then one and two dates either way. See
 * "One run, one file" above for why two.
 */
const FILED_DAY_OFFSETS = [0, -1, 1, -2, 2];

/** Everything the recorder needs from outside. It reads no store itself. */
export interface CotLedgerRecorderDeps extends Pick<CotCueRecorderDeps, 'writer' | 'onError'> {
	/** The agents whose turns are recorded right now. */
	listEnabledAgents: () => string[];
	/**
	 * The folders that hold the agent's log: the one it writes to now first,
	 * then the ones it used before. Empty when no folder is chosen.
	 */
	getFolders: (agentId: string) => string[];
	/** The provider the agent runs, or null for an agent Maestro no longer has. */
	getToolType: (agentId: string) => string | null;
	/** When export was last turned on for the agent, or null when it never was. */
	getSince: (agentId: string) => number | null;
}

export interface CotLedgerRecorder {
	/**
	 * Writes a turn for every run that is due. `readRuns` gives the ledger. It
	 * is called only when some agent is recorded, so with export off for
	 * everyone the ledger is not even read. One call runs at a time, and a
	 * call made meanwhile waits its turn. It never rejects.
	 */
	recordPending(readRuns: () => AgentRun[]): Promise<void>;
}

/** Whether the command line reported the run, as a turn someone asked for. */
function isCliTurn(run: AgentRun): boolean {
	const source = run.source ?? '';
	return source.startsWith(CLI_SOURCE_PREFIX) && !source.endsWith(SYNOPSIS_SOURCE_SUFFIX);
}

/** A number the ledger holds under `key`, or undefined. The ledger is a file anyone can write. */
function metadataNumber(run: AgentRun, key: string): number | undefined {
	const value = run.metadata?.[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** How long the run took, as the command line measured it. */
function durationOf(run: AgentRun): number {
	const measured = metadataNumber(run, 'durationMs');
	return measured !== undefined && measured >= 0
		? measured
		: Math.max(0, run.updatedAt - run.createdAt);
}

/** The outcome string of a turn for the status a run ended with. */
function outcomeOf(run: AgentRun): string | undefined {
	switch (run.status) {
		case 'completed':
			return 'completed';
		case 'cancelled':
			return 'interrupted';
		case 'failed':
			return 'crashed';
		default:
			return undefined;
	}
}

/**
 * The turn id of a run: the same for the same run, every time. It is what
 * makes a run land in one file and no other.
 */
export function cliTurnId(runId: string): string {
	return sha256Hex(`cli-run\n${runId}`).slice(0, 32);
}

/** Whether a file is there. A file that cannot be reached is taken as not there. */
async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.promises.access(filePath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether a turn file names the run `runId` in one of its records. A file
 * that cannot be read is taken to: its name already matched, and a second
 * turn for a run that is there is the worse mistake.
 */
async function namesRun(filePath: string, runId: string): Promise<boolean> {
	let text: string;
	try {
		text = await fs.promises.readFile(filePath, 'utf8');
	} catch {
		return true;
	}
	for (const line of text.split('\n')) {
		if (line.trim() === '') continue;
		try {
			if ((JSON.parse(line) as { cliRunId?: unknown }).cliRunId === runId) return true;
		} catch {
			// A line that was cut short. The record that names the run is another.
		}
	}
	return false;
}

export function createCotLedgerRecorder(deps: CotLedgerRecorderDeps): CotLedgerRecorder {
	/**
	 * The runs known to be in the log, by agent, so that a run costs one look
	 * at the disk and not one at every change of the ledger. It is only a
	 * memory of what the disk says, and it is rebuilt from the disk after a
	 * restart.
	 */
	const recorded = new Map<string, Set<string>>();

	function report(agentId: string | null, error: unknown): void {
		try {
			deps.onError(agentId, error instanceof Error ? error : new Error(String(error)));
		} catch {
			// Nowhere left to send it.
		}
	}

	async function recordFor(agentId: string, runs: AgentRun[]): Promise<void> {
		const since = deps.getSince(agentId);
		const folders = deps.getFolders(agentId);
		const toolType = deps.getToolType(agentId);
		if (since === null || folders.length === 0 || !toolType) return;
		const [folder] = folders;

		const candidates = runs.filter(
			(run) =>
				run.agentId === agentId &&
				isCliTurn(run) &&
				isTerminalAgentRunStatus(run.status) &&
				run.createdAt >= since
		);
		// A run the ledger no longer holds can never come up again, so it need
		// not be remembered. This keeps the memory as small as the ledger.
		const known = new Set(
			[...(recorded.get(agentId) ?? [])].filter((id) => candidates.some((run) => run.id === id))
		);
		recorded.set(agentId, known);

		const due = candidates
			.filter((run) => !known.has(run.id))
			// By when they started, so that the files and the chain read in order.
			.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

		// The turn files of a day, read once for all the runs of this pass.
		const dayFiles = new Map<string, Promise<string[]>>();
		const filesOnDay = (dir: string, day: Date): Promise<string[]> => {
			const key = `${dir}\n${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
			let files = dayFiles.get(key);
			if (!files) {
				// A day that cannot be listed holds nothing this pass can find.
				files = listTurnFilesOnDay(dir, day).catch(() => []);
				dayFiles.set(key, files);
			}
			return files;
		};

		/** Whether the run's turn is in one of the agent's folders already. */
		const isOnDisk = async (run: AgentRun, turnId: string): Promise<boolean> => {
			const startedAt = new Date(run.createdAt);
			// Where it is written today: one look, and the usual answer.
			for (const dir of folders) {
				if (await fileExists(turnFilePath(dir, startedAt, undefined, turnId))) return true;
			}
			// Where another time zone would have filed it.
			for (const dir of folders) {
				for (const offset of FILED_DAY_OFFSETS) {
					const day = new Date(run.createdAt + offset * DURATION_MS.day);
					for (const file of await filesOnDay(dir, day)) {
						if (isTurnFileNameOf(file, turnId) && (await namesRun(file, run.id))) return true;
					}
				}
			}
			return false;
		};

		for (const run of due) {
			const turnId = cliTurnId(run.id);
			if (!(await isOnDisk(run, turnId))) {
				await recordCompletedRun(
					{ agentId, folder },
					{
						origin: 'cli',
						cliRunId: run.id,
						turnId,
						toolType,
						cwd: run.cwd ?? '',
						prompt: run.prompt,
						rawStdout: null,
						startTime: run.createdAt,
						durationMs: durationOf(run),
						exitCode: metadataNumber(run, 'exitCode') ?? null,
						outcome: outcomeOf(run),
					},
					deps
				);
			}
			// Remembered whether or not every record landed: a record that was lost
			// is counted by the writer and shows as a gap. Taking the run again at
			// the next change of the ledger would write it twice.
			known.add(run.id);
		}
	}

	async function recordNow(readRuns: () => AgentRun[]): Promise<void> {
		try {
			const enabled = deps.listEnabledAgents();
			// Nobody is recorded: the ledger is not even read.
			if (enabled.length === 0) return;
			const runs = readRuns();
			for (const agentId of enabled) {
				try {
					await recordFor(agentId, runs);
				} catch (error) {
					report(agentId, error);
				}
			}
		} catch (error) {
			report(null, error);
		}
	}

	let tail: Promise<void> = Promise.resolve();

	return {
		recordPending(readRuns) {
			tail = tail.then(() => recordNow(readRuns));
			return tail;
		},
	};
}
