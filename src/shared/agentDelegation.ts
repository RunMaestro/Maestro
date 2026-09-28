/**
 * Agent-to-agent delegation: who handed what to whom, so the chat can say so.
 *
 * A typed `@mention` leaves a trace in the conversation it was typed in: the
 * consulted agent's reply streams into a bubble whose header names the agent
 * that answered. An agent reaching another agent ON ITS OWN left none. It runs
 * `maestro-cli dispatch` (hand over work) or `maestro-cli ask` (put a question)
 * from its shell, and the only record was a command line inside a tool card -
 * exactly what someone skimming the transcript does not read. The two paths
 * meet more often than it seems: a mention that does not resolve to a known
 * agent is plain text, so the source agent reads "@proxmox take care of it" as
 * an instruction and delegates by hand. Same intent, a pill one way and nothing
 * the other.
 *
 * Attributing a CLI delegation needs two facts the CLI cannot work out for
 * itself: which agent is calling, and from which tab. So Maestro states them in
 * the environment of every agent it spawns ({@link CALLER_AGENT_ID_ENV_VAR},
 * {@link CALLER_TAB_ID_ENV_VAR}), the CLI forwards them on the wire as
 * `fromSessionId` / `fromTabId`, and the desktop records an
 * {@link AgentDelegationNotice} into the caller's transcript.
 *
 * These are deliberately NOT `MAESTRO_AGENT_ID`. That variable already means
 * "you are Pianola" to `maestro-cli pianola watch`, which switches on its
 * judgment handoff when it is set; stamping it on every agent would hand that
 * role to any agent that happens to run a watch.
 */

/** The Maestro agent id a spawned agent process runs as. */
export const CALLER_AGENT_ID_ENV_VAR = 'MAESTRO_CALLER_AGENT_ID';

/** The AI tab within that agent whose turn spawned the process, when known. */
export const CALLER_TAB_ID_ENV_VAR = 'MAESTRO_CALLER_TAB_ID';

/** The agent (and, when known, the AI tab) a CLI invocation is running under. */
export interface CallerIdentity {
	agentId: string;
	tabId?: string;
}

/** The env entries that tell a spawned agent's shell who it is. */
export function buildCallerIdentityEnv(agentId: string, tabId?: string): Record<string, string> {
	return {
		[CALLER_AGENT_ID_ENV_VAR]: agentId,
		...(tabId ? { [CALLER_TAB_ID_ENV_VAR]: tabId } : {}),
	};
}

/**
 * An env override record with the caller identity removed, for anything that
 * keys a cache on how an agent is CONFIGURED (the omp model catalog). The
 * identity says which agent is running, not how it is set up, so keeping it
 * gives every agent its own cache entry and misses the shared warm-up the
 * detector primes with no overrides at all. Returns undefined when nothing else
 * is left, which is exactly what an agent with no overrides passes.
 */
export function withoutCallerIdentityEnv(
	env: Record<string, string> | undefined
): Record<string, string> | undefined {
	if (!env) return undefined;
	const rest = { ...env };
	delete rest[CALLER_AGENT_ID_ENV_VAR];
	delete rest[CALLER_TAB_ID_ENV_VAR];
	return Object.keys(rest).length > 0 ? rest : undefined;
}

/**
 * Read the caller identity from an environment. A blank value counts as absent,
 * the same way a blank env entry means "unset" everywhere else in Maestro, and
 * a tab with no agent is meaningless so it is dropped along with it.
 */
export function readCallerIdentity(
	env: Record<string, string | undefined>
): CallerIdentity | undefined {
	const agentId = env[CALLER_AGENT_ID_ENV_VAR]?.trim();
	if (!agentId) return undefined;
	const tabId = env[CALLER_TAB_ID_ENV_VAR]?.trim();
	return tabId ? { agentId, tabId } : { agentId };
}

/**
 * The wire fields a delegating CLI message carries. The names are the ones
 * `cross_agent_ask` already used for its `--from`, so both verbs speak one
 * vocabulary.
 */
export interface CallerMessageFields {
	fromSessionId: string;
	fromTabId?: string;
}

/** Spreadable message fields for a caller; empty when there is none. */
export function callerMessageFields(
	caller: CallerIdentity | undefined
): Partial<CallerMessageFields> {
	if (!caller) return {};
	return {
		fromSessionId: caller.agentId,
		...(caller.tabId ? { fromTabId: caller.tabId } : {}),
	};
}

/** The receiving half of {@link callerMessageFields}: narrow an untrusted message. */
export function readCallerMessageFields(
	message: Record<string, unknown>
): CallerMessageFields | undefined {
	const fromSessionId =
		typeof message.fromSessionId === 'string' ? message.fromSessionId.trim() : '';
	if (!fromSessionId) return undefined;
	const fromTabId = typeof message.fromTabId === 'string' ? message.fromTabId.trim() : '';
	return fromTabId ? { fromSessionId, fromTabId } : { fromSessionId };
}

/** `dispatch` hands over work; `ask` puts a question and waits for the answer. */
export type AgentDelegationKind = 'dispatch' | 'ask';

/** One hand-off, as delivered to the renderer that owns the caller's transcript. */
export interface AgentDelegationNotice {
	kind: AgentDelegationKind;
	/** The delegating agent. */
	fromSessionId: string;
	/** The delegating agent's AI tab, when the spawn stamped it. */
	fromTabId?: string;
	/** The agent the work or question went to. */
	targetSessionId: string;
	/** The tab it landed in, when known (a `--new-tab`, a named `--tab`, a queue). */
	targetTabId?: string;
	/** What was handed over. The card shows a one-line subject of it. */
	prompt: string;
	/** The dispatch created a fresh tab on the target. */
	newTab?: boolean;
	/** The dispatch joined the target's execution queue rather than running now. */
	queued?: boolean;
}

/**
 * Whether a dispatch is the caller writing into its own conversation, which is
 * a loop rather than a hand-off - a pill there would claim the agent delegated
 * to itself. A dispatch to the caller's own agent that names no tab lands in
 * whatever tab is active, which is the caller's own in practice, so it counts
 * too. A new tab or a different named tab in the same agent IS a hand-off.
 */
export function isSelfDispatch(
	caller: CallerMessageFields,
	targetSessionId: string,
	targetTabId?: string
): boolean {
	if (caller.fromSessionId !== targetSessionId) return false;
	if (!targetTabId) return true;
	return caller.fromTabId === targetTabId;
}
