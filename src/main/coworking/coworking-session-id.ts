/**
 * Maps a ProcessManager spawn `sessionId` to the *owning Maestro session id*
 * - the bare left-bar agent's `Session.id` that the renderer uses as the key
 * when it pushes terminal records into the coworking registry via
 * `coworking:syncSessionTerminals`.
 *
 * ProcessManager spawns AI tabs with composite ids like:
 *   - `{maestroSessionId}-ai-{tabId}`
 *   - `{maestroSessionId}-ai-{tabId}-fp-{timestamp}` (forced-parallel)
 *   - `{maestroSessionId}-ai` (legacy; some older code paths)
 *
 * If we inject the composite into the agent CLI's env, the MCP subprocess
 * announces that composite at handshake, and the bridge looks it up against
 * the registry where records are keyed by the bare id - they never match,
 * which is what caused PR #948's "list_terminals returns nothing" regression
 * after the privacy fix landed.
 *
 * For non-AI spawn flavors (synopsis-, batch-, group-chat-…) the agent
 * doesn't have terminals visible to the user, so passing the composite
 * through unchanged is fine - the registry won't have records under it
 * and `list_terminals` returns []. We only need to unwrap the AI-tab case.
 */

const REGEX_AI_TAB = /^(.+)-ai-(.+?)(?:-fp-\d+)?$/;
const AI_LEGACY_SUFFIX = '-ai';

/** An AI-tab spawn id, split into the owning agent and its tab. */
export interface ParsedAiTabSpawnId {
	maestroSessionId: string;
	tabId: string;
	/** True for a forced-parallel spawn (`…-fp-{timestamp}`). */
	forcedParallel: boolean;
}

/**
 * Split an AI-tab spawn id, or return `null` for any other spawn flavor
 * (synopsis-, batch-, group-chat-, bare terminal ids, legacy `{id}-ai`).
 *
 * This is the main-process counterpart of the renderer's `parseSessionId`, and
 * the two must agree: a caller that acts on one side of the IPC boundary and is
 * resolved on the other (TTSR aborts in main, respawns in the renderer) breaks
 * silently when they disagree about what an AI-tab id looks like.
 */
export function parseAiTabSpawnId(spawnSessionId: string): ParsedAiTabSpawnId | null {
	const m = spawnSessionId.match(REGEX_AI_TAB);
	if (!m) return null;
	return {
		maestroSessionId: m[1],
		tabId: m[2],
		forcedParallel: /-fp-\d+$/.test(spawnSessionId),
	};
}

export function resolveOwningMaestroSessionId(spawnSessionId: string): string {
	const parsed = parseAiTabSpawnId(spawnSessionId);
	if (parsed) return parsed.maestroSessionId;
	if (spawnSessionId.endsWith(AI_LEGACY_SUFFIX)) {
		return spawnSessionId.slice(0, -AI_LEGACY_SUFFIX.length);
	}
	return spawnSessionId;
}
