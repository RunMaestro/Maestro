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

export function resolveOwningMaestroSessionId(spawnSessionId: string): string {
	const m = spawnSessionId.match(REGEX_AI_TAB);
	if (m) return m[1];
	if (spawnSessionId.endsWith(AI_LEGACY_SUFFIX)) {
		return spawnSessionId.slice(0, -AI_LEGACY_SUFFIX.length);
	}
	return spawnSessionId;
}
