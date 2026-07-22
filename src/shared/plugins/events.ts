/**
 * Host -> plugin event bus contract (pure, bundle-safe).
 *
 * A plugin holding `events:subscribe` receives a FIXED catalog of host events.
 * Payloads are deliberately METADATA ONLY - never raw transcript content or
 * agent output - because redaction is not a security boundary for free-form text
 * (a plugin with any egress would otherwise exfiltrate secrets). The main-process
 * event bus re-authorizes every delivery against live grants (instant revoke).
 */

/** The fixed catalog of topics a plugin may subscribe to. */
export const PLUGIN_EVENT_TOPICS = [
	'session.created',
	'session.updated',
	'session.removed',
	'agent.awaiting', // an agent is blocked waiting on input (no prompt text)
	'agent.statusChanged',
	'cue.fired', // a Maestro Cue trigger fired (type only)
	'agent.exited', // an agent process exited (sessionId + exit code, no output)
	'agent.error', // an agent surfaced an error (type + recoverable, no message body)
	'usage.updated', // token/cost usage update for a session (counts only)
	'run.completed', // a batch query/auto-run completed (timing + source, no output)
	'cue.runStarted', // a Cue automation run started (ids only)
	'cue.runFinished', // a Cue automation run reached a terminal state (status only)
	'history.entryAdded', // a history entry was added (ids/classification only)
	'agent.completed', // an agent reached a terminal state (metadata only, no output)
	'tool.executed', // a tool call started or finished (name + timing only, no arguments or results)
	'board.cardStatusChanged', // a board card moved between statuses (ids + statuses)
	'board.cardCompleted', // a board card finished successfully (ids only, no summary)
	'board.cardBlocked', // a board card needs a human (ids + run outcome, no reason text)
	'board.decomposed', // an auto-decompose pass expanded triage cards (counts only)
] as const;

export type PluginEventTopic = (typeof PLUGIN_EVENT_TOPICS)[number];

export function isPluginEventTopic(value: unknown): value is PluginEventTopic {
	return typeof value === 'string' && (PLUGIN_EVENT_TOPICS as readonly string[]).includes(value);
}

/**
 * Metadata-only payload per topic. Keep these free of message bodies, prompt
 * text, agent output, file contents, and secret-bearing fields - see the module
 * doc. Adding a field is a host-API MINOR; adding sensitive data is forbidden.
 */
export interface PluginEventPayloads {
	'session.created': { sessionId: string; title?: string; agentId?: string; projectPath?: string };
	'session.updated': { sessionId: string; title?: string; status?: string };
	'session.removed': { sessionId: string };
	'agent.awaiting': { agentId: string; tabId?: string; kind?: string; risk?: string };
	'agent.statusChanged': { agentId: string; tabId?: string; status: string };
	'cue.fired': { cueType: string; projectPath?: string };
	'agent.exited': { sessionId: string; exitCode: number };
	'agent.error': { sessionId: string; agentId?: string; errorType: string; recoverable: boolean };
	'usage.updated': {
		sessionId: string;
		inputTokens: number;
		outputTokens: number;
		cacheReadInputTokens: number;
		cacheCreationInputTokens: number;
		totalCostUsd: number;
		contextWindow: number;
		reasoningTokens?: number;
	};
	'run.completed': {
		sessionId: string;
		agentType: string;
		source: 'user' | 'auto';
		durationMs: number;
		projectPath?: string;
		tabId?: string;
	};
	'cue.runStarted': { runId: string; sessionId: string; subscriptionName: string };
	'cue.runFinished': {
		runId: string;
		sessionId: string;
		subscriptionName: string;
		status: string;
		pipelineName?: string;
		durationMs?: number;
	};
	'history.entryAdded': {
		entryId: string;
		sessionId?: string;
		agentId?: string;
		tabId?: string;
		projectPath?: string;
		kind?: string;
		source?: string;
		createdAt?: string | number;
	};
	'agent.completed': {
		sessionId: string;
		agentId?: string;
		tabId?: string;
		status: 'completed' | 'failed' | 'cancelled' | 'interrupted' | string;
		exitCode?: number;
		durationMs?: number;
		projectPath?: string;
		source?: 'user' | 'auto' | 'cue' | 'background' | string;
		startedAt?: string;
		completedAt?: string;
		costUsd?: number;
		runId?: string;
		parentRunId?: string;
		providerSessionId?: string;
		queueDepth?: number;
		inputTokens?: number;
		outputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		reasoningTokens?: number;
		totalTokens?: number;
		chainRootId?: string;
		parentEventId?: string;
		pipelineId?: string;
		pipelineName?: string;
		lineageDepth?: number;
	};
	/** A tool call transitioned. Name + timing ONLY: the tool's `state` object,
	 * arguments and results are content-bearing and must never appear here. */
	'tool.executed': {
		sessionId: string;
		tabId?: string;
		toolName: string;
		toolCallId?: string;
		/** Best-effort lifecycle string (e.g. running / completed / failed) when
		 * the provider reports one; omitted otherwise. */
		phase?: string;
		timestamp: number;
		durationMs?: number;
	};
	/**
	 * Board card status transition (Board Phase 5). Every transition the board
	 * dispatcher performs: promote, claim, retry, reclaim, cancel, terminal.
	 *
	 * `cardTitle` is the only human-authored string here. It is the card's
	 * identity in the UI, so it ships - but note that titles on auto-decomposed
	 * cards originate from a model, and no other generated text (prompt body,
	 * run output, run summary, block reason) is ever carried on these topics.
	 */
	'board.cardStatusChanged': {
		boardId: string;
		cardId: string;
		cardTitle: string;
		fromStatus: string;
		toStatus: string;
		/** 1-based attempt number of the card's latest run, when it has one. */
		attempt?: number;
		/** Pool worker bound to the latest run (worker pool), when pooled. */
		workerAgentId?: string;
		projectPath?: string;
	};
	'board.cardCompleted': {
		boardId: string;
		cardId: string;
		cardTitle: string;
		attempt?: number;
		workerAgentId?: string;
		/** Branch of the isolated worktree the attempt ran in, when isolated. */
		worktreeBranch?: string;
		projectPath?: string;
	};
	'board.cardBlocked': {
		boardId: string;
		cardId: string;
		cardTitle: string;
		attempt?: number;
		workerAgentId?: string;
		/**
		 * Outcome enum recorded on the failed run (`error` / `blocked` / ...).
		 * A CLASSIFICATION, never the free-form block reason, which can quote
		 * agent output.
		 */
		outcome?: string;
		projectPath?: string;
	};
	'board.decomposed': {
		boardId: string;
		/** How many triage cards the pass expanded into children. */
		triageCardCount: number;
		projectPath?: string;
	};
}

/** A typed host event. */
export interface PluginEvent<T extends PluginEventTopic = PluginEventTopic> {
	topic: T;
	/** ISO-8601 timestamp. */
	at: string;
	payload: PluginEventPayloads[T];
}

/**
 * Main-process event-bus surface consumed by the `events.subscribe` /
 * `events.unsubscribe` host handlers. The implementation lives in the main
 * process (it pushes 'event' control messages to running sandboxes and
 * re-authorizes every delivery against live grants); this is just the contract
 * the handler codes against so the handler stays injectable/testable.
 */
export interface PluginEventBus {
	/** Subscribe a plugin to topics; returns the topics actually registered. */
	subscribe(pluginId: string, topics: readonly PluginEventTopic[]): { topics: PluginEventTopic[] };
	/** Unsubscribe from the given topics, or all topics when omitted. */
	unsubscribe(pluginId: string, topics?: readonly PluginEventTopic[]): void;
}
