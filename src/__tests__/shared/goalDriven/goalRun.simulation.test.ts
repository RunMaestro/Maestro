/**
 * Narrative simulation tying the marker parser and exit evaluator together -
 * the runnable "it works" demo for the Goal-Driven core engine.
 *
 * Each scenario scripts a sequence of fake agent responses (with embedded
 * `<!-- maestro:... -->` markers), then runs the same control loop a real
 * engine would: parse the response, append a history record, evaluate the exit
 * decision, and stop on the first `stop`. A lightweight ASCII progress bar is
 * logged per iteration so running the suite visibly shows the loop climbing.
 *
 * @file src/shared/goalDriven/goalMarkers.ts + goalExitEvaluator.ts
 */

import { describe, it, expect } from 'vitest';
import { parseGoalMarkers } from '../../../shared/goalDriven/goalMarkers';
import { evaluateGoalExit } from '../../../shared/goalDriven/goalExitEvaluator';
import type {
	GoalExitDecision,
	GoalIterationRecord,
	GoalRunConfig,
} from '../../../shared/goalDriven/types';

const CONFIG: GoalRunConfig = {
	goal: 'Demonstrate the goal-driven control loop',
	exitCriteria: 'Self-reported 100%, or a deadlock, or no progress for several iterations.',
	maxIterations: 20,
};

/** Render a 10-cell ASCII progress bar, e.g. `█████░░░░░`. */
function renderBar(progress: number, width = 10): string {
	const filled = Math.max(0, Math.min(width, Math.round((progress / 100) * width)));
	return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/**
 * Convert one iteration's parsed markers into a history record - the same
 * normalization a real engine would perform: a missing progress report carries
 * the previous value forward, and a deadlock reason is folded into `rationale`
 * (the record's only free-text field) so the evaluator can surface it.
 */
function buildRecord(
	markers: ReturnType<typeof parseGoalMarkers>,
	iteration: number,
	prevProgress: number
): GoalIterationRecord {
	const progress = markers.progress ?? prevProgress;
	return {
		iteration,
		progress,
		rationale: markers.rationale,
		complete: markers.complete,
		deadlock: markers.deadlock,
		deadlockReason: markers.deadlockReason,
	};
}

interface ScenarioResult {
	history: GoalIterationRecord[];
	decision: GoalExitDecision;
	/** Index of the last response consumed before the loop stopped. */
	lastResponseIndex: number;
}

/** Drive the full parse -> record -> evaluate control loop over scripted responses. */
function runScenario(label: string, responses: string[]): ScenarioResult {
	const history: GoalIterationRecord[] = [];
	let prevProgress = 0;
	let decision: GoalExitDecision = { action: 'continue' };
	let lastResponseIndex = -1;

	// eslint-disable-next-line no-console
	console.log(`\n=== Goal run: ${label} ===`);
	for (let i = 0; i < responses.length; i++) {
		const markers = parseGoalMarkers(responses[i]);
		const record = buildRecord(markers, i + 1, prevProgress);
		history.push(record);
		prevProgress = record.progress;
		lastResponseIndex = i;

		const note = record.deadlock
			? `DEADLOCK - ${record.rationale ?? 'no reason given'}`
			: (record.rationale ?? '(no rationale)');
		// eslint-disable-next-line no-console
		console.log(
			`  iter ${record.iteration}: [${renderBar(record.progress)}] ${record.progress}% - ${note}`
		);

		decision = evaluateGoalExit(history, CONFIG);
		if (decision.action === 'stop') {
			// eslint-disable-next-line no-console
			console.log(`  -> STOP (${decision.reason}): ${decision.detail}`);
			break;
		}
	}

	return { history, decision, lastResponseIndex };
}

describe('goal-driven run simulation', () => {
	it('climbs 0 -> 45 -> 70 -> 100 and stops with reason completed', () => {
		const responses = [
			'Kicked things off; scaffolding in place.\n<!-- maestro:progress 0 | project scaffolded -->',
			'Refactored the auth module and wired up the routes.\n<!-- maestro:progress 45 | refactored auth module -->',
			'Migrated the data layer and added tests.\n<!-- maestro:progress 70 | data layer migrated -->',
			'Everything builds and all tests pass.\n<!-- maestro:progress 100 | feature complete -->\n<!-- maestro:goal-complete -->',
		];

		const { history, decision, lastResponseIndex } = runScenario('happy path', responses);

		// The loop must have consumed every response up to the 100% one.
		expect(lastResponseIndex).toBe(responses.length - 1);
		expect(history).toHaveLength(4);
		expect(history.map((r) => r.progress)).toEqual([0, 45, 70, 100]);

		expect(decision.action).toBe('stop');
		if (decision.action === 'stop') {
			expect(decision.reason).toBe('completed');
		}
	});

	it('stalls when progress holds flat at 50 -> 50 -> 50', () => {
		const responses = [
			'Got the first pass working.\n<!-- maestro:progress 50 | first pass done -->',
			'Tried a different approach, no net change.\n<!-- maestro:progress 50 | still 50 -->',
			'Still blocked on the same issue.\n<!-- maestro:progress 50 | no movement -->',
			// This response would continue, but the loop should already have stopped.
			'<!-- maestro:progress 55 | should not be reached -->',
		];

		const { history, decision, lastResponseIndex } = runScenario('stall', responses);

		// Should stop at the third (index 2) flat iteration, never reaching the 4th.
		expect(lastResponseIndex).toBe(2);
		expect(history).toHaveLength(3);

		expect(decision.action).toBe('stop');
		if (decision.action === 'stop') {
			expect(decision.reason).toBe('stalled');
		}
	});

	it('stops with reason deadlock when the agent declares one', () => {
		const responses = [
			'Made initial headway.\n<!-- maestro:progress 30 | initial headway -->',
			'Pushed a bit further.\n<!-- maestro:progress 55 | more done -->',
			'Cannot proceed - the upstream service has no documented contract.\n' +
				'<!-- maestro:deadlock: upstream service contract is undocumented -->',
		];

		const { history, decision, lastResponseIndex } = runScenario('deadlock', responses);

		expect(lastResponseIndex).toBe(2);
		expect(history).toHaveLength(3);

		expect(decision.action).toBe('stop');
		if (decision.action === 'stop') {
			expect(decision.reason).toBe('deadlock');
			expect(decision.detail).toContain('undocumented');
		}
	});
});
