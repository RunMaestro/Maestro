import { describe, expect, it } from 'vitest';
import type { GoalRunConfig } from '../../../goalDriven/types';
import { runGoal } from '../run-goal';
import { collect, createFakeDeps, session } from './fake-deps';

const goal = (overrides: Partial<GoalRunConfig> = {}): GoalRunConfig => ({
	goal: 'Ship the feature',
	exitCriteria: 'All tests pass',
	maxIterations: 5,
	...overrides,
});

describe('runGoal (library engine)', () => {
	it('finishes on the iteration the agent reports the goal complete', async () => {
		const fake = createFakeDeps({});
		fake.onTurn = (request, f) => {
			if (request.purpose === 'goal-handoff') return { success: true, response: 'carry on' };
			const iteration = f.requests.filter((r) => r.purpose === 'goal-iteration').length;
			return {
				success: true,
				response:
					iteration === 1
						? '<!-- maestro:progress 40 | started -->\nWorked on it'
						: '<!-- maestro:progress 100 | done -->\n<!-- maestro:goal-complete -->\nDone',
				agentSessionId: `prov-${iteration}`,
			};
		};

		const events = await collect(runGoal(session(), goal(), {}, fake.deps));

		expect(events.map((e) => e.type)).toEqual([
			'goal_start',
			'goal_iteration_start',
			'goal_iteration_complete',
			'goal_iteration_start',
			'goal_iteration_complete',
			'goal_complete',
		]);
		expect(events.at(-1)).toMatchObject({
			success: true,
			exitReason: 'completed',
			finalProgress: 100,
			iterations: 2,
		});
		// A start row, one row per iteration, and the final row.
		expect(fake.history).toHaveLength(4);
		expect(fake.history[0].summary).toBe('Goal-Driven Auto Run started');
		expect(fake.history.at(-1)?.summary).toBe('Goal completed (100%)');
	});

	it('hands the next iteration the handoff note from the previous session', async () => {
		const fake = createFakeDeps({});
		fake.onTurn = (request, f) => {
			if (request.purpose === 'goal-handoff') return { success: true, response: 'NOTE-FOR-NEXT' };
			const n = f.requests.filter((r) => r.purpose === 'goal-iteration').length;
			return {
				success: true,
				response: n === 1 ? '<!-- maestro:progress 10 -->' : '<!-- maestro:goal-complete -->',
				agentSessionId: `prov-${n}`,
			};
		};

		await collect(runGoal(session(), goal(), {}, fake.deps));

		const handoff = fake.requests.find((r) => r.purpose === 'goal-handoff');
		expect(handoff).toMatchObject({ resumeSessionId: 'prov-1' });
		const second = fake.requests.filter((r) => r.purpose === 'goal-iteration')[1];
		expect(second.prompt).toContain('NOTE-FOR-NEXT');
	});

	it('carries on when the handoff turn throws', async () => {
		const fake = createFakeDeps({});
		const warnings: string[] = [];
		fake.deps.log.warn = (message) => {
			warnings.push(message);
		};
		fake.onTurn = (request, f) => {
			if (request.purpose === 'goal-handoff') throw new Error('provider fell over');
			const n = f.requests.filter((r) => r.purpose === 'goal-iteration').length;
			return {
				success: true,
				response: n === 1 ? '<!-- maestro:progress 10 -->' : '<!-- maestro:goal-complete -->',
				agentSessionId: `prov-${n}`,
			};
		};

		const events = await collect(runGoal(session(), goal(), {}, fake.deps));

		expect(events.at(-1)).toMatchObject({ exitReason: 'completed' });
		expect(warnings).toEqual(['[GoalRunner] Handoff synopsis request failed']);
	});

	it('stops at the iteration cap', async () => {
		const fake = createFakeDeps({});
		fake.onTurn = (request, f) => {
			if (request.purpose === 'goal-handoff') return { success: true, response: 'x' };
			const n = f.requests.filter((r) => r.purpose === 'goal-iteration').length;
			return {
				success: true,
				response: `<!-- maestro:progress ${n * 10} -->`,
				agentSessionId: `p${n}`,
			};
		};

		const events = await collect(runGoal(session(), goal({ maxIterations: 2 }), {}, fake.deps));

		expect(events.at(-1)).toMatchObject({
			success: false,
			exitReason: 'max-iterations',
			iterations: 2,
		});
	});

	it('records an interrupted iteration as a stop with no iteration row', async () => {
		const fake = createFakeDeps({});
		fake.onTurn = () => ({ success: false, outcome: 'interrupted', error: 'stopped' });

		const events = await collect(runGoal(session(), goal(), {}, fake.deps));

		expect(events.at(-1)).toMatchObject({ exitReason: 'stopped-by-user', iterations: 1 });
		expect(events.some((e) => e.type === 'goal_iteration_complete')).toBe(false);
		expect(fake.history.map((e) => e.summary)).toEqual([
			'Goal-Driven Auto Run started',
			'Goal run stopped (0%)',
		]);
	});

	it('does not start an iteration once the signal has aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		const fake = createFakeDeps({});

		const events = await collect(
			runGoal(session(), goal(), { signal: controller.signal }, fake.deps)
		);

		expect(fake.requests).toHaveLength(0);
		expect(events.at(-1)).toMatchObject({ exitReason: 'stopped-by-user', iterations: 0 });
	});

	it('writes no History when asked not to, and marks the agent busy for the run', async () => {
		const fake = createFakeDeps({});
		fake.onTurn = () => ({ success: true, response: '<!-- maestro:goal-complete -->' });

		await collect(runGoal(session(), goal(), { writeHistory: false }, fake.deps));

		expect(fake.history).toHaveLength(0);
		expect(fake.activity[0]).toBe('begin:agent-1:goal-run');
		expect(fake.activity.at(-1)).toBe('end:agent-1');
	});

	it('sends run overrides on iterations and falls back to the agent settings', async () => {
		const fake = createFakeDeps({});
		fake.onTurn = () => ({ success: true, response: '<!-- maestro:goal-complete -->' });

		await collect(
			runGoal(
				session({ customModel: 'agent-model', customEffort: 'agent-effort' }),
				goal(),
				{ model: 'run-model' },
				fake.deps
			)
		);

		expect(fake.requests[0]).toMatchObject({
			purpose: 'goal-iteration',
			model: 'run-model',
			effort: 'agent-effort',
		});
	});
});
