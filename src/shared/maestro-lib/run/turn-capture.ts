// src/shared/maestro-lib/run/turn-capture.ts

import type { AgentError, UsageStats } from '../../types';
import type { AgentOutputParser, ParsedEvent } from '../parsers/agent-output-parser';
import { UsageAccumulator } from '../streaming/usage-accumulator';
import { addUsageStats, parsedUsageToStats, replaceUsageStats } from '../streaming/usage-totals';

/**
 * How a provider reports usage on the wire, which decides how its usage events
 * combine into one turn's total.
 *
 * Named per provider rather than read off `usesCombinedContextWindow`: that
 * flag says how the context GAUGE adds input and output, and copilot-cli sets
 * it while emitting per-step values, so gating on it under-reported Copilot.
 */
export type UsageReporting =
	/** A running session total on every event (Codex): turn totals into deltas, then sum. */
	| 'running-total'
	/** The terminal result carries the whole turn (Claude Code): the last event wins. */
	| 'turn-total'
	/** Per-step values (everyone else): sum them. */
	| 'per-step';

export function usageReportingFor(agentId: string): UsageReporting {
	if (agentId === 'codex') return 'running-total';
	if (agentId === 'claude-code') return 'turn-total';
	return 'per-step';
}

export interface TurnCaptureOptions {
	/**
	 * Run the provider's classifier over every event to fill `inBandError`. On
	 * by default. A caller that settles its turns on `errorText` alone turns it
	 * off, so its outcomes stay exactly what they were.
	 */
	classifyInBandErrors?: boolean;
}

/**
 * What one turn's parsed events add up to: the session id, the answer, the
 * usage, and whether the provider said it was done.
 *
 * Feed it every event from `startTurn`'s `onEvent`. It keeps no process state
 * and makes no judgement about success; `resolveTurnOutcome` does that from
 * these values plus how the process exited.
 */
export class TurnCapture {
	/** The first session id the provider announced. */
	sessionId: string | undefined;
	/** The provider sent its terminal result event, whether or not it carried text. */
	resultMessageSeen = false;
	usage: UsageStats | undefined;
	/** The text of the first `error` event, if any. */
	errorText: string | undefined;
	/**
	 * The first failure the provider reported in its own stream. Several
	 * providers report a failed turn in-band and then exit 0, so the exit code
	 * alone reads those turns as a success.
	 */
	inBandError: AgentError | undefined;

	private result: string | undefined;
	private streamedText = '';
	private readonly usageReporting: UsageReporting;
	private readonly usageAccumulator: UsageAccumulator | undefined;

	private readonly classifiesInBandErrors: boolean;

	constructor(
		agentId: string,
		private readonly parser: AgentOutputParser,
		options: TurnCaptureOptions = {}
	) {
		this.classifiesInBandErrors = options.classifyInBandErrors !== false;
		this.usageReporting = usageReportingFor(agentId);
		this.usageAccumulator =
			this.usageReporting === 'running-total'
				? new UsageAccumulator({ attachesAbsoluteUsage: true })
				: undefined;
	}

	handleEvent(event: ParsedEvent): void {
		// Through the parser, not only on init events: some providers announce
		// the id only on their final event. The first id wins for providers that
		// repeat it on several event types.
		if (!this.sessionId) {
			const extracted = this.parser.extractSessionId(event);
			if (extracted) this.sessionId = extracted;
		}

		// An in-turn API error notice is skipped: the provider may retry past
		// it, and when it does not, the failed result that ends the turn is
		// caught instead.
		if (this.classifiesInBandErrors && !this.inBandError) {
			const raw = event.raw ?? event;
			if (!this.parser.isProvisionalErrorNotice?.(raw)) {
				this.inBandError = this.parser.detectErrorFromParsed(raw) ?? undefined;
			}
		}

		if (event.type === 'result') {
			this.resultMessageSeen = true;
			if (event.text) this.result = this.result ? `${this.result}\n${event.text}` : event.text;
		}

		// Partial text is the fallback answer for a provider whose terminal event
		// carries none. Deltas are token-sized with their whitespace embedded, so
		// they are concatenated as they are. Reasoning is not part of the answer.
		if (event.type === 'text' && event.isPartial && !event.isReasoning && event.text) {
			this.streamedText += event.text;
		}

		if (event.type === 'error' && event.text && !this.errorText) {
			this.errorText = event.text;
		}

		const usage = this.parser.extractUsage(event);
		if (usage) this.addUsage(parsedUsageToStats(usage));
	}

	/** The answer: the result event's text, else what was streamed. */
	get answerText(): string | undefined {
		return this.result || this.streamedText || undefined;
	}

	private addUsage(reported: UsageStats): void {
		// Both keep the window's resolved flag, its model and the occupancy
		// snapshot a provider reported, so a later event without them does not
		// erase them (#1669).
		if (this.usageReporting === 'turn-total') {
			this.usage = replaceUsageStats(this.usage, reported);
			return;
		}
		const step = this.usageAccumulator ? this.usageAccumulator.normalize(reported) : reported;
		this.usage = addUsageStats(this.usage, step);
	}
}
