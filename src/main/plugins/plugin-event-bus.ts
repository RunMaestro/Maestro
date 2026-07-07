/**
 * Host -> plugin event bus (main process).
 *
 * Implements the `PluginEventBus` contract behind `events.subscribe` /
 * `events.unsubscribe`. Per-plugin topic subscriptions; `emit(PluginEvent)` fans
 * the event out to every plugin subscribed to that topic. Two security
 * invariants are baked in:
 *  - RE-AUTHORIZE every delivery against LIVE grants (injected `isPermitted`),
 *    so revoking `events:subscribe` stops delivery on the very next event
 *    (instant revoke) - a stale subscription set is never trusted.
 *  - delivery goes through an injected sink (the sandbox host's event push); the
 *    bus never holds a process handle or channel itself.
 *
 * Only the fixed metadata-only topic catalog is accepted; unknown topics are
 * dropped at subscribe time. Pure given the injected deps, so it is unit-testable
 * without Electron.
 */

import {
	isPluginEventTopic,
	type PluginEvent,
	type PluginEventBus,
	type PluginEventTopic,
} from '../../shared/plugins/events';
import type { PluginCapability } from '../../shared/plugins/permissions';

/**
 * Topics whose payloads expose a specific host domain require the matching
 * read capability IN ADDITION to `events:subscribe`. Checked live on every
 * delivery (same instant-revoke discipline as the base grant), so revoking
 * e.g. `history:read` silences `history.entryAdded` on the very next event
 * without disturbing the plugin's other subscriptions. Topics absent from
 * this map need only `events:subscribe`.
 */
export const TOPIC_REQUIRED_CAPABILITY: Partial<Record<PluginEventTopic, PluginCapability>> = {
	'history.entryAdded': 'history:read',
	'agent.completed': 'agents:read',
};

export interface PluginEventBusDeps {
	/** Re-authorize a delivery against LIVE grants: does this plugin currently
	 * hold `events:subscribe`? Called for EVERY delivery (instant revoke). */
	isPermitted: (pluginId: string) => boolean;
	/** Re-authorize a capability-gated topic against LIVE grants: does this
	 * plugin currently hold `capability`? Called for every delivery of a topic
	 * in `TOPIC_REQUIRED_CAPABILITY`. DEFAULT DENY: when this dep is absent,
	 * gated topics are delivered to nobody (fail closed, never open). */
	hasCapability?: (pluginId: string, capability: PluginCapability) => boolean;
	/** Push an `event` control message to a running plugin sandbox. Returns false
	 * when the plugin is not running, so the bus can prune a dead subscription. */
	push: (pluginId: string, event: PluginEvent) => boolean;
	/** Optional audit/observability hook for deliveries and revoke-pruning. */
	onDelivery?: (pluginId: string, topic: PluginEventTopic, delivered: boolean) => void;
}

/** Max own keys kept on a delivered payload (metadata-only guard). */
const MAX_PAYLOAD_KEYS = 32;
/** Max serialized bytes for a delivered payload before it is dropped wholesale. */
const MAX_PAYLOAD_BYTES = 8192;

/**
 * Project a payload down to metadata only: keep only own enumerable properties
 * whose values are primitives (string | number | boolean | null), drop nested
 * objects/arrays/functions and any other non-primitive, cap the key count, and
 * drop the whole payload to {} when the serialized projection exceeds the byte
 * cap. Structural enforcement of the "never carry content" invariant, applied on
 * delivery so a buggy emit site cannot leak a content-bearing object.
 */
function sanitizeEventPayload(payload: unknown): Record<string, string | number | boolean | null> {
	const out: Record<string, string | number | boolean | null> = {};
	if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return out;
	let kept = 0;
	for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
		if (kept >= MAX_PAYLOAD_KEYS) break;
		if (
			typeof value === 'string' ||
			typeof value === 'number' ||
			typeof value === 'boolean' ||
			value === null
		) {
			out[key] = value;
			kept += 1;
		}
	}
	let serialized: string;
	try {
		serialized = JSON.stringify(out);
	} catch {
		return {};
	}
	if (serialized.length > MAX_PAYLOAD_BYTES) return {};
	return out;
}

export class PluginEventBusImpl implements PluginEventBus {
	/** pluginId -> subscribed topics. Runtime collection (inserted/removed per
	 * subscribe/unsubscribe), hence a Map of Sets. */
	private readonly subscriptions = new Map<string, Set<PluginEventTopic>>();

	constructor(private readonly deps: PluginEventBusDeps) {}

	subscribe(pluginId: string, topics: readonly PluginEventTopic[]): { topics: PluginEventTopic[] } {
		const valid = (topics ?? []).filter(isPluginEventTopic);
		if (valid.length === 0) return { topics: [] };
		let set = this.subscriptions.get(pluginId);
		if (!set) {
			set = new Set<PluginEventTopic>();
			this.subscriptions.set(pluginId, set);
		}
		for (const topic of valid) set.add(topic);
		return { topics: [...set] };
	}

	unsubscribe(pluginId: string, topics?: readonly PluginEventTopic[]): void {
		if (!topics) {
			this.subscriptions.delete(pluginId);
			return;
		}
		const set = this.subscriptions.get(pluginId);
		if (!set) return;
		for (const topic of topics) set.delete(topic);
		if (set.size === 0) this.subscriptions.delete(pluginId);
	}

	/** Drop every subscription for a plugin (stop / disable / uninstall). */
	clear(pluginId: string): void {
		this.subscriptions.delete(pluginId);
	}

	/** The topics a plugin is currently subscribed to (snapshot, for tests/UI). */
	topicsFor(pluginId: string): PluginEventTopic[] {
		const set = this.subscriptions.get(pluginId);
		return set ? [...set] : [];
	}

	/**
	 * Fan one event out to every subscriber. Each delivery is independently
	 * re-authorized against live grants; an unauthorized (revoked) plugin has its
	 * subscription pruned and receives nothing. A capability-gated topic (see
	 * `TOPIC_REQUIRED_CAPABILITY`) is additionally withheld from subscribers not
	 * currently holding the topic's capability — withheld, not pruned, so a
	 * later grant resumes delivery without resubscribing. A plugin whose sink
	 * reports it is gone is also pruned. The integrator calls this from core
	 * emit sites.
	 */
	emit(event: PluginEvent): void {
		if (!isPluginEventTopic(event.topic)) return;
		// Snapshot first: pruning during iteration mutates the map.
		const recipients: string[] = [];
		for (const [pluginId, topics] of this.subscriptions) {
			if (topics.has(event.topic)) recipients.push(pluginId);
		}
		// Defense in depth: enforce the metadata-only invariant structurally on
		// every delivery, independent of (and untrusting of) the emit site.
		(event as { payload: unknown }).payload = sanitizeEventPayload(event.payload);
		for (const pluginId of recipients) {
			if (!this.deps.isPermitted(pluginId)) {
				// Grant revoked since subscribing: stop trusting the subscription.
				this.clear(pluginId);
				this.deps.onDelivery?.(pluginId, event.topic, false);
				continue;
			}
			const requiredCap = TOPIC_REQUIRED_CAPABILITY[event.topic];
			if (requiredCap && !(this.deps.hasCapability?.(pluginId, requiredCap) ?? false)) {
				// Missing the topic's domain capability (or no checker wired —
				// fail closed). Withhold delivery; keep the subscription.
				this.deps.onDelivery?.(pluginId, event.topic, false);
				continue;
			}
			const delivered = this.deps.push(pluginId, event);
			if (!delivered) this.clear(pluginId);
			this.deps.onDelivery?.(pluginId, event.topic, delivered);
		}
	}
}
