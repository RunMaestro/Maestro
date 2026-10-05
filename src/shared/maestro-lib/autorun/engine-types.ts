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

import type { HistoryEntry, TaskSelectionMode, UsageStats } from '../../types';
import type { PromptId } from '../../promptDefinitions';
import type { TurnOutcome } from '../streaming/turn-outcome';

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
}

/** The record of a run the engine appends to History. */
export type AutoRunHistoryEntry = HistoryEntry;

export interface AutoRunDocumentRead {
	content: string;
	/** Unchecked tasks. The count the loop, the preflight, and the stall guard run on. */
	unchecked: number;
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
}
