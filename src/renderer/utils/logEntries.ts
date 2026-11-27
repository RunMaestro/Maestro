/**
 * LogEntry classification helpers.
 *
 * ## Why this exists
 *
 * A `LogEntry` is really two different things wearing one type:
 *
 *  - **A stream.** Plain `stdout` / `stderr` / `thinking` text that arrives in
 *    chunks. Consecutive chunks are coalesced into one entry so the transcript
 *    doesn't become one bubble per packet.
 *  - **A self-contained card.** A single entry that renders as its own widget -
 *    a `!` command's output, a retry-outage status card, a session-recovery
 *    prompt, a tool call. Its text is owned by whoever created it and is
 *    updated by log id, never by appending.
 *
 * Cards are marked by an extra field while keeping a natural `source` (a `!`
 * command's card is `source: 'stdout'` because its body genuinely is terminal
 * output). That means **source alone cannot tell you whether appending is
 * safe**, and every coalescing site that assumed it could has been a bug:
 * agent text got concatenated into a command card's terminal output because the
 * card was the newest `stdout` entry when the next chunk arrived.
 *
 * So the rule lives here, once, expressed positively. Adding a new card kind
 * means adding its marker to `isSelfContainedCard` and every coalescing site is
 * correct by construction - rather than each site growing its own exclusion.
 */

import { isClaudeLimitNotice } from '../../shared/agentErrorPatterns';
import type { LogEntry } from '../types';

/**
 * True when the entry is a self-contained card rather than an open stream.
 *
 * ADD NEW CARD MARKERS HERE. If a new `LogEntry` field means "this entry is a
 * widget with its own body", list it below, or streamed output will start
 * getting appended to it wherever coalescing happens.
 */
export function isSelfContainedCard(entry: LogEntry): boolean {
	return Boolean(
		// `!` command output card - text owned by services/shellCommand.ts
		entry.shellCommand ||
		// Agent Resilience outage card - driven by retryStore
		entry.retryOutageId ||
		// "Create new session from prior context" prompt
		entry.recoveryAction ||
		// Custom AI command chip on a user message
		entry.aiCommand ||
		// "Back from snooze" marker - text owned by utils/snoozeHelpers.ts
		entry.snoozeReturn ||
		// Agent-to-agent hand-off pill - owned by services/agentDelegation.ts
		entry.delegation ||
		// Automatic context compaction pill - owned by services/contextCompaction.ts
		entry.contextCompaction ||
		// Committed provider translation marker - never a stream or assistant response.
		entry.contextTranslation ||
		// Tool call card / hidden-progress placeholder
		entry.metadata?.hiddenProgress ||
		entry.metadata?.toolState ||
		// Claude's plan-limit banner. Unlike every other kind above, this one has
		// no marker field to key off: Claude forwards the banner as ordinary
		// assistant output on the `result` envelope, AFTER the synthetic
		// `assistant` message before it already raised the failure that started
		// the retry. So the transcript holds a plain `stdout` entry whose entire
		// body is the notice, sitting right under the outage card that says the
		// same thing.
		//
		// It is a standalone notice, never the head of a reply, and the answer the
		// retry eventually produces lands as the NEXT `stdout` entry - half an
		// hour later, but still the next one in the same response group. Without
		// this the transcript renders that answer with "You've hit your session
		// limit - resets ..." glued to its front. Recognizing the text rather than
		// a marker also fixes transcripts already on disk.
		//
		// Anchored and length-capped by isClaudeLimitNotice, so an agent
		// *discussing* limits (which Maestro's own agents do constantly) carries
		// surrounding prose and does not match.
		isClaudeLimitNotice(entry.text)
	);
}

/**
 * The failure an Agent Resilience outage recovered from, as `dropRecoveredOutageNotices`
 * needs to see it. Structural so `utils` does not import the retry store.
 */
export interface RecoveredOutageScope {
	outageId: string;
	/** The failing message the outage was retrying on. */
	lastMessage: string;
	/** Epoch ms the outage resolved. Output after this belongs to the resend. */
	resolvedAt: number;
}

/**
 * Remove the provider's own failure text for an outage that has RECOVERED.
 *
 * Claude forwards its plan-limit banner ("You've hit your weekly limit - resets
 * ...") as ordinary assistant output, after the error that opened the outage, so
 * it lands as a reply bubble UNDER the outage card. Once a resend gets through
 * (the reset passed, or the user switched accounts and pressed Try now) the card
 * turns green and says the quota is back, while the bottom-most bubble still
 * says it is gone. The card already records that the limit was hit, so the
 * banner is pure contradiction at that point.
 *
 * Scoped tightly so a real reply is never dropped: only plain `stdout` / `ai`
 * entries after the user message that triggered the outage and no later than
 * its resolution, whose whole body is either a Claude limit notice or the exact
 * failing message. Returns `logs` by reference when nothing matched.
 */
export function dropRecoveredOutageNotices(
	logs: LogEntry[],
	outage: RecoveredOutageScope
): LogEntry[] {
	const anchorIndex = logs.findIndex((l) => l.retryOutageId === outage.outageId);
	if (anchorIndex === -1) return logs;
	let triggerIndex = anchorIndex;
	while (triggerIndex >= 0 && logs[triggerIndex].source !== 'user') triggerIndex--;

	const failure = outage.lastMessage.trim();
	const isNotice = (entry: LogEntry, index: number): boolean => {
		if (index <= triggerIndex || entry.timestamp > outage.resolvedAt) return false;
		if (entry.source !== 'stdout' && entry.source !== 'ai') return false;
		if (entry.retryOutageId) return false;
		const text = entry.text.trim();
		return isClaudeLimitNotice(text) || (failure !== '' && text === failure);
	};

	if (!logs.some(isNotice)) return logs;
	return logs.filter((entry, index) => !isNotice(entry, index));
}

/**
 * True when `entry` is an open stream of `source` that new bytes may be
 * appended to.
 *
 * Callers still own their own *policy* on top of this (a time window, whether
 * the session is still busy); this answers only the model-level question of
 * whether appending is structurally valid.
 */
export function canAppendToLogEntry(
	entry: LogEntry | undefined,
	source: LogEntry['source']
): boolean {
	if (!entry) return false;
	if (entry.source !== source) return false;
	return !isSelfContainedCard(entry);
}

/**
 * True when `entry` is a steered user message that belongs to the turn it was
 * steered into, and so is drawn stitched to it (see SteeredMessageHeader).
 *
 * A `queued` steer does not: the agent could not fold it in and took it as a
 * turn of its own, so it is drawn as an ordinary message that says so. A steer
 * still waiting for its verdict counts, because the text is already in the turn.
 */
export function steerJoinsRunningTurn(entry: LogEntry | undefined): boolean {
	return Boolean(entry?.source === 'user' && entry.steered && entry.steerState !== 'queued');
}
