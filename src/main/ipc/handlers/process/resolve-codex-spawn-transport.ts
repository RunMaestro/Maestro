import type Store from 'electron-store';
import { resolveCodexTransport, type CodexTransport } from '../../../../shared/codexTransport';
import type { SpawnProcessConfig } from './spawn-types';

type PersistedSessionRecord = {
	id?: string;
	toolType?: string;
	codexTransport?: unknown;
};

/**
 * Resolve the Codex transport for a desktop spawn turn.
 *
 * The persisted agent record is authoritative, the same way
 * `resolveClaudeSpawnContext` reads `maestroPMode`: a renderer holding a stale
 * copy of the agent must not route a turn differently from what is saved. When
 * a record exists its value wins outright, even when it is absent (= `exec`).
 * The inline `config.codexTransport` is only consulted when no record matches,
 * which is the case for spawns under a synthetic session id.
 *
 * `baseSessionId` is the bare agent id (the `-ai-{tabId}` suffix stripped),
 * since persisted records are keyed by it.
 */
export function resolveCodexSpawnTransport(
	config: Pick<SpawnProcessConfig, 'toolType' | 'codexTransport'>,
	baseSessionId: string,
	sessionsStore: Store<{ sessions: unknown[] }>
): CodexTransport {
	// Only a Codex turn has a transport to choose, so no other spawn pays for the lookup.
	if (config.toolType !== 'codex') return 'exec';
	const persisted = (sessionsStore.get('sessions', []) as PersistedSessionRecord[]).find(
		(s) => s?.id === baseSessionId
	);
	return resolveCodexTransport({
		toolType: config.toolType,
		codexTransport: persisted
			? !persisted.toolType || persisted.toolType === 'codex'
				? persisted.codexTransport
				: undefined
			: config.codexTransport,
	});
}
