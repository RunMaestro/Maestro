/**
 * @file turn-metrics.test.ts
 *
 * The instrumentation that answers "voice feels slow" with a hop instead of a
 * shrug. Two things worth pinning down: a milestone is stamped once (a second
 * partial is not the first partial), and the breakdown reports time spent IN each
 * hop rather than time since the turn began, because the first form is actionable
 * and the second is arithmetic homework.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
	TurnTimer,
	describeTurn,
	formatTurnBreakdown,
	lastTurn,
	recordTurn,
	resetTurnMetrics,
	turnHistory,
} from '../../../../main/acappella/telemetry/turn-metrics';

const CONFIG = {
	pipeline: 'cascade' as const,
	providerIds: { stt: 'whisper-local', tts: 'kokoro-local', brain: 'qwen3-local' },
};

/** A clock the test drives, so no span depends on how fast the machine is. */
function clock(): { now: () => number; advance: (ms: number) => void } {
	let time = 1_000;
	return {
		now: () => time,
		advance: (ms) => {
			time += ms;
		},
	};
}

beforeEach(() => {
	resetTurnMetrics();
});

describe('TurnTimer', () => {
	it('records every hop from the moment speech ended', () => {
		const time = clock();
		const timer = new TurnTimer('turn-1', CONFIG, time.now);

		time.advance(300);
		timer.mark('firstPartial');
		time.advance(200);
		timer.mark('finalTranscript');
		time.advance(400);
		timer.mark('routeDecision');
		time.advance(1_500);
		timer.mark('agentFirstToken');
		time.advance(250);
		timer.mark('firstSpokenSentence');

		const metrics = timer.finish();
		expect(metrics.spans).toEqual({
			firstPartial: 300,
			finalTranscript: 500,
			routeDecision: 900,
			agentFirstToken: 2_400,
			firstSpokenSentence: 2_650,
			total: 2_650,
		});
	});

	it('keeps the FIRST stamp for a span', () => {
		const time = clock();
		const timer = new TurnTimer('turn-1', CONFIG, time.now);

		timer.mark('firstPartial');
		time.advance(500);
		// A later partial is not the first one; overwriting would quietly turn this
		// into a most-recent-event log.
		timer.mark('firstPartial');

		expect(timer.finish().spans.firstPartial).toBe(0);
	});

	it('leaves a milestone that never happened absent', () => {
		const timer = new TurnTimer('turn-1', CONFIG, clock().now);
		timer.mark('finalTranscript');

		const metrics = timer.finish();
		// A turn with a transcript and no spoken sentence failed somewhere specific,
		// and the gap is the evidence.
		expect(metrics.spans.firstSpokenSentence).toBeUndefined();
	});
});

describe('describeTurn', () => {
	it('reports time spent in each hop, with the total as the whole turn', () => {
		const breakdown = describeTurn({
			turnId: 'turn-1',
			startedAt: 0,
			configuration: CONFIG,
			spans: { firstPartial: 300, finalTranscript: 500, total: 900 },
		});

		expect(breakdown.deltas.map((delta) => [delta.span, delta.ms])).toEqual([
			['firstPartial', 300],
			['finalTranscript', 200],
			['total', 900],
		]);
	});

	it('formats spans with the shared duration helper', () => {
		const breakdown = describeTurn({
			turnId: 'turn-1',
			startedAt: 0,
			configuration: CONFIG,
			spans: { firstPartial: 1_500, total: 1_500 },
		});

		expect(breakdown.deltas[0].formatted).toBe('1.50s');
	});
});

describe('the rolling history', () => {
	it('remembers the last turn and names the configuration it ran on', () => {
		recordTurn({ turnId: 'a', startedAt: 0, configuration: CONFIG, spans: { total: 100 } });
		recordTurn({ turnId: 'b', startedAt: 0, configuration: CONFIG, spans: { total: 200 } });

		expect(lastTurn()?.turnId).toBe('b');
		expect(turnHistory()).toHaveLength(2);
	});

	it('is empty before anything has been said', () => {
		expect(lastTurn()).toBeNull();
	});

	it('caps what it retains', () => {
		for (let index = 0; index < 50; index++) {
			recordTurn({
				turnId: `turn-${index}`,
				startedAt: 0,
				configuration: CONFIG,
				spans: { total: index },
			});
		}

		expect(turnHistory().length).toBeLessThanOrEqual(20);
		expect(lastTurn()?.turnId).toBe('turn-49');
	});

	it('formats a breakdown that names the providers it was measured on', () => {
		recordTurn({
			turnId: 'a',
			startedAt: 0,
			configuration: CONFIG,
			spans: { firstPartial: 300, total: 300 },
		});

		const text = formatTurnBreakdown(lastTurn()!);
		expect(text).toContain('whisper-local');
		expect(text).toContain('Speech end to first partial');
	});
});
