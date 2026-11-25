/**
 * Per-agent environment for a spawn that arrives over the web bridge.
 *
 * The bridge strips `customEnvVars` from every `sessions:*` and `agents:*`
 * reply (`sanitizeRemoteConfiguration`), so a browser never holds an agent's
 * own env vars. A browser-built `process:spawn` therefore carries no
 * `sessionCustomEnvVars`, and the turn ran under the provider-level and global
 * env instead: an agent pinned to its own `CODEX_HOME` or `CLAUDE_CONFIG_DIR`
 * resumed against the global profile ("Session not found") and wrote new
 * rollouts there (#2088).
 *
 * The host owns that record, so the host puts it back before the spawn
 * handler runs, the same value a desktop spawn sends (`session.customEnvVars`).
 * Values the client did send win over the saved ones: the browser cannot see
 * the saved values, so anything it sends is a deliberate choice.
 */

import type { StoredSession } from '../../stores/types';

type EnvRecord = Record<string, string>;

/**
 * The saved agents, read at call time. Required lazily (as bridgePathGuard
 * does) so loading the bridge does not pull the store modules in with it.
 */
function storedAgents(): StoredSession[] {
	const { getSessionsStore } =
		require('../../stores/getters') as typeof import('../../stores/getters');
	return getSessionsStore().get('sessions', []);
}

let savedAgents: () => readonly StoredSession[] = storedAgents;

/** Test seam. Pass null to restore the store-backed default. */
export function setRemoteSpawnSessionsProvider(
	provider: (() => readonly StoredSession[]) | null
): void {
	savedAgents = provider ?? storedAgents;
}

function isEnvRecord(value: unknown): value is EnvRecord {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The saved agent a process session id belongs to. Process ids are the agent
 * id plus a `-` suffix (`{agentId}-ai-{tabId}`, `{agentId}-batch-...`), so the
 * longest agent id that is the whole id or a `-` prefix of it is the owner.
 */
export function findSpawnOwner(
	processSessionId: string,
	sessions: readonly StoredSession[]
): StoredSession | undefined {
	let owner: StoredSession | undefined;
	for (const session of sessions) {
		const id = session?.id;
		if (typeof id !== 'string' || !id) continue;
		if (processSessionId !== id && !processSessionId.startsWith(`${id}-`)) continue;
		if (!owner || id.length > owner.id.length) owner = session;
	}
	return owner;
}

/**
 * Return `config` with the owning agent's saved `customEnvVars` layered under
 * any `sessionCustomEnvVars` the client sent. Returns `config` unchanged when
 * the spawn has no saved owner or the owner has no env vars of its own.
 */
export function withHostAgentEnv<T extends Record<string, unknown>>(
	config: T,
	sessions: readonly StoredSession[] = savedAgents()
): T & { sessionCustomEnvVars?: EnvRecord } {
	const processSessionId = config.sessionId;
	if (typeof processSessionId !== 'string' || !processSessionId) return config;
	const saved = findSpawnOwner(processSessionId, sessions)?.customEnvVars;
	if (!isEnvRecord(saved) || Object.keys(saved).length === 0) return config;
	const sent = isEnvRecord(config.sessionCustomEnvVars) ? config.sessionCustomEnvVars : {};
	return { ...config, sessionCustomEnvVars: { ...saved, ...sent } };
}
