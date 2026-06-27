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
