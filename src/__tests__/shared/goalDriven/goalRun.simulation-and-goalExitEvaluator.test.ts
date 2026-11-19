// Source: src/__tests__/shared/goalDriven/goalRun.simulation.test.ts
// Source: src/__tests__/shared/goalDriven/goalExitEvaluator.test.ts
// Source: src/__tests__/shared/goalDriven/goalMarkers.test.ts
// Source: src/__tests__/shared/goalDriven/goalRunLabel.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { parseGoalMarkers } from '../../../shared/goalDriven/goalMarkers';
import { evaluateGoalExit } from '../../../shared/goalDriven/goalExitEvaluator';
import type { GoalExitDecision } from '../../../shared/goalDriven/types';
import type { GoalIterationRecord } from '../../../shared/goalDriven/types';
import type { GoalRunConfig } from '../../../shared/goalDriven/types';
import { STALL_THRESHOLD } from '../../../shared/goalDriven/types';
import { stripMaestroMarkers } from '../../../shared/goalDriven/goalMarkers';
import { GOAL_RUN_DOCUMENT_PREFIX } from '../../../shared/goalDriven/goalRunLabel';
import { GOAL_RUN_LABEL_MAX_LENGTH } from '../../../shared/goalDriven/goalRunLabel';
import { formatGoalRunDocumentPath } from '../../../shared/goalDriven/goalRunLabel';
import { isGoalRunDocument } from '../../../shared/goalDriven/goalRunLabel';
import { goalRunLabel } from '../../../shared/goalDriven/goalRunLabel';
describeSourceSuite('goalRun.simulation', () => {
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
});
describeSourceSuite('goalExitEvaluator', () => {
	// Local factory keeps each record construction terse. `progress` accepts
	// `number | null` so we can exercise the evaluator's defensive missing-progress
	// handling; it is stored on the (number-typed) record field via assertion.
	function rec(
		iteration: number,
		progress: number | null,
		extra: Partial<GoalIterationRecord> = {}
	): GoalIterationRecord {
		return {
			iteration,
			progress: progress as number,
			rationale: null,
			complete: false,
			deadlock: false,
			deadlockReason: null,
			...extra,
		};
	}

	const config = (overrides: Partial<GoalRunConfig> = {}): GoalRunConfig => ({
		goal: 'Ship the feature',
		exitCriteria: 'All acceptance tests pass.',
		maxIterations: null,
		...overrides,
	});

	describe('evaluateGoalExit', () => {
		describe('empty / healthy histories', () => {
			it('continues when there is no history yet', () => {
				expect(evaluateGoalExit([], config())).toEqual({ action: 'continue' });
			});

			it('continues for a healthy climbing sequence (0 -> 30 -> 60)', () => {
				const history = [rec(1, 0), rec(2, 30), rec(3, 60)];
				expect(evaluateGoalExit(history, config())).toEqual({ action: 'continue' });
			});
		});

		describe('completion', () => {
			it('stops with reason completed when the latest record is complete', () => {
				const history = [rec(1, 60), rec(2, 100, { complete: true })];
				const decision = evaluateGoalExit(history, config());
				expect(decision).toEqual({
					action: 'stop',
					reason: 'completed',
					detail: expect.stringContaining('complete'),
				});
			});

			it('stops with reason completed when latest progress is exactly 100', () => {
				const history = [rec(1, 80), rec(2, 100)];
				const decision = evaluateGoalExit(history, config());
				expect(decision.action).toBe('stop');
				if (decision.action === 'stop') {
					expect(decision.reason).toBe('completed');
				}
			});

			it('completion beats max-iterations when both would trigger', () => {
				// 2 records and a cap of 2 -> max-iterations would fire, but the latest
				// record also completes, so completion must win.
				const history = [rec(1, 70), rec(2, 100, { complete: true })];
				const decision = evaluateGoalExit(history, config({ maxIterations: 2 }));
				expect(decision.action).toBe('stop');
				if (decision.action === 'stop') {
					expect(decision.reason).toBe('completed');
				}
			});
		});

		describe('deadlock', () => {
			it('stops with reason deadlock and propagates the reason into detail', () => {
				const history = [
					rec(1, 40),
					rec(2, 40, { deadlock: true, rationale: 'upstream API is undocumented' }),
				];
				const decision = evaluateGoalExit(history, config());
				expect(decision.action).toBe('stop');
				if (decision.action === 'stop') {
					expect(decision.reason).toBe('deadlock');
					expect(decision.detail).toContain('upstream API is undocumented');
				}
			});

			it('stops with reason deadlock even without a stated reason', () => {
				const history = [rec(1, 40), rec(2, 40, { deadlock: true })];
				const decision = evaluateGoalExit(history, config());
				expect(decision.action).toBe('stop');
				if (decision.action === 'stop') {
					expect(decision.reason).toBe('deadlock');
				}
			});

			it('prefers the deadlock-marker reason over the progress rationale', () => {
				// The agent put a throwaway note in its progress rationale but the real
				// blocker in the deadlock marker; the detail must surface the latter.
				const history = [
					rec(1, 40),
					rec(2, 40, {
						deadlock: true,
						rationale: 'still investigating',
						deadlockReason: 'no write access to the production database',
					}),
				];
				const decision = evaluateGoalExit(history, config());
				expect(decision.action).toBe('stop');
				if (decision.action === 'stop') {
					expect(decision.reason).toBe('deadlock');
					expect(decision.detail).toContain('no write access to the production database');
					expect(decision.detail).not.toContain('still investigating');
				}
			});

			it('deadlock beats max-iterations and stall', () => {
				// Flat 50/50/50 would stall, and the cap of 3 would also trigger, but
				// the latest record declares a deadlock which has higher priority.
				const history = [
					rec(1, 50),
					rec(2, 50),
					rec(3, 50, { deadlock: true, rationale: 'circular dependency' }),
				];
				const decision = evaluateGoalExit(history, config({ maxIterations: 3 }));
				expect(decision.action).toBe('stop');
				if (decision.action === 'stop') {
					expect(decision.reason).toBe('deadlock');
				}
			});
		});

		describe('max iterations', () => {
			it('stops with reason max-iterations when a finite cap is reached', () => {
				const history = [rec(1, 20), rec(2, 40), rec(3, 60)];
				const decision = evaluateGoalExit(history, config({ maxIterations: 3 }));
				expect(decision.action).toBe('stop');
				if (decision.action === 'stop') {
					expect(decision.reason).toBe('max-iterations');
					expect(decision.detail).toContain('3');
				}
			});

			it('continues when below a finite cap', () => {
				const history = [rec(1, 20), rec(2, 40)];
				expect(evaluateGoalExit(history, config({ maxIterations: 5 }))).toEqual({
					action: 'continue',
				});
			});

			it('never triggers max-iterations when the cap is null (infinite)', () => {
				const history = Array.from({ length: 50 }, (_, i) => rec(i + 1, Math.min(99, i * 5)));
				const decision = evaluateGoalExit(history, config({ maxIterations: null }));
				// 50 climbing-then-flat iterations: not completed, not deadlocked, no cap.
				// (May stall once it plateaus, but it must NOT be max-iterations.)
				if (decision.action === 'stop') {
					expect(decision.reason).not.toBe('max-iterations');
				}
			});
		});

		describe('stall detection', () => {
			it('stops with reason stalled after exactly STALL_THRESHOLD flat iterations', () => {
				const history = Array.from({ length: STALL_THRESHOLD }, (_, i) => rec(i + 1, 50));
				const decision = evaluateGoalExit(history, config());
				expect(decision.action).toBe('stop');
				if (decision.action === 'stop') {
					expect(decision.reason).toBe('stalled');
					expect(decision.detail).toContain('50%');
				}
			});

			it('stalls on a declining window as well as a flat one', () => {
				const history = [rec(1, 70), rec(2, 65), rec(3, 60)];
				const decision = evaluateGoalExit(history, config());
				expect(decision.action).toBe('stop');
				if (decision.action === 'stop') {
					expect(decision.reason).toBe('stalled');
				}
			});

			it('does not stall with fewer than STALL_THRESHOLD records', () => {
				const history = [rec(1, 50), rec(2, 50)];
				expect(evaluateGoalExit(history, config())).toEqual({ action: 'continue' });
			});

			it('resets the stall when there is an upward tick inside the window', () => {
				// Last 3 = [50, 50, 60] -> the final upward tick means not stalled.
				const history = [rec(1, 50), rec(2, 50), rec(3, 60)];
				expect(evaluateGoalExit(history, config())).toEqual({ action: 'continue' });
			});

			it('stalls only on the trailing window, ignoring earlier upward movement', () => {
				// Climbed 10 -> 40, then stuck at 40 for the last STALL_THRESHOLD records.
				const history = [rec(1, 10), rec(2, 40), rec(3, 40), rec(4, 40)];
				const decision = evaluateGoalExit(history, config());
				expect(decision.action).toBe('stop');
				if (decision.action === 'stop') {
					expect(decision.reason).toBe('stalled');
					expect(decision.detail).toContain('40%');
				}
			});

			it('treats missing-progress (null) iterations as no-progress for stall', () => {
				// Reached 50, then two silent iterations (no progress marker -> null).
				// Defensive normalization carries 50 forward, so the window is flat.
				const history = [rec(1, 50), rec(2, null), rec(3, null)];
				const decision = evaluateGoalExit(history, config());
				expect(decision.action).toBe('stop');
				if (decision.action === 'stop') {
					expect(decision.reason).toBe('stalled');
					expect(decision.detail).toContain('50%');
				}
			});
		});

		describe('priority ordering', () => {
			it('checks completion before deadlock before max-iterations before stall', () => {
				// A single record that simultaneously completes AND deadlocks AND hits a
				// cap of 1 -> completion wins.
				const history = [rec(1, 100, { complete: true, deadlock: true })];
				const decision = evaluateGoalExit(history, config({ maxIterations: 1 }));
				expect(decision.action).toBe('stop');
				if (decision.action === 'stop') {
					expect(decision.reason).toBe('completed');
				}
			});
		});
	});

	describe('evaluateGoalExit with delegated work outstanding', () => {
		it('does not end a run on "complete" while delegates are still working', () => {
			const history = [rec(1, 100, { complete: true })];
			expect(evaluateGoalExit(history, config(), { pendingDelegations: 2 })).toEqual({
				action: 'continue',
			});
		});

		it('completes once nothing delegated is still running', () => {
			const history = [rec(1, 100, { complete: true })];
			expect(evaluateGoalExit(history, config(), { pendingDelegations: 0 })).toMatchObject({
				action: 'stop',
				reason: 'completed',
			});
		});

		it('still honors the iteration cap when completion is deferred', () => {
			const history = [rec(1, 100, { complete: true })];
			expect(
				evaluateGoalExit(history, config({ maxIterations: 1 }), { pendingDelegations: 1 })
			).toMatchObject({ action: 'stop', reason: 'max-iterations' });
		});
	});
});
describeSourceSuite('goalMarkers', () => {
	describe('stripMaestroMarkers', () => {
		it('removes a progress marker and trims the dangling gap', () => {
			const text = 'Did the work.\n\n<!-- maestro:progress 30 | least-privilege walk done -->';
			expect(stripMaestroMarkers(text)).toBe('Did the work.');
		});

		it('removes every marker shape (progress, complete, deadlock, halt)', () => {
			const text = [
				'Summary line.',
				'<!-- maestro:progress 100 | shipped -->',
				'<!-- maestro:goal-complete -->',
				'<!-- maestro:deadlock: blocked -->',
				'<!-- maestro:halt: stop -->',
			].join('\n');
			expect(stripMaestroMarkers(text)).toBe('Summary line.');
		});

		it('removes two markers sharing one line individually', () => {
			const text = 'a <!-- maestro:progress 40 -->mid<!-- maestro:deadlock --> b';
			expect(stripMaestroMarkers(text)).toBe('a mid b');
		});

		it('collapses the blank lines a mid-document marker leaves behind', () => {
			const text = 'Before.\n\n<!-- maestro:progress 50 -->\n\nAfter.';
			expect(stripMaestroMarkers(text)).toBe('Before.\n\nAfter.');
		});

		it('leaves marker-free text untouched', () => {
			const text = 'Plain text with no markers.';
			expect(stripMaestroMarkers(text)).toBe(text);
		});

		it('is tolerant of whitespace-only marker bodies', () => {
			expect(stripMaestroMarkers('x <!--   maestro:progress   45   --> y')).toBe('x  y');
		});
	});

	describe('parseGoalMarkers', () => {
		describe('progress marker', () => {
			it('parses a well-formed progress marker with a rationale', () => {
				const result = parseGoalMarkers('<!-- maestro:progress 45 | refactored auth module -->');
				expect(result.progress).toBe(45);
				expect(result.rationale).toBe('refactored auth module');
				expect(result.complete).toBe(false);
				expect(result.deadlock).toBe(false);
				expect(result.deadlockReason).toBeNull();
			});

			it('parses a progress marker without a rationale (rationale is null)', () => {
				const result = parseGoalMarkers('<!-- maestro:progress 30 -->');
				expect(result.progress).toBe(30);
				expect(result.rationale).toBeNull();
			});

			it('treats a present-but-empty rationale as null', () => {
				const result = parseGoalMarkers('<!-- maestro:progress 30 |    -->');
				expect(result.progress).toBe(30);
				expect(result.rationale).toBeNull();
			});

			it('is tolerant of whitespace variations inside the comment', () => {
				expect(parseGoalMarkers('<!--maestro:progress 45-->').progress).toBe(45);
				expect(parseGoalMarkers('<!--   maestro:progress   45   -->').progress).toBe(45);
				expect(parseGoalMarkers('<!--\tmaestro:progress\t45\t-->').progress).toBe(45);
				// Trailing newlines / surrounding prose
				expect(parseGoalMarkers('done\n<!-- maestro:progress 45 -->\n').progress).toBe(45);
			});

			it('clamps values above 100 down to 100', () => {
				expect(parseGoalMarkers('<!-- maestro:progress 150 -->').progress).toBe(100);
			});

			it('clamps negative values up to 0', () => {
				expect(parseGoalMarkers('<!-- maestro:progress -20 -->').progress).toBe(0);
			});

			it('rounds non-integer values to the nearest integer', () => {
				expect(parseGoalMarkers('<!-- maestro:progress 45.4 -->').progress).toBe(45);
				expect(parseGoalMarkers('<!-- maestro:progress 45.6 -->').progress).toBe(46);
			});

			it('returns null progress when no progress marker is present', () => {
				const result = parseGoalMarkers('Just some prose with no markers at all.');
				expect(result.progress).toBeNull();
				expect(result.rationale).toBeNull();
			});

			it('tolerates a trailing percent sign on the number', () => {
				expect(parseGoalMarkers('<!-- maestro:progress 45% -->').progress).toBe(45);
				expect(parseGoalMarkers('<!-- maestro:progress 45 % -->').progress).toBe(45);
				// With a rationale after the percent.
				const withRationale = parseGoalMarkers(
					'<!-- maestro:progress 60% | data layer migrated -->'
				);
				expect(withRationale.progress).toBe(60);
				expect(withRationale.rationale).toBe('data layer migrated');
				// Percent on a 100 still implies completion.
				const done = parseGoalMarkers('<!-- maestro:progress 100% | shipped -->');
				expect(done.progress).toBe(100);
				expect(done.complete).toBe(true);
			});

			it('finds a marker wrapped in backticks or a fenced code block', () => {
				// Inline backticks around the whole marker.
				expect(parseGoalMarkers('`<!-- maestro:progress 45 -->`').progress).toBe(45);
				// Inside a fenced code block.
				const fenced = ['```', '<!-- maestro:progress 70 | almost there -->', '```'].join('\n');
				const result = parseGoalMarkers(fenced);
				expect(result.progress).toBe(70);
				expect(result.rationale).toBe('almost there');
				// Fence with a language tag.
				const tagged = ['```text', '<!-- maestro:progress 80 -->', '```'].join('\n');
				expect(parseGoalMarkers(tagged).progress).toBe(80);
			});

			it('captures curly / smart punctuation in the rationale verbatim', () => {
				const result = parseGoalMarkers(
					'<!-- maestro:progress 55 | refactored the “auth” module - it’s nearly done… -->'
				);
				expect(result.progress).toBe(55);
				expect(result.rationale).toBe('refactored the “auth” module - it’s nearly done…');
			});

			it('uses the last progress marker when several are present', () => {
				const text = [
					'<!-- maestro:progress 10 | started -->',
					'<!-- maestro:progress 45 | halfway -->',
					'<!-- maestro:progress 70 | almost there -->',
				].join('\n');
				const result = parseGoalMarkers(text);
				expect(result.progress).toBe(70);
				expect(result.rationale).toBe('almost there');
			});
		});

		describe('completion marker', () => {
			it('sets complete from the bare goal-complete marker', () => {
				const result = parseGoalMarkers('All done.\n<!-- maestro:goal-complete -->');
				expect(result.complete).toBe(true);
			});

			it('is whitespace tolerant for the bare completion marker', () => {
				expect(parseGoalMarkers('<!--maestro:goal-complete-->').complete).toBe(true);
				expect(parseGoalMarkers('<!--   maestro:goal-complete   -->').complete).toBe(true);
			});

			it('treats progress of exactly 100 as complete even without the bare marker', () => {
				const result = parseGoalMarkers('<!-- maestro:progress 100 | shipped -->');
				expect(result.progress).toBe(100);
				expect(result.complete).toBe(true);
			});

			it('does not mark complete for progress below 100 without the bare marker', () => {
				const result = parseGoalMarkers('<!-- maestro:progress 99 -->');
				expect(result.complete).toBe(false);
			});
		});

		describe('deadlock marker', () => {
			it('parses a deadlock marker with a reason', () => {
				const result = parseGoalMarkers(
					'<!-- maestro:deadlock: cannot resolve conflicting requirements -->'
				);
				expect(result.deadlock).toBe(true);
				expect(result.deadlockReason).toBe('cannot resolve conflicting requirements');
			});

			it('parses a bare deadlock marker with a null reason', () => {
				const result = parseGoalMarkers('<!-- maestro:deadlock -->');
				expect(result.deadlock).toBe(true);
				expect(result.deadlockReason).toBeNull();
			});

			it('is whitespace tolerant for the deadlock marker', () => {
				const result = parseGoalMarkers('<!--maestro:deadlock:   stuck on flaky test   -->');
				expect(result.deadlock).toBe(true);
				expect(result.deadlockReason).toBe('stuck on flaky test');
			});

			it('reports no deadlock when no deadlock marker is present', () => {
				const result = parseGoalMarkers('<!-- maestro:progress 50 -->');
				expect(result.deadlock).toBe(false);
				expect(result.deadlockReason).toBeNull();
			});
		});

		describe('absence of any marker', () => {
			it('returns an all-null/false result for plain prose', () => {
				const result = parseGoalMarkers('I worked on the task and made some changes.');
				expect(result).toEqual({
					progress: null,
					rationale: null,
					complete: false,
					deadlock: false,
					deadlockReason: null,
				});
			});

			it('returns an all-null/false result for empty input', () => {
				expect(parseGoalMarkers('')).toEqual({
					progress: null,
					rationale: null,
					complete: false,
					deadlock: false,
					deadlockReason: null,
				});
			});
		});

		describe('realistic agent-response text', () => {
			it('finds a marker embedded mid-paragraph', () => {
				const text =
					'I refactored the database layer and migrated three queries. ' +
					'<!-- maestro:progress 60 | db layer migrated --> ' +
					'Next I will tackle the cache.';
				const result = parseGoalMarkers(text);
				expect(result.progress).toBe(60);
				expect(result.rationale).toBe('db layer migrated');
			});

			it('finds a marker at the very end of a longer response', () => {
				const text = [
					'## Summary',
					'',
					'- Implemented the parser',
					'- Wrote tests',
					'- All green',
					'',
					'Wrapping up this iteration.',
					'',
					'<!-- maestro:progress 100 | feature complete and tested -->',
				].join('\n');
				const result = parseGoalMarkers(text);
				expect(result.progress).toBe(100);
				expect(result.complete).toBe(true);
				expect(result.rationale).toBe('feature complete and tested');
			});

			it('handles a response carrying both a progress and a deadlock marker', () => {
				const text =
					'Made partial progress but then hit a wall.\n' +
					'<!-- maestro:progress 40 | wired up the UI -->\n' +
					'<!-- maestro:deadlock: upstream API is undocumented -->';
				const result = parseGoalMarkers(text);
				expect(result.progress).toBe(40);
				expect(result.rationale).toBe('wired up the UI');
				expect(result.deadlock).toBe(true);
				expect(result.deadlockReason).toBe('upstream API is undocumented');
			});
		});
	});
});
describeSourceSuite('goalRunLabel', () => {
	describe('formatGoalRunDocumentPath', () => {
		it('prefixes a short goal with the Goal: marker', () => {
			expect(formatGoalRunDocumentPath('Migrate to Zustand')).toBe('Goal: Migrate to Zustand');
		});

		it('trims surrounding whitespace before prefixing', () => {
			expect(formatGoalRunDocumentPath('   Refactor auth   ')).toBe('Goal: Refactor auth');
		});

		it('clips a long goal to the max length with an ellipsis', () => {
			const longGoal = 'x'.repeat(GOAL_RUN_LABEL_MAX_LENGTH + 50);
			const result = formatGoalRunDocumentPath(longGoal);
			expect(result.startsWith(GOAL_RUN_DOCUMENT_PREFIX)).toBe(true);
			// Prefix + exactly GOAL_RUN_LABEL_MAX_LENGTH chars + the ellipsis.
			expect(result).toBe(`${GOAL_RUN_DOCUMENT_PREFIX}${'x'.repeat(GOAL_RUN_LABEL_MAX_LENGTH)}…`);
		});

		it('does not clip a goal exactly at the limit', () => {
			const exact = 'y'.repeat(GOAL_RUN_LABEL_MAX_LENGTH);
			expect(formatGoalRunDocumentPath(exact)).toBe(`${GOAL_RUN_DOCUMENT_PREFIX}${exact}`);
			expect(formatGoalRunDocumentPath(exact)).not.toContain('…');
		});
	});

	describe('isGoalRunDocument', () => {
		it('recognizes a formatted goal label', () => {
			expect(isGoalRunDocument(formatGoalRunDocumentPath('Ship it'))).toBe(true);
		});

		it('rejects a real document path', () => {
			expect(isGoalRunDocument('/Users/me/project/Phase-01.md')).toBe(false);
		});

		it('rejects null/undefined', () => {
			expect(isGoalRunDocument(undefined)).toBe(false);
			expect(isGoalRunDocument(null)).toBe(false);
		});
	});

	describe('goalRunLabel', () => {
		it('strips the prefix to recover the goal text', () => {
			expect(goalRunLabel('Goal: Migrate to Zustand')).toBe('Migrate to Zustand');
		});

		it('returns a document path unchanged', () => {
			expect(goalRunLabel('/Users/me/project/Phase-01.md')).toBe('/Users/me/project/Phase-01.md');
		});

		it('returns an empty string for null/undefined', () => {
			expect(goalRunLabel(undefined)).toBe('');
			expect(goalRunLabel(null)).toBe('');
		});

		it('round-trips with formatGoalRunDocumentPath for a short goal', () => {
			const goal = 'Add pagination to the user list';
			expect(goalRunLabel(formatGoalRunDocumentPath(goal))).toBe(goal);
		});
	});
});
