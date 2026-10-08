/**
 * AgentRun capture service (F1) - main-process lifecycle capture.
 *
 * Turns real agent sessions into ledger records. It is the single writer the
 * desktop seams call: `captureSpawn` at `ProcessManager.spawn`, `captureExit`
 * at the `process:exit` seam. All writes go through the injected store deps
 * (which run under the F0 cross-process lock) and every status change is guarded
 * by the pure lifecycle table and mirrored to a `status_change` event.
 *
 * Invariants:
 *   - Never throws into a lifecycle path: every public method swallows and logs
 *     its own errors (ISC-1.8).
 *   - Terminal (`-terminal-`) and group-chat sessions are never captured
 *     (ISC-1.7), filtered at BOTH creation and completion.
 *   - A re-spawn of a live session supersedes the prior run (ISC-1.11).
 *
 * Producers (git diff, usage, checks, reviews, PR, merge) are injected as an
 * optional `enrich` hook so F2 can populate rich fields on completion without
 * this file importing git/gh/child_process.
 */

import {
	assertTransition,
	isTerminalAgentRunStatus,
	resolveAgentRunProvider,
	deriveTerminalStatus,
	type AgentRun,
	type AgentRunEvent,
	type AgentRunStatus,
} from '../../shared/agent-run';

const GROUP_CHAT_PREFIX = 'group-chat-';

/** Minimal shape of a spawn we capture, projected from ProcessConfig. */
export interface CaptureSpawnInput {
	sessionId: string;
	toolType: string;
	cwd: string;
	tabId?: string;
	model?: string;
	agentId?: string;
	agentName?: string;
	repo?: string;
	worktreePath?: string;
	branch?: string;
	baseBranch?: string;
	prompt?: string;
	source?: string;
}

export interface CaptureExitInput {
	sessionId: string;
	exitCode: number;
}

/** Everything the service touches that is not pure. Injected for testability. */
export interface CaptureServiceDeps {
	getAgentRun: (runId: string) => AgentRun | undefined;
	upsertAgentRun: (run: AgentRun) => AgentRun;
	appendAgentRunEvent: (event: AgentRunEvent) => AgentRunEvent;
	/** Find the live (non-terminal) run for a session, if any. */
	findActiveRunBySession: (sessionId: string) => AgentRun | undefined;
	/** Optional F2 hook: enrich a completed run with touchedFiles/usage/etc. */
	enrich?: (run: AgentRun, exitCode: number) => Promise<Partial<AgentRun>> | Partial<AgentRun>;
	/** Redaction/gating for prompt capture (F6 / D1). Defaults to storing verbatim. */
	preparePrompt?: (prompt: string | undefined) => string | undefined;
	now?: () => number;
	log?: (level: 'warn' | 'error', message: string, error?: unknown) => void;
}

/**
 * A run id is UNIQUE per spawn (not per session), so a re-spawn of the same
 * session produces a distinct record and the prior run can be superseded rather
 * than overwritten. Exits resolve the live run via findActiveRunBySession.
 */
export function newRunId(sessionId: string, ts: number): string {
	return `run:${sessionId}:${ts}:${Math.random().toString(36).slice(2, 8)}`;
}

function isCapturable(sessionId: string): boolean {
	if (!sessionId) return false;
	if (sessionId.includes('-terminal-') || sessionId.endsWith('-terminal')) return false;
	if (sessionId.startsWith(GROUP_CHAT_PREFIX)) return false;
	return true;
}

export class AgentRunCaptureService {
	private readonly deps: CaptureServiceDeps;

	constructor(deps: CaptureServiceDeps) {
		this.deps = deps;
	}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}

	private report(level: 'warn' | 'error', message: string, error?: unknown): void {
		this.deps.log?.(level, message, error);
	}

	/**
	 * Create (or supersede+recreate) the AgentRun for a spawning session. A live
	 * prior run for the same session is marked superseded so a re-spawn/replay
	 * never leaves an orphan (ISC-1.11). Filtered for terminal/group-chat
	 * (ISC-1.7). Never throws (ISC-1.8).
	 */
	captureSpawn(input: CaptureSpawnInput): AgentRun | undefined {
		try {
			if (!isCapturable(input.sessionId)) return undefined;
			const ts = this.now();
			const runId = newRunId(input.sessionId, ts);

			const prior = this.deps.findActiveRunBySession(input.sessionId);
			if (prior && !isTerminalAgentRunStatus(prior.status)) {
				this.supersede(prior, runId, ts);
			}

			const prepared = (this.deps.preparePrompt ?? ((p) => p))(input.prompt);
			const run: AgentRun = {
				id: runId,
				createdAt: ts,
				updatedAt: ts,
				provider: resolveAgentRunProvider(input.toolType),
				status: 'running',
				model: input.model,
				agentId: input.agentId,
				agentName: input.agentName,
				sessionId: input.sessionId,
				tabId: input.tabId,
				cwd: input.cwd,
				repo: input.repo,
				worktreePath: input.worktreePath,
				branch: input.branch,
				baseBranch: input.baseBranch,
				prompt: prepared,
				source: input.source,
				artifacts: [],
				touchedFiles: [],
				checks: [],
				reviews: [],
			};
			const saved = this.deps.upsertAgentRun(run);
			this.emit(runId, 'status_change', ts, 'running', 'run spawned');
			return saved;
		} catch (error) {
			this.report('error', `captureSpawn failed for ${input.sessionId}`, error);
			return undefined;
		}
	}

	/**
	 * Settle a run to completed (exit 0) or failed (nonzero) at process exit,
	 * recording exitCode + duration and running the optional F2 enrich hook.
	 * Filtered and guarded like captureSpawn.
	 */
	async captureExit(input: CaptureExitInput): Promise<AgentRun | undefined> {
		try {
			if (!isCapturable(input.sessionId)) return undefined;
			const existing = this.deps.findActiveRunBySession(input.sessionId);
			if (!existing || isTerminalAgentRunStatus(existing.status)) return undefined;
			const runId = existing.id;

			const ts = this.now();

			let enrichment: Partial<AgentRun> = {};
			if (this.deps.enrich) {
				try {
					enrichment = await this.deps.enrich(existing, input.exitCode);
				} catch (error) {
					this.report('warn', `enrich failed for ${runId}`, error);
				}
			}

			// Merge enrichment first so review findings are visible, THEN derive the
			// terminal status: an exit-0 run with open critical/high findings settles
			// to needs_review, not completed (ISC-8.4/5.8).
			const merged: AgentRun = { ...existing, ...enrichment };
			const target = deriveTerminalStatus(merged, input.exitCode);
			assertTransition(existing.status, target);

			const durationMs = Math.max(0, ts - existing.createdAt);
			const next: AgentRun = {
				...merged,
				status: target,
				updatedAt: ts,
				metadata: {
					...(existing.metadata ?? {}),
					...(enrichment.metadata ?? {}),
					exitCode: input.exitCode,
					durationMs,
					completedAt: ts,
				},
			};
			const saved = this.deps.upsertAgentRun(next);
			this.emit(runId, 'status_change', ts, target, `run ${target} (exit ${input.exitCode})`);
			return saved;
		} catch (error) {
			this.report('error', `captureExit failed for ${input.sessionId}`, error);
			return undefined;
		}
	}

	private supersede(prior: AgentRun, replacedBy: string, ts: number): void {
		try {
			assertTransition(prior.status, 'cancelled', { audited: true });
			this.deps.upsertAgentRun({
				...prior,
				status: 'cancelled',
				updatedAt: ts,
				metadata: { ...(prior.metadata ?? {}), supersededBy: replacedBy },
			});
			this.emit(prior.id, 'status_change', ts, 'cancelled', `superseded by ${replacedBy}`);
		} catch (error) {
			this.report('warn', `supersede failed for ${prior.id}`, error);
		}
	}

	private emit(
		runId: string,
		type: string,
		timestamp: number,
		status: AgentRunStatus,
		message: string
	): void {
		try {
			this.deps.appendAgentRunEvent({
				id: `evt:${runId}:${type}:${timestamp}`,
				runId,
				timestamp,
				type,
				status,
				message,
			});
		} catch (error) {
			this.report('warn', `event append failed for ${runId}`, error);
		}
	}
}
