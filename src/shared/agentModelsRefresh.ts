/**
 * The "an agent's model list was re-read" event.
 *
 * Model discovery is cached in the main process, but every surface that offers
 * a model (the composer pill, the Model & Effort console, the queued-message
 * editor) holds its OWN copy of the list, fetched once when it mounted. A
 * forced refresh from one place (Settings -> Agents, the dropdown's refresh
 * button, `maestro-cli models --refresh`) updated the main cache and nothing
 * else, so a model just pulled into Ollama stayed missing from a picker that
 * was already on screen - including the one on a brand-new tab, because the
 * composer does not remount per tab.
 *
 * So every forced discovery broadcasts the fresh list on this channel, and
 * every mounted list adopts it. The payload carries the list itself rather
 * than a "go re-fetch" nudge, so N open pickers cost zero extra discoveries.
 */

export const MODELS_REFRESHED_CHANNEL = 'agents:modelsRefreshed';

export interface ModelsRefreshedPayload {
	/** Provider id (`opencode`, `claude-code`, ...), not an agent instance. */
	agentId: string;
	/** Host the list was discovered on; null for this machine. */
	sshRemoteId: string | null;
	models: string[];
}

/** How a refresh changed the list, for the confirmation shown to the user. */
export interface ModelsRefreshSummary {
	total: number;
	added: string[];
	removed: string[];
}

export function summarizeModelsRefresh(previous: string[], next: string[]): ModelsRefreshSummary {
	const before = new Set(previous);
	const after = new Set(next);
	return {
		total: next.filter((m) => m !== '').length,
		added: next.filter((m) => m !== '' && !before.has(m)),
		removed: previous.filter((m) => m !== '' && !after.has(m)),
	};
}

/** One line describing a refresh result, e.g. "14 models, 2 new". */
export function describeModelsRefresh(summary: ModelsRefreshSummary): string {
	const parts = [`${summary.total} ${summary.total === 1 ? 'model' : 'models'}`];
	if (summary.added.length > 0) parts.push(`${summary.added.length} new`);
	if (summary.removed.length > 0) parts.push(`${summary.removed.length} gone`);
	return parts.join(', ');
}
