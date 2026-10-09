/**
 * Runtime agent registry.
 *
 * Maestro's built-in agents live in a compile-time tuple (`AGENT_IDS`) so the
 * type system can enforce exhaustiveness across capabilities, parsers, storage,
 * and error patterns. That static guarantee is valuable and we keep it: this
 * registry does NOT replace the tuple, it layers runtime-registered agents
 * (contributed by tier-1 plugins) ALONGSIDE the built-in core.
 *
 * The split is deliberate:
 *   - Built-in agents: known at build time, fully type-checked, always present.
 *   - Runtime agents: discovered from enabled plugins at run time, identified by
 *     plain string ids, looked up here rather than through the `AgentId` union.
 *
 * Anything that needs to answer "is this a real agent id?" or "how do I launch
 * it?" consults the registry, which merges both sources. This is a pure,
 * bundle-safe module - no fs, no Electron. SPAWNING a runtime agent (executing
 * its `binaryName`) is a separate, security-reviewed wiring step and is NOT
 * enabled by registration alone.
 */

import { AGENT_IDS } from '../agentIds';
import type { AgentContribution } from './contributions';

/**
 * A resolved runtime agent. Structurally identical to the AgentContribution the
 * plugin declared - the registry just indexes it by id. Aliased for intent.
 */
export type RuntimeAgentDescriptor = AgentContribution;

/** Read-only view over the built-in core plus the runtime-registered agents. */
export interface AgentRegistry {
	/** Built-in agent ids (the static AGENT_IDS tuple), in declaration order. */
	readonly builtInIds: readonly string[];
	/** Runtime (plugin-contributed) agent ids, in registration order. */
	readonly runtimeIds: readonly string[];
	/** True if `id` is one of the compile-time built-in agents. */
	isBuiltIn(id: string): boolean;
	/** True if `id` is a runtime (plugin-contributed) agent. */
	isRuntime(id: string): boolean;
	/** True if `id` is known at all (built-in or runtime). */
	isKnown(id: string): boolean;
	/** The runtime descriptor for `id`, or undefined if not a runtime agent. */
	getRuntime(id: string): RuntimeAgentDescriptor | undefined;
	/** All runtime descriptors, in registration order. */
	listRuntime(): RuntimeAgentDescriptor[];
	/** Every known agent id: built-ins first, then runtime agents. */
	listAll(): string[];
}

/**
 * Build a registry from the runtime agents a set of plugins contributed. On a
 * collision (a runtime id equal to a built-in id, or two plugins claiming the
 * same namespaced id - already prevented upstream by aggregation) the built-in
 * always wins and the duplicate runtime entry is dropped: a plugin must never be
 * able to shadow or impersonate a first-party agent.
 */
export function createAgentRegistry(
	runtimeAgents: readonly RuntimeAgentDescriptor[],
	builtInIds: readonly string[] = AGENT_IDS
): AgentRegistry {
	const builtIn = new Set<string>(builtInIds);
	const runtime = new Map<string, RuntimeAgentDescriptor>();
	for (const agent of runtimeAgents) {
		if (builtIn.has(agent.id)) continue; // never let a plugin shadow a built-in
		if (runtime.has(agent.id)) continue; // first registration wins
		runtime.set(agent.id, agent);
	}
	const builtInList = Object.freeze([...builtInIds]);
	const runtimeList = Object.freeze([...runtime.keys()]);

	return Object.freeze({
		builtInIds: builtInList,
		runtimeIds: runtimeList,
		isBuiltIn: (id: string): boolean => builtIn.has(id),
		isRuntime: (id: string): boolean => runtime.has(id),
		isKnown: (id: string): boolean => builtIn.has(id) || runtime.has(id),
		getRuntime: (id: string): RuntimeAgentDescriptor | undefined => runtime.get(id),
		listRuntime: (): RuntimeAgentDescriptor[] => [...runtime.values()],
		listAll: (): string[] => [...builtInList, ...runtimeList],
	});
}

/** An empty registry (built-ins only). Useful as a default before plugins load. */
export function emptyAgentRegistry(): AgentRegistry {
	return createAgentRegistry([]);
}
