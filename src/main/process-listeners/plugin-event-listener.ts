/**
 * Plugin event listener.
 *
 * Bridges ProcessManager lifecycle events to the metadata-only plugin event bus
 * (`deps.emitPluginEvent`). Kept separate from the other process listeners so the
 * plugin-facing surface is isolated and unit-testable. Emits ONLY scalar metadata
 * — never message bodies, prompts, agent output, or error text — per the contract
 * in src/shared/plugins/events.ts (the bus additionally sanitizes + re-authorizes
 * every delivery against live grants). A no-op when no emitter is wired.
 */

import type { ProcessManager } from '../process-manager';
import {
	GROUP_CHAT_PREFIX,
	type ProcessListenerDependencies,
	type AgentError,
	type UsageStats,
	type QueryCompleteData,
} from './types';

/** Per-session token accumulation for the terminal agent.completed payload.
 * The `usage` event stream is already normalized to per-turn deltas by the
 * ProcessManager (StdoutHandler.normalizeUsageToDelta), so summing across
 * events yields the session total for both cumulative and delta reporters.
 * `totalCostUsd` is NOT delta-normalized upstream: cumulative reporters
 * (Claude) keep a running total in every event while delta reporters emit
 * per-turn costs — so we track both the sum and the last value and pick at
 * exit time based on the process's detected reporting mode. */
interface SessionUsageTotals {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	reasoningTokens: number;
	costSum: number;
	lastCost: number;
}

export function setupPluginEventListener(
	processManager: ProcessManager,
	deps: Pick<ProcessListenerDependencies, 'emitPluginEvent' | 'getCueEngine' | 'isCueEnabled'>
): void {
	const emit = deps.emitPluginEvent;
	if (!emit) return;
	const at = (): string => new Date().toISOString();

	// Session-scoped metadata accumulated from the event stream for the terminal
	// agent.completed payload. Both maps are cleared on exit, so entries are
	// bounded by the number of concurrently running sessions.
	const usageBySession = new Map<string, SessionUsageTotals>();
	const providerSessionIds = new Map<string, string>();

	// Provider session id (e.g. Claude's session_id) announced on the stream.
	processManager.on('session-id', (sessionId: string, agentSessionId: string) => {
		providerSessionIds.set(sessionId, agentSessionId);
	});

	// Agent/process exit — sessionId + exit code only (no output). Additionally
	// emits the rich agent.completed terminal event (metadata only) below.
	processManager.on('exit', (sessionId: string, code: number) => {
		emit({ topic: 'agent.exited', at: at(), payload: { sessionId, exitCode: code } });

		const usage = usageBySession.get(sessionId);
		const providerSessionId = providerSessionIds.get(sessionId);
		usageBySession.delete(sessionId);
		providerSessionIds.delete(sessionId);

		// Group-chat containment: participant/moderator exits are internal
		// router-driven turns, not user-facing agent completions. Mirrors the
		// exit-listener's guard around Cue's notifyAgentCompleted.
		if (sessionId.startsWith(GROUP_CHAT_PREFIX)) return;

		// The 'exit' event is emitted synchronously BEFORE the ProcessManager
		// drops the ManagedProcess, so the metadata snapshot is still readable.
		const proc = processManager.get(sessionId);
		const now = Date.now();
		const startedAtMs = proc?.startTime;

		// Cue queue depth for this session (pending auto-runs waiting on a
		// concurrency slot). Threaded via deps — never a global. Absent when
		// Cue is off or the engine is not constructed.
		let queueDepth: number | undefined;
		if (deps.isCueEnabled?.()) {
			queueDepth = deps.getCueEngine?.()?.getQueueStatus().get(sessionId);
		}

		// Chain lineage (chainRootId/parentEventId/runId/pipeline*) is Cue-run
		// state: Cue spawns its own child processes that never traverse the
		// ProcessManager exit path, and non-Cue completions START a new chain
		// root (see cue-completion-service.ts). There is therefore no lineage
		// to carry here — the declared fields stay absent by design.
		const totalTokens = usage
			? usage.inputTokens +
				usage.outputTokens +
				usage.cacheReadInputTokens +
				usage.cacheCreationInputTokens
			: undefined;
		const costUsd = usage
			? proc?.usageIsCumulative === true
				? usage.lastCost
				: usage.costSum
			: undefined;

		emit({
			topic: 'agent.completed',
			at: at(),
			payload: {
				sessionId,
				status: code === 0 ? 'completed' : 'failed',
				exitCode: code,
				...(proc?.toolType ? { agentId: proc.toolType } : {}),
				...(proc?.tabId ? { tabId: proc.tabId } : {}),
				...(proc?.projectPath ? { projectPath: proc.projectPath } : {}),
				...(proc?.querySource ? { source: proc.querySource } : {}),
				...(typeof startedAtMs === 'number'
					? {
							startedAt: new Date(startedAtMs).toISOString(),
							durationMs: now - startedAtMs,
						}
					: {}),
				completedAt: at(),
				...(providerSessionId ? { providerSessionId } : {}),
				...(typeof queueDepth === 'number' ? { queueDepth } : {}),
				...(usage
					? {
							inputTokens: usage.inputTokens,
							outputTokens: usage.outputTokens,
							cacheReadInputTokens: usage.cacheReadInputTokens,
							cacheCreationInputTokens: usage.cacheCreationInputTokens,
							...(usage.reasoningTokens > 0 ? { reasoningTokens: usage.reasoningTokens } : {}),
						}
					: {}),
				...(typeof totalTokens === 'number' ? { totalTokens } : {}),
				...(typeof costUsd === 'number' ? { costUsd } : {}),
			},
		});
	});

	// Agent error — type + recoverability only (never the provider message / raw).
	processManager.on('agent-error', (sessionId: string, agentError: AgentError) => {
		emit({
			topic: 'agent.error',
			at: at(),
			payload: {
				sessionId,
				...(agentError.agentId ? { agentId: agentError.agentId } : {}),
				errorType: agentError.type,
				recoverable: agentError.recoverable,
			},
		});
	});

	// Token/cost usage — counts only. Also accumulated per session for the
	// terminal agent.completed payload (cleared on exit).
	processManager.on('usage', (sessionId: string, usage: UsageStats) => {
		const totals = usageBySession.get(sessionId) ?? {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			reasoningTokens: 0,
			costSum: 0,
			lastCost: 0,
		};
		totals.inputTokens += usage.inputTokens;
		totals.outputTokens += usage.outputTokens;
		totals.cacheReadInputTokens += usage.cacheReadInputTokens;
		totals.cacheCreationInputTokens += usage.cacheCreationInputTokens;
		totals.reasoningTokens += usage.reasoningTokens ?? 0;
		totals.costSum += usage.totalCostUsd;
		totals.lastCost = usage.totalCostUsd;
		usageBySession.set(sessionId, totals);

		emit({
			topic: 'usage.updated',
			at: at(),
			payload: {
				sessionId,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				cacheReadInputTokens: usage.cacheReadInputTokens,
				cacheCreationInputTokens: usage.cacheCreationInputTokens,
				totalCostUsd: usage.totalCostUsd,
				contextWindow: usage.contextWindow,
				...(typeof usage.reasoningTokens === 'number'
					? { reasoningTokens: usage.reasoningTokens }
					: {}),
			},
		});
	});

	// Batch query / auto-run completion — timing + source (user|auto), no output.
	processManager.on('query-complete', (_sessionId: string, q: QueryCompleteData) => {
		emit({
			topic: 'run.completed',
			at: at(),
			payload: {
				sessionId: q.sessionId,
				agentType: q.agentType,
				source: q.source,
				durationMs: q.duration,
				...(q.projectPath ? { projectPath: q.projectPath } : {}),
				...(q.tabId ? { tabId: q.tabId } : {}),
			},
		});
	});
}
