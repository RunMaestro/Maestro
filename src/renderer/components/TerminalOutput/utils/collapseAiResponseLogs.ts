import type { LogEntry } from '../../../types';
import { isSelfContainedCard } from '../../../utils/logEntries';

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
 *   - self-contained cards (`isSelfContainedCard`): `!` command output, Agent
 *     Resilience outage markers, recovery prompts, tool-call cards. Each owns
 *     its own body and must not fold into a text group,
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
			// Same trap for the model/effort pills: only streamed agent output
			// carries the turn's codified settings, so a group led by a system
			// banner would lose them if the combined entry took `[0]` alone.
			const turnModel = currentResponseGroup.find((l) => l.turnModel)?.turnModel;
			const turnEffort = currentResponseGroup.find((l) => l.turnEffort)?.turnEffort;
			result.push({
				...currentResponseGroup[0],
				text: combinedText,
				// Keep the first entry's timestamp and id.
				...(hasTextStream ? { renderStyle: 'text-stream' as const } : {}),
				...(turnModel ? { turnModel } : {}),
				...(turnEffort ? { turnEffort } : {}),
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
			isSelfContainedCard(log)
		) {
			// Flush the response group, then keep tool/thinking/error entries and any
			// self-contained card as their own entries.
			//
			// A card MUST NOT be merged into a text group. Grouping concatenates
			// `text` and renders the result with the FIRST entry's props, so a card
			// swallowed by a group loses its marker (`shellCommand`, `retryOutageId`,
			// ...) and its body gets pasted onto the preceding agent reply as plain
			// markdown - which is how `!ls` output ended up inside a chat bubble with
			// its ANSI codes showing as literal text. An error entry must not merge
			// either, or it gets silently concatenated (no separator) into a later,
			// unrelated AI response.
			//
			// This used to name `retryOutageId` alone; every new card kind hit the
			// same bug until it was added here too. isSelfContainedCard is the shared
			// rule (see utils/logEntries.ts), so new kinds are standalone by
			// construction.
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
