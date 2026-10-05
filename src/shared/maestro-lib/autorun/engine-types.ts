/**
 * The Auto Run engine's event shape and its ports.
 *
 * One engine serves every surface that runs Auto Run without a window: the CLI (`maestro-cli
 * run-playbook`, `run-doc`, `goal-run`) and the runtime behind the TUI. It imports no `fs`, no
 * process API, and nothing from `src/cli`, `src/main`, or `src/renderer`; everything that touches
 * the outside world arrives through `AutoRunDeps`. `Plans/maestro-tui-autorun-engine.md` section
 * 4 has the design and the decisions (AE1 to AE3, AE5, AE19) this follows.
 *
 * Every port may answer synchronously or with a promise. The engine awaits each answer, so the
 * CLI's synchronous file helpers and the runtime's async writers fit one shape.
 */

import type { AgentError, HistoryEntry, TaskSelectionMode, UsageStats } from '../../types';
import type { PromptId } from '../../promptDefinitions';
import type { TurnOutcome } from '../streaming/turn-outcome';
import type { AutoRunPolicy } from './policy';

export type MaybePromise<T> = T | Promise<T>;

/**
 * One fact about a run. The CLI prints these verbatim as JSONL (`--json`), so a field added to a
 * type the CLI already emits is CLI output: new facts get new event types, which the CLI adapter
 * does not forward (AE5).
 */
export interface AutoRunEvent {
	type: string;
	timestamp: number;
	[key: string]: unknown;
}

/** What a turn is for. The engine resolves model and effort per purpose; the adapter forwards them. */
export type AutoRunTurnPurpose = 'task' | 'synopsis' | 'goal-iteration' | 'goal-handoff';

export interface AutoRunTurnRequest {
	purpose: AutoRunTurnPurpose;
	prompt: string;
	/** Resume this provider session (synopsis, handoff). Absent: a fresh session. */
	resumeSessionId?: string;
	model?: string;
	effort?: string;
	/** The playbook document a task or synopsis turn belongs to, for labels and the ledger. */
	document?: string;
	/** Aborts the turn in flight. */
	signal?: AbortSignal;
}

export interface AutoRunTurnResult {
	success: boolean;
	response?: string;
	agentSessionId?: string;
	usageStats?: UsageStats;
	error?: string;
	/** How the turn ended: a user stop is told apart from a crash by this, never by `error`. */
	outcome?: TurnOutcome;
	/**
	 * The classified failure. An error pause keys on this and nothing else, so the run never races
	 * an exit against a separate error event (AE7). Only a surface that pauses sets it.
	 */
	agentError?: AgentError;
	/**
	 * Set by a watchdog that killed a hung or overlong turn. A watchdog failure trips the stall
	 * guard at once instead of after three more dispatches.
	 */
	errorKind?: 'watchdog-stalled' | 'watchdog-timeout';
}

/** How a person (or the auto-resume timer) answers a pause. */
export type AutoRunResolution = 'resume' | 'skip' | 'abort';

/** Why a run is parked. */
export type AutoRunPause =
	| {
			kind: 'error';
			/** The playbook document, absent for a goal run. */
			document?: string;
			/** The goal iteration that failed, absent for a playbook run. */
			iteration?: number;
			agentError: AgentError;
	  }
	| {
			kind: 'gate';
			document: string;
			gate: { reason: string; artifact?: string; line: number };
	  };

/**
 * What the engine needs from whoever can stop or answer a run. Absent from the deps, a run never
 * pauses and stops only through its `AbortSignal` (the CLI).
 */
export interface AutoRunController {
	/** Graceful stop: checked before every document, dispatch, and goal iteration. */
	stopRequested(): boolean;
	/**
	 * Park until answered. A stop answers `abort`. `auto` is true when the auto-resume timer, not a
	 * person, answered.
	 */
	awaitResolution(pause: AutoRunPause): Promise<{ resolution: AutoRunResolution; auto: boolean }>;
	/** Closed and open paused time so far, taken off the run clock (AE10). */
	pausedMs(): number;
}

/** The record of a run the engine appends to History. */
export type AutoRunHistoryEntry = HistoryEntry;

export interface AutoRunDocumentRead {
	content: string;
	/** Unchecked tasks. The count the loop, the preflight, and the stall guard run on. */
	unchecked: number;
	/**
	 * Checked tasks, when the port counts them (C2). A task count that includes them survives an
	 * agent that adds tasks as it works; without it the engine falls back to the drop in
	 * `unchecked`, floored at zero.
	 */
	checked?: number;
}

/** What the Usage Dashboard's Auto Run panels need to know about a run at its start. */
export interface AutoRunStatsRun {
	agentType: string;
	/** The documents joined by commas, or `Goal: <goal>` for a goal run. */
	documentPath: string;
	startTime: number;
	/** Unchecked tasks at the start; 100 for a goal run (progress is the task scale). */
	tasksTotal: number;
	projectPath: string;
}

export interface AutoRunStatsTask {
	taskIndex: number;
	taskContent?: string;
	startTime: number;
	duration: number;
	success: boolean;
}

export interface AutoRunDeps {
	turns: {
		/** Once per run, after the preflight, where the CLI builds its system prompt today. */
		prepare?(): Promise<void>;
		run(request: AutoRunTurnRequest): Promise<AutoRunTurnResult>;
	};
	documents: {
		/** `name` has no extension; a missing or unreadable document answers empty content and 0. */
		read(folder: string, name: string): MaybePromise<AutoRunDocumentRead>;
		/** The text of every unchecked task, for a dry run. */
		readTasks(folder: string, name: string): MaybePromise<{ content: string; tasks: string[] }>;
		/** `file` carries its extension. */
		write(folder: string, file: string, content: string): MaybePromise<void>;
		/** Reset on completion: the document's text with every task unchecked. */
		uncheckAll(content: string): string;
	};
	/**
	 * Optional. Called where the desktop calls `startAutoRun`, `recordAutoTask`, and `endAutoRun`
	 * (AE12). A failure is the port's to swallow: the engine only reports it.
	 */
	stats?: {
		startRun(run: AutoRunStatsRun): MaybePromise<string | null>;
		recordTask(runId: string, task: AutoRunStatsTask): MaybePromise<void>;
		endRun(runId: string, durationMs: number, tasksCompleted: number): MaybePromise<void>;
	};
	history: {
		append(entry: AutoRunHistoryEntry): MaybePromise<void>;
		/** May throw: the engine then reports its own counters, as both engines do today. */
		readAll(agentId: string): MaybePromise<AutoRunHistoryEntry[]>;
	};
	prompts: {
		get(id: PromptId): Promise<string>;
		taskSelectionBlock(
			mode: TaskSelectionMode | undefined,
			segment?: { count: number; total: number }
		): Promise<string>;
	};
	environment: {
		gitBranch(cwd: string): MaybePromise<string | undefined>;
		isGitRepo(cwd: string): MaybePromise<boolean>;
		groupName(groupId: string | undefined): MaybePromise<string | undefined>;
		/**
		 * Policy `checkpointCommits` (AE23): `git add -A` and commit what the iteration left. Best
		 * effort, never throws into the run. Absent: no checkpoint.
		 */
		commitAll?(
			cwd: string,
			message: string
		): MaybePromise<{ committed: boolean; commitHash?: string; error?: string }>;
	};
	/** Tells the desktop and other CLI processes that this agent is busy for the run's length. */
	activity: {
		begin(entry: {
			agentId: string;
			playbookId: string;
			playbookName: string;
			startedAt: number;
		}): void;
		end(agentId: string): void;
	};
	clock: { now(): number };
	log: {
		autorun(message: string, context?: string, data?: unknown): void;
		warn(message: string, context?: string, data?: unknown): void;
	};
	/** Surface rules. Absent: `CLI_AUTORUN_POLICY`, which is what the engine did before policy existed. */
	policy?: AutoRunPolicy;
	/** Absent: the run never pauses and stops only through `signal`. */
	controller?: AutoRunController;
}
