/**
 * Per-turn latency, broken down by hop.
 *
 * "Voice feels slow" is the report this file exists to answer. Without a
 * breakdown it is unanswerable: the same sentence covers a whisper decode on a
 * cold CPU, a rate-limited API retrying twice, a local Brain reloading a model it
 * unloaded four minutes ago, and a TTS provider that will not start speaking
 * until it has synthesised the whole reply. Those have nothing in common except
 * the symptom, and guessing between them wastes an afternoon.
 *
 * So every turn records the same six spans, stamped against the provider
 * configuration that produced them, and the last one is readable from a
 * developer panel. A report becomes "first partial took 2.4 s on whisper-local"
 * rather than a feeling.
 *
 * Timings are formatted with `formatDuration()` from
 * `src/shared/performance-metrics.ts`. There is no second duration helper in
 * here, deliberately: this codebase already had a dozen and they had drifted.
 */

import { formatDuration } from '../../../shared/performance-metrics';
import type { VoicePipelineShape, VoiceProviderRole } from '../../../shared/acappella/providers';

/** How many turns are kept. Enough to see a pattern, small enough to be free. */
const HISTORY_LIMIT = 20;

/**
 * The hops of one turn, in the order they happen.
 *
 * Named for what the USER experiences at each boundary, not for the function
 * that runs there: `speech-end to first partial` is the gap where a person is
 * looking at a screen that has not reacted yet, and that is the number worth
 * arguing about.
 */
export const TURN_SPANS = [
	'firstPartial',
	'finalTranscript',
	'routeDecision',
	'agentFirstToken',
	'firstSpokenSentence',
	'total',
] as const;

export type TurnSpan = (typeof TURN_SPANS)[number];

export const TURN_SPAN_LABELS: Record<TurnSpan, string> = {
	firstPartial: 'Speech end to first partial',
	finalTranscript: 'Final transcript',
	routeDecision: 'Route decision',
	agentFirstToken: 'Agent first token',
	firstSpokenSentence: 'First spoken sentence',
	total: 'Total turn',
};

/** The provider trio a turn ran on, so timings can be compared across configs. */
export interface TurnConfiguration {
	pipeline: VoicePipelineShape;
	providerIds: Record<VoiceProviderRole, string>;
}

export interface TurnMetrics {
	turnId: string;
	startedAt: number;
	configuration: TurnConfiguration;
	/**
	 * Milliseconds from the START of the turn to each milestone. Absent when the
	 * milestone never happened, which is itself information: a turn with a route
	 * decision and no spoken sentence failed somewhere specific.
	 */
	spans: Partial<Record<TurnSpan, number>>;
}

/** One finished turn, with the per-hop deltas a person actually reads. */
export interface TurnBreakdown extends TurnMetrics {
	/** Time spent IN each hop, rather than time since the turn began. */
	deltas: Array<{ span: TurnSpan; label: string; ms: number; formatted: string }>;
}

/**
 * Records one turn.
 *
 * A class per turn rather than a global with a "current turn" pointer, because
 * turns overlap: a superseded turn's provider callbacks keep arriving after the
 * user has moved on, and a shared mutable current-turn would attribute the old
 * turn's late transcript to the new turn's timeline.
 */
export class TurnTimer {
	private readonly spans: Partial<Record<TurnSpan, number>> = {};

	constructor(
		readonly turnId: string,
		readonly configuration: TurnConfiguration,
		private readonly now: () => number = Date.now,
		readonly startedAt: number = now()
	) {}

	/**
	 * Stamp a milestone. The FIRST stamp for a span wins: a second partial is not
	 * the first partial, and overwriting would quietly turn this into a
	 * most-recent-event log.
	 */
	mark(span: TurnSpan): void {
		if (this.spans[span] !== undefined) return;
		this.spans[span] = this.now() - this.startedAt;
	}

	/** Close the turn and produce its record. */
	finish(): TurnMetrics {
		this.mark('total');
		return {
			turnId: this.turnId,
			startedAt: this.startedAt,
			configuration: this.configuration,
			spans: { ...this.spans },
		};
	}
}

/**
 * The rolling window of finished turns.
 *
 * Module state rather than an injected store: there is one voice session at a
 * time by construction (a single floor), and a developer panel asking "what did
 * the last turn do" must not have to be threaded through the session service to
 * get an answer.
 */
const history: TurnMetrics[] = [];

export function recordTurn(metrics: TurnMetrics): void {
	history.push(metrics);
	if (history.length > HISTORY_LIMIT) history.shift();
}

export function lastTurn(): TurnBreakdown | null {
	const metrics = history[history.length - 1];
	return metrics ? describeTurn(metrics) : null;
}

/** Every retained turn, oldest first. */
export function turnHistory(): TurnBreakdown[] {
	return history.map(describeTurn);
}

export function resetTurnMetrics(): void {
	history.length = 0;
}

/**
 * Turn cumulative marks into per-hop durations.
 *
 * The cumulative form is what gets recorded (each mark is one subtraction at the
 * moment it happens, which is all a hot path should do); the per-hop form is what
 * a person reads, because "the route decision took 1.9 s" is actionable and "the
 * route decision landed 2.4 s in" is arithmetic homework.
 */
export function describeTurn(metrics: TurnMetrics): TurnBreakdown {
	const deltas: TurnBreakdown['deltas'] = [];
	let previous = 0;

	for (const span of TURN_SPANS) {
		const at = metrics.spans[span];
		if (at === undefined) continue;
		const ms = Math.max(0, at - previous);
		previous = at;
		deltas.push({
			span,
			label: TURN_SPAN_LABELS[span],
			// `total` is the whole turn, not the gap after the last milestone: it is
			// the one span a reader expects to equal the sum of the others.
			ms: span === 'total' ? at : ms,
			formatted: formatDuration(span === 'total' ? at : ms),
		});
	}

	return { ...metrics, deltas };
}

/** One line per hop, for a log or a support bundle. */
export function formatTurnBreakdown(breakdown: TurnBreakdown): string {
	const config = `${breakdown.configuration.pipeline}: ${breakdown.configuration.providerIds.stt} / ${breakdown.configuration.providerIds.brain} / ${breakdown.configuration.providerIds.tts}`;
	const lines = breakdown.deltas.map((delta) => `  ${delta.label}: ${delta.formatted}`);
	return [config, ...lines].join('\n');
}
