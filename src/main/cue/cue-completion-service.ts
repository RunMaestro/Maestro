import type { MainLogLevel } from '../../shared/logger-types';
import { describeFilter, matchesFilter } from './cue-filter';
import { SOURCE_OUTPUT_MAX_CHARS, type CueFanInTracker } from './cue-fan-in-tracker';
import {
	createCueEvent,
	type AgentCompletionData,
	type CueConfig,
	type CueSubscription,
} from './cue-types';

export interface CueCompletionServiceDeps {
	enabled: () => boolean;
	getSessions: () => Array<{ id: string; name: string }>;
	getSessionConfigs: () => Map<string, CueConfig>;
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

export function createCueCompletionService(deps: CueCompletionServiceDeps): CueCompletionService {
	return {
		hasCompletionSubscribers(sessionId: string): boolean {
			if (!deps.enabled()) return false;

			const allSessions = deps.getSessions();
			const completingSession = allSessions.find((session) => session.id === sessionId);
			const completingName = completingSession?.name ?? sessionId;

			for (const [ownerSessionId, config] of deps.getSessionConfigs()) {
				for (const sub of config.subscriptions) {
					if (sub.event !== 'agent.completed' || sub.enabled === false) continue;
					if (sub.agent_id && sub.agent_id !== ownerSessionId) continue;

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

			for (const [ownerSessionId, config] of deps.getSessionConfigs()) {
				for (const sub of config.subscriptions) {
					if (sub.event !== 'agent.completed' || sub.enabled === false) continue;
					if (sub.agent_id && sub.agent_id !== ownerSessionId) continue;

					const sources = getMatchingSources(sub);
					if (!sources.some((src) => src === sessionId || src === completingName)) continue;

					if (sources.length === 1) {
						const rawStdout = completionData?.stdout ?? '';
						const slicedOutput = rawStdout.slice(-SOURCE_OUTPUT_MAX_CHARS);
						// Per-source output map for named template variables.
						// Single-chain: just one entry.
						const perSourceOutputs: Record<string, string> = {
							[completingName]: slicedOutput,
						};
						// Forward any outputs that were forwarded TO this completing
						// agent from its own upstream. They're carried in the
						// completionData.forwardedOutputs field (set by the executor
						// from the triggering event's payload).
						const upstreamForwarded = (completionData as Record<string, unknown> | undefined)
							?.forwardedOutputs as Record<string, string> | undefined;
						const event = createCueEvent('agent.completed', sub.name, {
							sourceSession: completingName,
							sourceSessionId: sessionId,
							status: completionData?.status ?? 'completed',
							exitCode: completionData?.exitCode ?? null,
							durationMs: completionData?.durationMs ?? 0,
							sourceOutput: slicedOutput,
							outputTruncated: rawStdout.length > SOURCE_OUTPUT_MAX_CHARS,
							triggeredBy: completionData?.triggeredBy,
							perSourceOutputs,
							...(upstreamForwarded && Object.keys(upstreamForwarded).length > 0
								? { forwardedOutputs: upstreamForwarded }
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
