/**
 * What the engine does differently under the runtime's policy than under the CLI's: the synopsis
 * source, the document in the prompt, the goal checkpoint commit, the completed-task count, the
 * stall row, and the stats port.
 */
import { describe, expect, it, vi } from 'vitest';

import { countMarkdownTasks } from '../../../markdownTaskScan';
import type { GoalRunConfig } from '../../../goalDriven/types';
import type { Playbook } from '../../../types';
import type { AutoRunDeps } from '../engine-types';
import { CLI_AUTORUN_POLICY, DESKTOP_AUTORUN_POLICY } from '../policy';
import { runGoal } from '../run-goal';
import { runPlaybook } from '../run-playbook';
import { collect, createFakeDeps, session, tickFirstTask, type FakeDeps } from './fake-deps';

const playbook = (...names: string[]): Playbook => ({
	id: 'pb',
	name: 'Playbook',
	createdAt: 0,
	updatedAt: 0,
	documents: names.map((filename) => ({ filename, resetOnCompletion: false })),
	loopEnabled: false,
	prompt: '',
});

const goal = (): GoalRunConfig => ({
	goal: 'Ship it',
	exitCriteria: 'Tests pass',
	maxIterations: 3,
});

/** The runtime's rules, and no controller: nothing pauses, so only the branches under test differ. */
const runtimePolicy = { ...DESKTOP_AUTORUN_POLICY, autoResume: null };

function withPolicy(fake: FakeDeps, policy: AutoRunDeps['policy']): AutoRunDeps {
	return { ...fake.deps, policy };
}

describe('synopsis', () => {
	it('comes from the task answer under the runtime policy, with no extra turn', async () => {
		const fake = createFakeDeps({ a: '- [ ] one\n- [ ] two' });
		fake.onTurn = (_request, f) => {
			f.docs.set('a', tickFirstTask(f.docs.get('a') ?? ''));
			return {
				success: true,
				response: 'Wired the module into the build. Then ran the checks.\n\nMore detail.',
				agentSessionId: 'prov',
			};
		};

		await collect(
			runPlaybook(session(), playbook('a'), '/docs', {}, withPolicy(fake, runtimePolicy))
		);

		expect(fake.requests.map((request) => request.purpose)).toEqual(['task', 'task']);
		const rows = fake.history.filter((entry) => entry.completedTaskCount !== undefined);
		expect(rows).toHaveLength(2);
		expect(rows[0].summary).toBe('Wired the module into the build.');
		expect(rows[0].fullResponse).toContain('More detail.');
	});

	it('is a second, cheap turn under the CLI policy, and absent with skipSynopsis', async () => {
		const fake = createFakeDeps({ a: '- [ ] one' });
		await collect(runPlaybook(session(), playbook('a'), '/docs', {}, fake.deps));
		expect(fake.requests.map((request) => request.purpose)).toEqual(['task', 'synopsis']);

		const skipped = createFakeDeps({ a: '- [ ] one' });
		await collect(
			runPlaybook(session(), playbook('a'), '/docs', { skipSynopsis: true }, skipped.deps)
		);
		expect(skipped.requests.map((request) => request.purpose)).toEqual(['task']);
		expect(skipped.history[0].summary).toBe('[a] Task completed');
	});

	it('uses the runtime rule for a goal iteration: the first sentence, not the first line', async () => {
		// No rationale in the marker, so the synopsis is what the summary line falls back to.
		const answer =
			'<!-- maestro:progress 100 -->\nGot the parser working. It handles nesting.\n\nBody.';
		const summaryUnder = async (policy: AutoRunDeps['policy']) => {
			const fake = createFakeDeps({});
			fake.onTurn = () => ({ success: true, response: answer, agentSessionId: 'p' });
			await collect(runGoal(session(), goal(), {}, withPolicy(fake, policy)));
			return fake.history.find((entry) => entry.summary.startsWith('Goal progress'))?.summary;
		};
		expect(await summaryUnder(runtimePolicy)).toBe('Goal progress: 100% - Got the parser working.');
		expect(await summaryUnder(CLI_AUTORUN_POLICY)).toBe(
			'Goal progress: 100% - Got the parser working. It handles nesting.'
		);
	});
});

describe('the document in the prompt', () => {
	it('is inlined under the CLI policy and left to the agent to read under the runtime policy', async () => {
		const cli = createFakeDeps({ a: '- [ ] unique-task-text' });
		await collect(runPlaybook(session(), playbook('a'), '/docs', { skipSynopsis: true }, cli.deps));
		expect(cli.requests[0].prompt).toContain('# Current Document: /docs/a.md');
		expect(cli.requests[0].prompt).toContain('unique-task-text');

		const runtime = createFakeDeps({ a: '- [ ] unique-task-text' });
		await collect(
			runPlaybook(session(), playbook('a'), '/docs', {}, withPolicy(runtime, runtimePolicy))
		);
		expect(runtime.requests[0].prompt).not.toContain('# Current Document');
		expect(runtime.requests[0].prompt).not.toContain('unique-task-text');
	});
});

describe('completed tasks per dispatch', () => {
	/** A document port that counts checked boxes too, as the runtime's does. */
	function countingDocs(fake: FakeDeps): AutoRunDeps {
		return {
			...fake.deps,
			documents: {
				...fake.deps.documents,
				read: (_folder, name) => {
					const content = fake.docs.get(name) ?? '';
					const { unchecked, checked } = countMarkdownTasks(content);
					return { content, unchecked, checked };
				},
			},
		};
	}

	it('counts the boxes the agent ticked, even when it adds tasks as it works', async () => {
		const fake = createFakeDeps({ a: '- [ ] one\n- [ ] two' });
		let turns = 0;
		fake.onTurn = (_request, f) => {
			turns++;
			// Tick one task and add two more: the open count grows, the checked count is what moved.
			const text = f.docs.get('a') ?? '';
			f.docs.set(
				'a',
				turns === 1 ? `${tickFirstTask(text)}\n- [ ] extra 1\n- [ ] extra 2` : tickFirstTask(text)
			);
			return { success: true, response: 'Did it. Done.', agentSessionId: 'p' };
		};

		await collect(
			runPlaybook(
				session(),
				playbook('a'),
				'/docs',
				{},
				{
					...countingDocs(fake),
					policy: runtimePolicy,
				}
			)
		);

		const counts = fake.history.flatMap((entry) =>
			entry.completedTaskCount !== undefined ? [entry.completedTaskCount] : []
		);
		expect(counts[0]).toBe(1);
		expect(counts.every((count) => count >= 0)).toBe(true);
	});

	it('is never negative when a port reports only the open count', async () => {
		const fake = createFakeDeps({ a: '- [ ] one' });
		let turns = 0;
		fake.onTurn = (_request, f) => {
			turns++;
			if (turns === 1) f.docs.set('a', '- [ ] one\n- [ ] two\n- [ ] three');
			else f.docs.set('a', '- [x] one\n- [x] two\n- [x] three');
			return { success: true, response: 'ok', agentSessionId: 'p' };
		};

		await collect(
			runPlaybook(session(), playbook('a'), '/docs', { skipSynopsis: true }, fake.deps)
		);

		const counts = fake.history.flatMap((entry) =>
			entry.completedTaskCount !== undefined ? [entry.completedTaskCount] : []
		);
		expect(counts.length).toBeGreaterThan(0);
		expect(counts.every((count) => count >= 0)).toBe(true);
	});
});

describe('a stalled document', () => {
	it('writes the desktop-worded row, and leaves the run going', async () => {
		const fake = createFakeDeps({ a: '- [ ] never done', b: '- [ ] fine' });
		fake.onTurn = (request, f) => {
			if (request.document === 'b') f.docs.set('b', tickFirstTask(f.docs.get('b') ?? ''));
			return { success: true, response: 'I did nothing.', agentSessionId: 'p' };
		};

		const events = await collect(
			runPlaybook(session(), playbook('a', 'b'), '/docs', { skipSynopsis: true }, fake.deps)
		);

		expect(events.some((event) => event.type === 'document_stalled')).toBe(true);
		const stall = fake.history.find((entry) => entry.summary.startsWith('Document stalled:'));
		expect(stall).toMatchObject({
			summary: 'Document stalled: a (1 tasks remaining)',
			success: false,
			type: 'AUTO',
			sessionId: 'agent-1',
		});
		expect(stall?.fullResponse).toContain('**Document Stalled: a**');
		expect(stall?.fullResponse).toContain('Skipping to the next document in the playbook...');
		// The stall row is a control row: it never counts as a task.
		expect(stall?.completedTaskCount).toBeUndefined();
		expect(events.at(-1)).toMatchObject({ type: 'complete', totalTasksCompleted: 1 });
	});
});

describe('the goal checkpoint commit', () => {
	const answers = (fake: FakeDeps) => {
		fake.onTurn = (request, f) => {
			if (request.purpose === 'goal-handoff') return { success: true, response: 'note' };
			const n = f.requests.filter((r) => r.purpose === 'goal-iteration').length;
			return {
				success: true,
				response:
					n === 1
						? '<!-- maestro:progress 30 | first cut -->'
						: '<!-- maestro:progress 100 | done -->\n<!-- maestro:goal-complete -->',
				agentSessionId: `p-${n}`,
			};
		};
	};

	it('commits after every iteration when the policy asks, and never stops the run on a failure', async () => {
		const fake = createFakeDeps({});
		answers(fake);
		const commitAll = vi
			.fn()
			.mockResolvedValueOnce({ committed: true, commitHash: 'abc1234' })
			.mockRejectedValueOnce(new Error('hook failed'));
		const deps: AutoRunDeps = {
			...fake.deps,
			policy: runtimePolicy,
			environment: { ...fake.deps.environment, commitAll },
		};

		const events = await collect(runGoal(session(), goal(), {}, deps));

		expect(commitAll).toHaveBeenCalledTimes(2);
		expect(commitAll).toHaveBeenNthCalledWith(
			1,
			'/work/project',
			'Maestro Auto Run (goal) iteration 1 - first cut'
		);
		expect(commitAll).toHaveBeenNthCalledWith(
			2,
			'/work/project',
			'Maestro Auto Run (goal) iteration 2 - done'
		);
		expect(events.at(-1)).toMatchObject({ type: 'goal_complete', success: true });
	});

	it('does not commit under the CLI policy', async () => {
		const fake = createFakeDeps({});
		answers(fake);
		const commitAll = vi.fn();
		await collect(
			runGoal(
				session(),
				goal(),
				{},
				{
					...fake.deps,
					environment: { ...fake.deps.environment, commitAll },
				}
			)
		);
		expect(commitAll).not.toHaveBeenCalled();
	});

	it('does not commit outside a git repository', async () => {
		const fake = createFakeDeps({});
		answers(fake);
		const commitAll = vi.fn();
		await collect(
			runGoal(
				session(),
				goal(),
				{},
				{
					...fake.deps,
					policy: runtimePolicy,
					environment: { ...fake.deps.environment, isGitRepo: () => false, commitAll },
				}
			)
		);
		expect(commitAll).not.toHaveBeenCalled();
	});
});

describe('the stats port', () => {
	it('opens a run, records every task, and closes it with the reconciled totals', async () => {
		const fake = createFakeDeps({ a: '- [ ] one\n- [ ] two' });
		const startRun = vi.fn().mockResolvedValue('stats-1');
		const recordTask = vi.fn();
		const endRun = vi.fn();

		await collect(
			runPlaybook(
				session(),
				playbook('a'),
				'/docs',
				{ skipSynopsis: true },
				{
					...fake.deps,
					stats: { startRun, recordTask, endRun },
				}
			)
		);

		expect(startRun).toHaveBeenCalledWith(
			expect.objectContaining({
				agentType: 'claude-code',
				documentPath: 'a',
				tasksTotal: 2,
				projectPath: '/work/project',
			})
		);
		expect(recordTask).toHaveBeenCalledTimes(2);
		expect(recordTask).toHaveBeenNthCalledWith(
			2,
			'stats-1',
			expect.objectContaining({ taskIndex: 1, success: true })
		);
		expect(endRun).toHaveBeenCalledOnce();
		expect(endRun).toHaveBeenCalledWith('stats-1', expect.any(Number), 2);
	});

	it('does not stop a run because stats could not be recorded', async () => {
		const fake = createFakeDeps({ a: '- [ ] one' });
		const events = await collect(
			runPlaybook(
				session(),
				playbook('a'),
				'/docs',
				{ skipSynopsis: true },
				{
					...fake.deps,
					stats: {
						startRun: () => {
							throw new Error('database locked');
						},
						recordTask: vi.fn(),
						endRun: vi.fn(),
					},
				}
			)
		);
		expect(events.at(-1)).toMatchObject({ type: 'complete', success: true });
	});

	it('records a goal run on the 0 to 100 scale and closes it with its progress', async () => {
		const fake = createFakeDeps({});
		fake.onTurn = (request) =>
			request.purpose === 'goal-handoff'
				? { success: true, response: 'note' }
				: {
						success: true,
						response: '<!-- maestro:progress 100 | done -->\n<!-- maestro:goal-complete -->',
						agentSessionId: 'p',
					};
		const startRun = vi.fn().mockResolvedValue('stats-2');
		const endRun = vi.fn();

		await collect(
			runGoal(
				session(),
				goal(),
				{},
				{
					...fake.deps,
					stats: { startRun, recordTask: vi.fn(), endRun },
				}
			)
		);

		expect(startRun).toHaveBeenCalledWith(
			expect.objectContaining({ documentPath: 'Goal: Ship it', tasksTotal: 100 })
		);
		expect(endRun).toHaveBeenCalledWith('stats-2', expect.any(Number), 100);
	});
});
