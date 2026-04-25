import type { MainLogLevel } from '../../shared/logger-types';
import { describeFilter, matchesFilter } from './cue-filter';
import { type CueFanInTracker } from './cue-fan-in-tracker';
import {
	buildFilteredOutputs,
	mergeUpstreamForwarded,
	SOURCE_OUTPUT_MAX_CHARS,
	type FanInSourceCompletion,
} from './cue-output-filter';
import { sliceTailByChars } from './cue-text-utils';
import {
	createCueEvent,
	type AgentCompletionData,
	type CueConfig,
	type CueSubscription,
} from './cue-types';

/**
 * Per-session view exposed to the completion service. `ownershipWarning` is
 * non-empty when the session is NOT the effective owner of its `cue.yaml`
 * (shared-projectRoot conflict). Unowned `agent.completed` subscriptions
 * must be skipped for those sessions, otherwise a workspace registered as
 * two agents would dispatch the same chain twice — exactly the duplication
 * the ownership gate exists to prevent.
 */
export interface CueCompletionSessionView {
	config: CueConfig;
	ownershipWarning?: string;
}

export interface CueCompletionServiceDeps {
	enabled: () => boolean;
	getSessions: () => Array<{ id: string; name: string }>;
	getSessionConfigs: () => Map<string, CueCompletionSessionView>;
	fanInTracker: CueFanInTracker;
	onDispatch: (
		ownerSessionId: string,
		sub: CueSubscription,
		event: ReturnType<typeof createCueEvent>,
		sourceSessionName: string,
		chainDepth?: number
	) => void;
	onLog: (level: MainLogLevel, message: string, data?: unknown) => void;
	maxChainDepth: number;
}

export interface CueCompletionService {
	hasCompletionSubscribers(sessionId: string): boolean;
	notifyAgentCompleted(sessionId: string, completionData?: AgentCompletionData): void;
}

function getMatchingSources(sub: CueSubscription): string[] {
	return Array.isArray(sub.source_session)
		? sub.source_session
		: sub.source_session
			? [sub.source_session]
			: [];
}

/**
 * Returns the set of upstream subscription names that may fire this chain.
 * When empty (no `source_sub` configured), the chain accepts completions from
 * any run in its source session(s) — legacy behavior.
 *
 * `source_sub` narrows matching so a sub fires only on completions produced
 * by an explicit upstream sub. See the field docs on `CueSubscription` for
 * the full rationale (prevents command-↔-agent self-loops and fan-in
 * cross-fire when an agent shares its session with an upstream command).
 */
function getAllowedSourceSubs(sub: CueSubscription): string[] {
	return Array.isArray(sub.source_sub) ? sub.source_sub : sub.source_sub ? [sub.source_sub] : [];
}

/**
 * Returns true iff this chain sub's `source_sub` filter allows a completion
 * produced by the given upstream sub. An unset filter permits everything.
 *
 * When `source_sub` IS set, `triggeredBy` must also be set and present in
 * the allowed list. An undefined `triggeredBy` here in practice means an
 * external (non-Cue) completion of the source session — e.g. the user
 * interacting with the agent directly, or a system process exit reported
 * via exit-listener. Bypassing the filter for those would partially
 * re-introduce the self-loop / cross-fire behaviour `source_sub` exists
 * to prevent. Manual triggers and bootstrap events do NOT reach this
 * function; they dispatch through `dispatchService` directly.
 */
function allowsSourceSub(sub: CueSubscription, triggeredBy: string | undefined): boolean {
	const allowed = getAllowedSourceSubs(sub);
	if (allowed.length === 0) return true;
	if (!triggeredBy) return false;
	return allowed.includes(triggeredBy);
}

export function createCueCompletionService(deps: CueCompletionServiceDeps): CueCompletionService {
	return {
		hasCompletionSubscribers(sessionId: string): boolean {
			if (!deps.enabled()) return false;

			const allSessions = deps.getSessions();
			const completingSession = allSessions.find((session) => session.id === sessionId);
			const completingName = completingSession?.name ?? sessionId;

			for (const [ownerSessionId, view] of deps.getSessionConfigs()) {
				for (const sub of view.config.subscriptions) {
					if (sub.event !== 'agent.completed' || sub.enabled === false) continue;
					if (sub.agent_id && sub.agent_id !== ownerSessionId) continue;
					// Skip unowned subs on non-owner sessions so the ownership
					// gate covers the completion path the same way it covers
					// trigger-source wiring in the runtime service.
					if (view.ownershipWarning && !sub.agent_id) continue;

					const sources = getMatchingSources(sub);
					if (sources.some((src) => src === sessionId || src === completingName)) {
						return true;
					}
				}
			}

			return false;
		},

		notifyAgentCompleted(sessionId: string, completionData?: AgentCompletionData): void {
			if (!deps.enabled()) return;

			const chainDepth = completionData?.chainDepth ?? 0;
			if (chainDepth >= deps.maxChainDepth) {
				deps.onLog(
					'error',
					`[CUE] Max chain depth (${deps.maxChainDepth}) exceeded — aborting to prevent infinite loop`
				);
				return;
			}

			const allSessions = deps.getSessions();
			const completingSession = allSessions.find((session) => session.id === sessionId);
			const completingName = completionData?.sessionName ?? completingSession?.name ?? sessionId;

			for (const [ownerSessionId, view] of deps.getSessionConfigs()) {
				const config = view.config;
				for (const sub of config.subscriptions) {
					if (sub.event !== 'agent.completed' || sub.enabled === false) continue;
					if (sub.agent_id && sub.agent_id !== ownerSessionId) continue;
					if (view.ownershipWarning && !sub.agent_id) continue;

					const sources = getMatchingSources(sub);
					if (!sources.some((src) => src === sessionId || src === completingName)) continue;

					// Narrow by `source_sub` (upstream subscription name) when configured.
					// This is the self-loop / cross-fire guard: a chain sub that lists
					// its upstream sub name only fires on completions produced by that
					// exact sub, not on any completion in the source session. Without
					// this, a `Cmd(owner=S) → Agent(S) → Main` chain re-triggers itself
					// on Agent's own completion and leaks Cmd's completion into Main's
					// fan-in before Agent has run.
					if (!allowsSourceSub(sub, completionData?.triggeredBy)) {
						deps.onLog(
							'cue',
							`[CUE] "${sub.name}" skipped — triggeredBy "${completionData?.triggeredBy ?? '(none)'}" not in source_sub`
						);
						continue;
					}

					if (sources.length === 1) {
						const rawStdout = completionData?.stdout ?? '';
						const slicedOutput = sliceTailByChars(rawStdout, SOURCE_OUTPUT_MAX_CHARS);
						const completion: FanInSourceCompletion = {
							sessionId,
							sessionName: completingName,
							output: slicedOutput,
							truncated: rawStdout.length > SOURCE_OUTPUT_MAX_CHARS,
							chainDepth: completionData?.chainDepth ?? 0,
						};
						// Honor include_output_from / forward_output_from on single-
						// source subscriptions via the shared filter. Previously this
						// path bypassed both lists, so any UI toggle silently no-op'd
						// for 1-source chains; the fan-in path already filtered.
						const { outputCompletions, perSourceOutputs, forwardedOutputs } = buildFilteredOutputs(
							[completion],
							sub
						);
						// Preserve pass-through of upstream-forwarded data — but filter
						// by forward_output_from when the list is set so user intent
						// is respected through the full chain.
						const mergedForwarded = mergeUpstreamForwarded(
							forwardedOutputs,
							completionData?.forwardedOutputs,
							sub
						);
						const event = createCueEvent('agent.completed', sub.name, {
							sourceSession: completingName,
							sourceSessionId: sessionId,
							status: completionData?.status ?? 'completed',
							exitCode: completionData?.exitCode ?? null,
							durationMs: completionData?.durationMs ?? 0,
							sourceOutput: outputCompletions.map((c) => c.output).join('\n---\n'),
							outputTruncated: outputCompletions.some((c) => c.truncated),
							triggeredBy: completionData?.triggeredBy,
							perSourceOutputs,
							...(Object.keys(mergedForwarded).length > 0
								? { forwardedOutputs: mergedForwarded }
								: {}),
						});

						if (sub.filter && !matchesFilter(event.payload, sub.filter)) {
							deps.onLog(
								'cue',
								`[CUE] "${sub.name}" filter not matched (${describeFilter(sub.filter)})`
							);
							continue;
						}

						deps.onLog('cue', `[CUE] "${sub.name}" triggered (agent.completed)`);
						deps.onDispatch(ownerSessionId, sub, event, completingName, chainDepth);
						continue;
					}

					deps.fanInTracker.handleCompletion(
						ownerSessionId,
						config.settings,
						sub,
						sources,
						sessionId,
						completingName,
						completionData
					);
				}
			}
		},
	};
}
