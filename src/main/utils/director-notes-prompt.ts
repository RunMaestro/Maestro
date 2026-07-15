/**
 * Director's Notes synopsis prompt builder.
 *
 * Shared by the desktop IPC handler (`ipc/handlers/director-notes.ts`) and the
 * web/CLI command callback (`web-server/web-server-factory.ts`). Both previously
 * carried their own copy of this logic - and the same bug: they listed EVERY
 * history file in the manifest and only applied the lookback window to the stat
 * counters. With a large history corpus (e.g. 160+ files / tens of MB) the
 * batch grooming agent burned its entire timeout reading multi-MB JSON files
 * that were out of range, never emitting synopsis text - surfacing to the user
 * as "Grooming timed out with no response".
 *
 * The manifest is now scoped to sessions that actually have at least one entry
 * inside the lookback window, so the agent only opens files it needs.
 */

/** lookbackDays <= 0 means "all time" (no timestamp cutoff). */
const LOOKBACK_ALL_TIME = 0;

/** Minimal history source surface needed to build the manifest. */
export interface DirectorNotesHistorySource {
	listSessionsWithHistory(): Promise<string[]>;
	getHistoryFilePath(sessionId: string): Promise<string | null>;
	getEntries(sessionId: string): Promise<Array<{ timestamp: number }>>;
}

export interface DirectorNotesSynopsisPromptResult {
	/** Fully assembled prompt, or '' when no sessions qualify for the window. */
	prompt: string;
	/** Number of agents (sessions) with entries inside the lookback window. */
	agentCount: number;
	/** Total entries inside the lookback window. */
	entryCount: number;
}

/**
 * Sanitize a session display name for safe embedding in AI prompts.
 * Strips markdown formatting characters and control sequences that could be
 * interpreted as prompt instructions by the AI agent.
 */
export function sanitizeDisplayName(name: string): string {
	return (
		name
			// Strip markdown headers, bold, italic, links, images
			.replace(/[#*_`~\[\]()!|>]/g, '')
			// Collapse multiple whitespace/newlines into single space
			.replace(/\s+/g, ' ')
			.trim()
	);
}

/**
 * Build the batch-grooming prompt for a Director's Notes synopsis.
 *
 * Returns the prompt plus the in-window agent/entry counts. When no session has
 * activity inside the lookback window, `prompt` is an empty string so callers
 * can short-circuit with their own "no history" response.
 */
export async function buildDirectorNotesSynopsisPrompt(params: {
	historyManager: DirectorNotesHistorySource;
	sessionNameMap: Map<string, string>;
	lookbackDays: number;
	/** The base `director-notes` system prompt text. */
	basePrompt: string;
}): Promise<DirectorNotesSynopsisPromptResult> {
	const { historyManager, sessionNameMap, lookbackDays, basePrompt } = params;

	const cutoffTime =
		lookbackDays > LOOKBACK_ALL_TIME ? Date.now() - lookbackDays * 24 * 60 * 60 * 1000 : 0;

	const sessionIds = await historyManager.listSessionsWithHistory();

	const sessionManifest: Array<{
		sessionId: string;
		displayName: string;
		historyFilePath: string;
	}> = [];
	let agentCount = 0;
	let entryCount = 0;

	for (const sessionId of sessionIds) {
		const filePath = await historyManager.getHistoryFilePath(sessionId);
		if (!filePath) continue;

		const entries = await historyManager.getEntries(sessionId);
		let entriesInWindow = 0;
		for (const entry of entries) {
			if (entry.timestamp >= cutoffTime) entriesInWindow++;
		}

		// Only hand the agent files that have activity in the lookback window.
		// Listing the entire corpus forces it to open out-of-range multi-MB files
		// and exhausts the grooming timeout before it can synthesize anything.
		if (entriesInWindow === 0) continue;

		const displayName = sessionNameMap.get(sessionId) || sessionId;
		sessionManifest.push({ sessionId, displayName, historyFilePath: filePath });
		agentCount++;
		entryCount += entriesInWindow;
	}

	if (sessionManifest.length === 0) {
		return { prompt: '', agentCount: 0, entryCount: 0 };
	}

	const manifestLines = sessionManifest
		.map(
			(s) =>
				`- Session "${sanitizeDisplayName(s.displayName)}" (ID: ${s.sessionId}): ${s.historyFilePath}`
		)
		.join('\n');

	const nowDate = new Date().toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
	});
	const windowLabel =
		cutoffTime === 0
			? 'all time'
			: `${lookbackDays} days (${new Date(cutoffTime).toLocaleDateString('en-US', {
					month: 'short',
					day: 'numeric',
					year: 'numeric',
				})} – ${nowDate})`;

	const prompt = [
		basePrompt,
		'',
		'---',
		'',
		'## Session History Files',
		'',
		`Lookback period: ${windowLabel}`,
		`Timestamp cutoff: ${cutoffTime} (only consider entries with timestamp >= this value)`,
		`${agentCount} agents had ${entryCount} qualifying entries.`,
		'',
		manifestLines,
	].join('\n');

	return { prompt, agentCount, entryCount };
}
