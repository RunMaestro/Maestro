import type { LogEntry } from '../../../types';

export const isHiddenProgressEntry = (log: LogEntry): boolean =>
	log.source === 'system' && log.id.startsWith('hidden-progress:');

/**
 * Collapse a tab's logs into render groups for the AI transcript.
 *
 * Consecutive LOCAL response entries (the active agent's own stdout/ai/system
 * output for one turn) fold into ONE bubble per user message, so a turn made of
 * several streamed entries reads as a single reply. These kinds stay standalone:
 *   - `user` messages,
 *   - `tool` / `thinking` entries,
 *   - Agent Resilience outage markers (`retryOutageId`), which render as a live
 *     status card and must not fold into a text group,
 *   - cross-agent (`@mention`) replies. Each cross-agent reply already streams
 *     into its own single entry and carries its own attribution header, so it
 *     must never fold into the local response group OR into a sibling
 *     cross-agent reply. Without this, several agents' answers (plus the local
 *     one) merge into a single bubble that inherits the FIRST entry's provenance
 *     - e.g. two remote replies and the local one all rendering inside one
 *     agent's error bubble.
 *
 * Pure + exported so the grouping is unit-testable independent of the component.
 */
export function collapseAiResponseLogs(logs: LogEntry[]): LogEntry[] {
	const result: LogEntry[] = [];
	let currentResponseGroup: LogEntry[] = [];

	// Flush the accumulated LOCAL response group into one combined entry.
	const flushResponseGroup = () => {
		if (currentResponseGroup.length > 0) {
			const combinedText = currentResponseGroup.map((l) => l.text).join('');
			// The token-source pill keys off `renderStyle === 'text-stream'`
			// (maestro-p TUI capture). A response group can lead with a non-stream
			// entry (e.g. the "Adaptive Mode: switched ..." system banner), and
			// basing the combined entry only on `[0]` would inherit that entry's
			// missing renderStyle and mislabel an interactive turn as "API".
			// Preserve text-stream if ANY grouped entry carries it.
			const hasTextStream = currentResponseGroup.some((l) => l.renderStyle === 'text-stream');
			result.push({
				...currentResponseGroup[0],
				text: combinedText,
				// Keep the first entry's timestamp and id.
				...(hasTextStream ? { renderStyle: 'text-stream' as const } : {}),
			});
			currentResponseGroup = [];
		}
	};

	for (const log of logs) {
		if (log.source === 'user') {
			flushResponseGroup();
			result.push(log);
		} else if (
			log.source === 'tool' ||
			log.source === 'thinking' ||
			log.source === 'error' ||
			log.retryOutageId
		) {
			// Flush the response group, then keep tool/thinking/error entries and Agent
			// Resilience outage markers as their own entries. The outage marker must not
			// merge into a text group - it renders as a live status card. An error entry
			// must not either, or it gets silently concatenated (no separator) into a
			// later, unrelated AI response.
			flushResponseGroup();
			result.push(log);
		} else if (log.metadata?.crossAgent) {
			// Standalone, individually-attributed bubble (see fn doc).
			flushResponseGroup();
			result.push(log);
		} else {
			// Accumulate the local agent's own response entries.
			currentResponseGroup.push(log);
		}
	}

	flushResponseGroup();
	return result;
}
