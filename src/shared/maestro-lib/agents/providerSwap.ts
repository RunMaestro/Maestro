/**
 * Provider swap: changing an agent's provider without losing anything.
 *
 * An agent's provider (`toolType`) decides which binary runs, and a good deal
 * of the agent's state only means something to that one provider: each AI
 * tab's resume token, token usage, model, and effort, and the agent-level
 * overrides (binary path, extra arguments, environment, model, effort, context
 * window, the Claude token-source setting). A swap used to resolve that by
 * deleting every tab or by clearing the overrides, which destroyed the user's
 * transcripts and configuration to avoid carrying a few invalid fields.
 * Instead, the outgoing provider's values are PARKED under a per-provider map
 * and the incoming provider's parked values are restored, so switching away
 * and back lands on the same conversations and the same configuration.
 *
 * One invariant holds for both maps, and every reader of the live fields
 * relies on it: the live fields ALWAYS belong to the agent's current
 * `toolType`, and a parked map NEVER holds an entry for it.
 *
 *   - `AITab.providerSessions` parks a tab's `agentSessionId`, `usageStats`,
 *     `customModel`, and `customEffort`.
 *   - `Session.providerOverrides` parks the agent-level overrides named in
 *     {@link PROVIDER_OVERRIDE_KEYS}.
 *
 * {@link switchAgentProvider} is the one implementation of a provider switch
 * (requirement PS-5). A surface that changes an agent's provider calls it
 * rather than editing those fields itself, so the desktop, the TUI, and
 * `maestro-cli update-agent --provider` cannot disagree about what survives.
 *
 * The types below name only the fields a switch reads or writes. The desktop's
 * `Session` and `AITab` satisfy them, and every other field is carried through
 * untouched.
 */

import { getAgentDisplayName } from '../../agentMetadata';
import type { ToolType, UsageStats } from '../../types';

/**
 * A tab's parked state for one provider it is not currently using.
 *
 * `agentSessionId` is a provider-specific resume token (`--resume <id>` for
 * Claude, `resume <id>` for Codex, `--session <id>` for OpenCode), so a single
 * slot goes invalid the moment the agent's provider changes. Parking the old
 * provider's values here - instead of discarding them - is what lets a user
 * switch away and back and land on the same conversation. Token counts and the
 * per-tab model are parked alongside it because they are equally
 * provider-specific: blending two providers' usage produces a meaningless
 * total, and a Claude model name means nothing to Codex.
 */
export interface ProviderTabSession {
	agentSessionId: string | null;
	usageStats?: UsageStats;
	customModel?: string;
	customEffort?: string;
}

/** The AI tab fields a provider switch reads and writes. */
export interface ProviderSwitchTab {
	agentSessionId: string | null;
	usageStats?: UsageStats;
	customModel?: string;
	customEffort?: string;
	awaitingSessionId?: boolean;
	providerSessions?: Partial<Record<ToolType, ProviderTabSession>>;
	/** The provider that owns the tab's most recent turn, captured at send. */
	turnProvider?: ToolType;
}

/**
 * The agent-level overrides that belong to one provider. They are parked under
 * `providerOverrides` while the agent runs on another provider: a Claude binary
 * path, a Codex model, or an OpenCode environment means nothing to the others.
 *
 * Settings that are not provider-specific (name, working directory, SSH remote,
 * nudge and new-session messages, Agent Resilience, the Codex auto-reset flag,
 * directory grants) are not here, and a switch never touches them.
 */
export interface ProviderAgentOverrides {
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	/** Env vars switched off in the editor: kept, never spawned with. */
	customEnvVarsDisabled?: Record<string, string>;
	customModel?: string;
	customEffort?: string;
	customProviderPath?: string;
	customContextWindow?: number;
	/** Provenance of `customContextWindow` (finding AD1); travels with it. */
	contextWindowSource?: 'user-edited';
	/** The Claude token-source setting: `enableMaestroP`, `maestroPMode`, `maestroPPath`. */
	enableMaestroP?: boolean;
	maestroPMode?: 'interactive' | 'dynamic';
	maestroPPath?: string;
}

// Keyed by every field of ProviderAgentOverrides, so a field added there fails
// to compile until it is listed here too. A field missing from this list would
// silently stay live across a switch and leak into the next provider's spawn.
const OVERRIDE_KEY_SET: Record<keyof ProviderAgentOverrides, true> = {
	customPath: true,
	customArgs: true,
	customEnvVars: true,
	customEnvVarsDisabled: true,
	customModel: true,
	customEffort: true,
	customProviderPath: true,
	customContextWindow: true,
	contextWindowSource: true,
	enableMaestroP: true,
	maestroPMode: true,
	maestroPPath: true,
};

/** Every agent-level field a provider switch parks and restores. */
export const PROVIDER_OVERRIDE_KEYS = Object.keys(OVERRIDE_KEY_SET) as ReadonlyArray<
	keyof ProviderAgentOverrides
>;

/** A queued message's settings snapshot, as a provider switch sees it. */
export interface ProviderSwitchQueuedItem {
	id: string;
	tabId: string;
	/** The model and effort the item was queued with (`QueuedItem.turnSettings`). */
	turnSettings?: { model?: string; effort?: string };
}

/** The agent fields a provider switch reads and writes. */
export interface ProviderSwitchAgent extends ProviderAgentOverrides {
	toolType: ToolType;
	aiTabs?: ProviderSwitchTab[];
	/**
	 * Parked agent-level overrides for every provider this agent is NOT
	 * currently using. Never holds an entry for `toolType`.
	 */
	providerOverrides?: Partial<Record<ToolType, ProviderAgentOverrides>>;
	executionQueue?: ProviderSwitchQueuedItem[];
}

/**
 * Provider-specific state a switch could not park, so it was cleared instead.
 *
 * `queued-turn-settings`: a queued message froze the model and effort it was
 * queued with, but a queued turn spawns on the agent's provider at the time it
 * runs, and the old provider's model is not one the new provider can run. The
 * snapshot is dropped, so the message runs on the incoming provider's
 * configuration, and reported here.
 */
export interface UnparkedProviderState {
	kind: 'queued-turn-settings';
	/** The provider the cleared state belonged to. */
	provider: ToolType;
	/** The tab the queued message targets. */
	tabId: string;
	queuedItemId: string;
	/** The cleared values. Undefined means that half was the default. */
	model?: string;
	effort?: string;
	/** One line a surface can show as it is. */
	message: string;
}

export interface ProviderSwitchResult<A> {
	/** The agent on its new provider. Every field the switch did not touch is unchanged. */
	agent: A;
	/** Whatever could not be parked and was cleared, for a notice. Empty in the common case. */
	unparked: UnparkedProviderState[];
}

/**
 * Move a tab's live provider-specific state into `providerSessions` under
 * `fromProvider`, and lift `toProvider`'s parked state into the live fields.
 *
 * Everything else on the tab - `logs` above all - is left untouched: the
 * transcript is not provider-specific and survives any number of switches.
 * Returns the tab unchanged when the provider did not actually change.
 */
export function switchTabProvider<T extends ProviderSwitchTab>(
	tab: T,
	fromProvider: ToolType,
	toProvider: ToolType
): T {
	if (fromProvider === toProvider) return tab;

	const parked: Partial<Record<ToolType, ProviderTabSession>> = {
		...(tab.providerSessions ?? {}),
	};

	// Park the outgoing provider's live values. A tab that never ran under the
	// outgoing provider still gets an entry, so switching back restores its
	// "fresh tab" state rather than inheriting whatever the detour left behind.
	parked[fromProvider] = {
		agentSessionId: tab.agentSessionId,
		usageStats: tab.usageStats,
		customModel: tab.customModel,
		customEffort: tab.customEffort,
	};

	const restored = parked[toProvider];
	// The incoming provider must never keep an entry in the map - the live
	// fields are its home now.
	delete parked[toProvider];

	return {
		...tab,
		agentSessionId: restored?.agentSessionId ?? null,
		usageStats: restored?.usageStats,
		customModel: restored?.customModel,
		customEffort: restored?.customEffort,
		// A restored session ID is a real resume target, not something we are
		// waiting on the agent to hand back.
		awaitingSessionId: false,
		providerSessions: parked,
	};
}

/**
 * The provider that owns this tab's most recent turn.
 *
 * Settings are codified at send: an in-flight turn keeps running under the
 * provider it was sent with, even if the user changes the agent's provider
 * while it works. Async agent events (session ID, usage, exit) therefore have
 * to be attributed to the provider that STARTED the turn, not to whatever the
 * agent is configured with by the time they land - otherwise a mid-turn switch
 * writes the old provider's resume token into the new provider's live slot and
 * the next spawn tries to resume a session that provider has never heard of.
 *
 * Falls back to the agent's current provider for tabs that predate
 * `turnProvider` or have never sent a message.
 */
export function resolveTurnProvider(
	tab: Pick<ProviderSwitchTab, 'turnProvider'> | undefined,
	agent: Pick<ProviderSwitchAgent, 'toolType'>
): ToolType {
	return tab?.turnProvider ?? agent.toolType;
}

/**
 * Apply an update to whichever slot belongs to `owningProvider` - the live
 * fields when it is the agent's current provider, the parked entry otherwise.
 *
 * This is how a late event from a turn that outlived a provider switch is
 * recorded without corrupting the current provider's state. The parked entry is
 * created if the tab has never run under that provider.
 */
export function updateProviderSlot<T extends ProviderSwitchTab>(
	tab: T,
	agent: Pick<ProviderSwitchAgent, 'toolType'>,
	owningProvider: ToolType,
	update: Partial<ProviderTabSession>
): T {
	if (owningProvider === agent.toolType) {
		return { ...tab, ...update };
	}

	const existing = tab.providerSessions?.[owningProvider];
	return {
		...tab,
		providerSessions: {
			...(tab.providerSessions ?? {}),
			[owningProvider]: {
				agentSessionId: existing?.agentSessionId ?? null,
				...existing,
				...update,
			},
		},
	};
}

/** The overrides the agent has set right now, leaving out the ones it does not. */
function liveProviderOverrides(agent: ProviderSwitchAgent): ProviderAgentOverrides {
	const live: Record<string, unknown> = {};
	for (const key of PROVIDER_OVERRIDE_KEYS) {
		if (agent[key] !== undefined) live[key] = agent[key];
	}
	return live as ProviderAgentOverrides;
}

function describeClearedQueuedSettings(
	model: string | undefined,
	effort: string | undefined,
	fromProvider: ToolType,
	toProvider: ToolType
): string {
	const settings = [
		model !== undefined ? `model "${model}"` : null,
		effort !== undefined ? `effort "${effort}"` : null,
	]
		.filter((part): part is string => part !== null)
		.join(' and ');
	return (
		`A queued message was set to run with ${settings} on ${getAgentDisplayName(fromProvider)}. ` +
		`It will run with the agent's ${getAgentDisplayName(toProvider)} settings instead.`
	);
}

/**
 * Switch an agent to `newProvider` without losing anything that can be kept.
 *
 *   - Every AI tab survives with its transcript, and its provider session,
 *     usage, model, and effort are parked under the old provider by
 *     {@link switchTabProvider}. Switching back restores them.
 *   - The agent-level overrides in {@link PROVIDER_OVERRIDE_KEYS} are parked
 *     under `providerOverrides[oldProvider]` instead of being cleared, and
 *     whatever the incoming provider had parked is restored. An override the
 *     incoming provider never had is absent, never inherited from the old one.
 *   - A turn in flight is left alone: the switch never touches process state,
 *     and the tab's `turnProvider` keeps that turn's late events attributed to
 *     the provider that started it (see {@link resolveTurnProvider}).
 *   - What could not be parked is cleared and returned in `unparked`, so a
 *     surface can tell the user (see {@link UnparkedProviderState}).
 *
 * Returns a new agent and never mutates the input. Cleared fields are set to
 * `undefined` rather than deleted, so merging the result over the old agent
 * clears them too. Switching to the provider the agent already uses returns
 * the same agent and an empty list.
 */
export function switchAgentProvider<A extends ProviderSwitchAgent>(
	agent: A,
	newProvider: ToolType
): ProviderSwitchResult<A> {
	const fromProvider = agent.toolType;
	if (fromProvider === newProvider) return { agent, unparked: [] };

	// Park the outgoing provider's overrides and lift the incoming provider's
	// out of the map. The live values win over any entry the map holds for the
	// outgoing provider: by the invariant there should be none, and the live
	// fields are what that provider actually ran with.
	const parked: Partial<Record<ToolType, ProviderAgentOverrides>> = {
		...(agent.providerOverrides ?? {}),
	};
	const outgoing = liveProviderOverrides(agent);
	if (Object.keys(outgoing).length > 0) {
		parked[fromProvider] = outgoing;
	} else {
		delete parked[fromProvider];
	}
	const incoming: ProviderAgentOverrides = parked[newProvider] ?? {};
	delete parked[newProvider];

	const restoredOverrides: Record<string, unknown> = {};
	for (const key of PROVIDER_OVERRIDE_KEYS) {
		restoredOverrides[key] = incoming[key];
	}

	const unparked: UnparkedProviderState[] = [];
	const executionQueue = agent.executionQueue?.map((item) => {
		if (!item.turnSettings) return item;
		const { model, effort } = item.turnSettings;
		// An item queued on the agent's default named no setting of its own, so
		// following the incoming provider's configuration loses nothing.
		if (model !== undefined || effort !== undefined) {
			unparked.push({
				kind: 'queued-turn-settings',
				provider: fromProvider,
				tabId: item.tabId,
				queuedItemId: item.id,
				model,
				effort,
				message: describeClearedQueuedSettings(model, effort, fromProvider, newProvider),
			});
		}
		return { ...item, turnSettings: undefined };
	});

	const switched = {
		...agent,
		toolType: newProvider,
		...restoredOverrides,
		providerOverrides: Object.keys(parked).length > 0 ? parked : undefined,
		...(agent.aiTabs && {
			aiTabs: agent.aiTabs.map((tab) => switchTabProvider(tab, fromProvider, newProvider)),
		}),
		...(executionQueue && { executionQueue }),
	};

	return { agent: switched as A, unparked };
}
