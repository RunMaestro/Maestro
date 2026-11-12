/**
 * Shared Grok helpers for wizard surfaces (inline wizard, onboarding
 * conversationManager, document generation).
 *
 * Keeps discovery args and streaming-json text extraction in one place so CLI
 * schema / cap changes do not drift across the three call sites.
 */

/**
 * CLI flags for Grok wizard discovery spawns.
 *
 * Do NOT add `--permission-mode plan` here: discovery needs read/fetch
 * (package.json, GitHub URLs). Plan mode blocks those paths. Caps turns and
 * bans subagents so silent tool loops cannot freeze the UI (Grok emits no
 * tool events on streaming-json). `--always-approve` avoids headless
 * permission hangs. Residual: model can still write under cwd within the turn
 * budget (no verified tool allowlist on Grok CLI yet).
 */
export const GROK_WIZARD_DISCOVERY_ARGS: readonly string[] = [
	'--always-approve',
	'--max-turns',
	'8',
	'--no-subagents',
];

/** Extract the string payload from a Grok `{"type":"text","data":"..."}` delta. */
export function getGrokTextDelta(msg: unknown): string | null {
	if (!msg || typeof msg !== 'object') return null;
	const record = msg as { type?: unknown; data?: unknown };
	if (record.type === 'text' && typeof record.data === 'string' && record.data) {
		return record.data;
	}
	return null;
}

/**
 * Join Grok streaming-json text deltas from JSONL lines.
 * Skips thought/reasoning deltas; the `end` event has no result body.
 */
export function extractGrokTextFromJsonl(lines: string[]): string | null {
	const textParts: string[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const data = getGrokTextDelta(JSON.parse(line));
			if (data) textParts.push(data);
		} catch {
			// Ignore non-JSON lines
		}
	}
	return textParts.length > 0 ? textParts.join('') : null;
}
