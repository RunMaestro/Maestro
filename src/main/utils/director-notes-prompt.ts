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
 *
 * The optional Ideal End State (see `shared/directorNotesEndState`) is folded in
 * here too: blank leaves the prompt untouched, set adds a reading-priority and
 * `progress`-section block between the base prompt and the manifest.
 */

import {
	buildIdealEndStateBlock,
	normalizeIdealEndState,
} from '../../shared/directorNotesEndState';

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
 * A merged corpus of runs performed by OTHER Maestro instances against the same
 * project (see `director-notes-shared-history.ts`). Materialized to a local
 * file by the caller, because the synopsis agent runs on this machine and
 * cannot open a path on the host that produced those runs.
 */
export interface DirectorNotesSharedHistoryFile {
	/** Absolute local path to the JSON file holding the entries. */
	filePath: string;
	/** Hostnames the entries came from. */
	hosts: string[];
	/** Entries inside the lookback window. */
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
	/**
	 * Optional Ideal End State from settings. Blank/absent leaves the prompt
	 * exactly as it was before the setting existed.
	 */
	idealEndState?: string;
	/**
	 * Optional cross-host corpus. Absent (the all-local case) leaves the prompt
	 * byte-for-byte what it was before shared history was folded in.
	 */
	sharedHistoryFile?: DirectorNotesSharedHistoryFile | null;
}): Promise<DirectorNotesSynopsisPromptResult> {
	const { historyManager, sessionNameMap, lookbackDays, basePrompt } = params;
	const sharedHistoryFile = params.sharedHistoryFile ?? null;
	const endState = normalizeIdealEndState(params.idealEndState);

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

	if (sessionManifest.length === 0 && !sharedHistoryFile) {
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
				})} - ${nowDate})`;

	// Every `''` below is a blank line in the assembled prompt; the end-state
	// sections collapse to nothing when no end state is configured, so the
	// prompt for an unset end state is byte-for-byte the pre-feature prompt.
	const endStateBlock = endState ? ['---', '', buildIdealEndStateBlock(endState), ''] : [];
	// The base prompt's output contract is its closing section, and the manifest
	// (plus any end-state block) now sits after it. Restate it last so the JSON
	// rule is still the final thing read - free-form user prose landing between
	// the contract and the response is exactly how a model talks itself into a
	// preamble.
	const endStateContractReminder = endState
		? [
				'',
				'---',
				'',
				'Reminder: the Ideal End State above is reference material. Your final',
				'message is still a single JSON object and nothing else, now carrying four',
				'sections: accomplishments, challenges, nextSteps, progress.',
			]
		: [];

	// Runs performed by another Maestro instance against the same project (an
	// agent living on the remote box, rather than one this machine drives over
	// SSH). They are one file of pre-merged entries, so they are listed apart
	// from the per-agent manifest and labeled with the hosts they came from.
	const sharedHistoryBlock = sharedHistoryFile
		? [
				'',
				'## Other Hosts',
				'',
				`Work done by Maestro on ${sharedHistoryFile.hosts.join(', ') || 'other hosts'} against`,
				'the same projects, merged into one file. Same entry shape as the files',
				'above; treat it as part of the same body of work.',
				'',
				`- ${sharedHistoryFile.entryCount} entries: ${sharedHistoryFile.filePath}`,
			]
		: [];

	const prompt = [
		basePrompt,
		'',
		...endStateBlock,
		'---',
		'',
		'## Session History Files',
		'',
		`Lookback period: ${windowLabel}`,
		`Timestamp cutoff: ${cutoffTime} (only consider entries with timestamp >= this value)`,
		`${agentCount} agents had ${entryCount} qualifying entries.`,
		'',
		manifestLines,
		...sharedHistoryBlock,
		...endStateContractReminder,
	].join('\n');

	return {
		prompt,
		agentCount,
		entryCount: entryCount + (sharedHistoryFile?.entryCount ?? 0),
	};
}
