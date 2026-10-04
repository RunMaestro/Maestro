import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from 'ink-testing-library';
import {
	parseAutoRunProgress,
	type AgentRecord,
	type AutoRunRunEvent,
} from '../../shared/maestro-lib';
import { App } from '../App';
import { DESKTOP_HOST, createFakeClient, type FakeClientOptions } from './fakeClient';
import { RECORDED_RUN_POINTS, recordedRunUntil } from './fixtures/autoRunReplay';

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const ENTER = '\r';
const ESC = '\u001B';
const TAB = '\t';
const SPACE = ' ';

describe('Auto Run launch, progress, and controls in the TUI (AR-4 to AR-7)', () => {
	let dir: string;
	let project: string;
	let folder: string;

	const agents = (extra: Partial<AgentRecord> = {}): AgentRecord[] => [
		{
			id: 'a1',
			name: 'Alpha',
			toolType: 'claude-code',
			state: 'idle',
			cwd: project,
			aiTabs: [{ id: 't1', name: 'one' }],
			...extra,
		},
	];

	const mount = async (options: FakeClientOptions & { noClient?: boolean } = {}) => {
		const fake = createFakeClient({ agents: agents(), ...options });
		const instance = render(
			<App
				paths={{
					userDataDir: dir,
					sessionsFile: path.join(dir, 'maestro-sessions.json'),
					groupsFile: path.join(dir, 'maestro-groups.json'),
					settingsFile: path.join(dir, 'maestro-settings.json'),
					agentConfigsFile: path.join(dir, 'maestro-agent-configs.json'),
					historyDir: path.join(dir, 'history'),
				}}
				client={options.noClient ? undefined : fake.client}
				editFile={async () => ({ ok: true })}
			/>
		);
		await tick();
		const stdout = instance.stdout as unknown as { emit: (event: string) => boolean };
		Object.defineProperty(stdout, 'columns', { value: 140, configurable: true });
		Object.defineProperty(stdout, 'rows', { value: 40, configurable: true });
		stdout.emit('resize');
		await tick();
		const press = async (...keys: string[]) => {
			for (const key of keys) {
				instance.stdin.write(key);
				await tick();
			}
		};
		/** Delivers a run's events the way the client does: as `autorun` events for the agent. */
		const replay = async (events: AutoRunRunEvent[], agentId = 'a1') => {
			for (const event of events) fake.push({ type: 'autorun', agentId, event });
			await tick();
		};
		return { ...instance, fake, press, replay, frame: () => instance.lastFrame() ?? '' };
	};

	const write = (name: string, content: string) => {
		const file = path.join(folder, `${name}.md`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
		return file;
	};

	/** Opens the list for Alpha: the first `j` selects the agent, `a` opens its Auto Run documents. */
	const openList = async (m: Awaited<ReturnType<typeof mount>>) => {
		await m.press('j', 'a');
	};

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-tui-autorun-run-'));
		project = path.join(dir, 'project');
		folder = path.join(project, '.maestro', 'playbooks');
		fs.mkdirSync(folder, { recursive: true });
		write('alpha', '- [ ] one\n- [ ] two\n');
		write('beta', '- [ ] only\n');
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	describe('picking documents and starting a spec-driven run', () => {
		it('numbers documents in the order picked, and a second press unpicks one', async () => {
			const m = await mount();
			await openList(m);
			await m.press('j', SPACE, 'k', SPACE);
			expect(m.frame()).toMatch(/1\.\s+beta/);
			expect(m.frame()).toMatch(/2\.\s+alpha/);
			await m.press(SPACE);
			expect(m.frame()).toMatch(/1\.\s+beta/);
			expect(m.frame()).not.toMatch(/2\.\s+alpha/);
			m.unmount();
		});

		it('lists the picked documents in run order on the form, then launches them in that order', async () => {
			const m = await mount();
			await openList(m);
			await m.press('j', SPACE, 'k', SPACE, 's');
			expect(m.frame()).toContain('Auto Run: Alpha');
			expect(m.frame()).toContain('Runs 2 documents, in this order');
			expect(m.frame()).toMatch(/1\. beta/);
			expect(m.frame()).toMatch(/2\. alpha/);

			// Loop on (Space), then the loop count appears and takes digits; Tab moves down.
			await m.press(SPACE);
			expect(m.frame()).toContain('Max loops');
			await m.press(TAB, '3', 'x');
			expect(m.frame()).toMatch(/Max loops\s+3/);
			await m.press(TAB, SPACE);
			await m.press(ENTER);
			await tick(60);

			expect(m.fake.requests.map((request) => request.method)).toEqual([
				'agents.update',
				'autoRun.launch',
			]);
			expect(m.fake.requests[0].args).toEqual(['a1', { autoRunFolderPath: folder }]);
			expect(m.fake.requests[1].args).toEqual([
				'a1',
				{
					documents: [
						{ file: path.join(folder, 'beta.md'), resetOnCompletion: true },
						{ file: path.join(folder, 'alpha.md'), resetOnCompletion: true },
					],
					loop: true,
					maxLoops: 3,
				},
			]);
			// The progress screen takes over, with the host's own pending state still to come.
			expect(m.frame()).toContain('Auto Run progress: Alpha');
			expect(m.frame()).toContain('Started 2 documents on Alpha.');
			m.unmount();
		});

		it('runs the highlighted document when nothing is picked', async () => {
			const m = await mount();
			await openList(m);
			await m.press('s', ENTER);
			await tick(60);
			expect(m.fake.requests.at(-1)).toEqual({
				method: 'autoRun.launch',
				args: ['a1', { documents: [{ file: path.join(folder, 'alpha.md') }] }],
			});
			m.unmount();
		});

		it('sets the per-run model from the provider list and the effort from its own words', async () => {
			const m = await mount({ models: { 'claude-code': ['opus', 'sonnet'] } });
			await openList(m);
			await m.press('s');
			await tick(60);
			// loop, reset, model, effort: Tab to the model, step to the first option; Tab to effort, step once.
			await m.press(TAB, TAB, SPACE);
			expect(m.frame()).toContain('‹ opus ›');
			await m.press(TAB, SPACE);
			await m.press(ENTER);
			await tick(60);
			const launch = m.fake.requests.at(-1);
			expect(launch?.method).toBe('autoRun.launch');
			expect(launch?.args[1]).toMatchObject({ model: 'opus' });
			expect((launch?.args[1] as { effort?: string }).effort).toBeTruthy();
			m.unmount();
		});

		it('keeps the form open and says why when the host refuses', async () => {
			const m = await mount({ failures: { 'autoRun.launch': 'rejected' } });
			await openList(m);
			await m.press('s', ENTER);
			await tick(60);
			expect(m.frame()).toContain('fake rejected');
			expect(m.frame()).toContain('Auto Run: Alpha');
			expect(m.frame()).not.toContain('Auto Run progress');
			m.unmount();
		});

		it('says so when there is nothing to run', async () => {
			fs.rmSync(folder, { recursive: true, force: true });
			const m = await mount();
			await openList(m);
			await m.press('s');
			expect(m.frame()).toContain('No document to run. Press n to create one.');
			expect(m.fake.requests).toEqual([]);
			m.unmount();
		});

		it('refuses to start without a desktop', async () => {
			// With no client the agents come from the store file.
			fs.writeFileSync(
				path.join(dir, 'maestro-sessions.json'),
				JSON.stringify({ sessions: agents() })
			);
			const m = await mount({ noClient: true });
			await openList(m);
			await m.press('s');
			expect(m.frame()).toContain('No desktop attached');
			m.unmount();
		});
	});

	describe('a goal-driven run', () => {
		it('takes a goal, exit criteria, and a cap, and starts the run', async () => {
			const m = await mount({ goalRunTabId: 't1' });
			await openList(m);
			await m.press('g');
			expect(m.frame()).toContain('Goal-driven run: Alpha');
			await m.press(...'Make CI green'.split(''), TAB, ...'All checks pass'.split(''), TAB);
			// The cap starts at 10; clear it to run with no cap, then type 4.
			await m.press('\u007f', '\u007f', '4');
			await m.press(ENTER);
			await tick(60);
			expect(m.fake.requests.at(-1)).toEqual({
				method: 'autoRun.launchGoal',
				args: ['a1', { goal: 'Make CI green', exitCriteria: 'All checks pass', maxIterations: 4 }],
			});
			expect(m.frame()).toContain('Started a goal run on Alpha.');
			m.unmount();
		});

		it('holds the form and says what is missing when the goal is empty', async () => {
			const m = await mount();
			await openList(m);
			await m.press('g', ENTER);
			expect(m.frame()).toContain('Say what the run should achieve.');
			expect(m.fake.requests).toEqual([]);
			m.unmount();
		});

		it('sends no cap when the box is empty', async () => {
			const m = await mount();
			await openList(m);
			await m.press('g', ...'x'.split(''), TAB, TAB, '\u007f', '\u007f', ENTER);
			await tick(60);
			expect(m.fake.requests.at(-1)?.args[1]).toEqual({ goal: 'x', maxIterations: null });
			m.unmount();
		});
	});

	describe('watching a run', () => {
		const runningAt = (seconds: number) => {
			const base = Date.now() - seconds * 1000;
			return { base, events: recordedRunUntil(base, seconds) };
		};

		it('shows the document, task, clock, tokens, cost, and output tail of a replayed run', async () => {
			const m = await mount();
			await openList(m);
			const { events } = runningAt(RECORDED_RUN_POINTS.firstTaskDone + 5);
			await m.replay(events);
			await m.press('w');
			const frame = m.frame();
			expect(frame).toContain('Auto Run progress: Alpha');
			expect(frame).toContain('Running');
			expect(frame).toContain('Document 1 of 2: phase-1');
			expect(frame).toContain('Task 1/5 done (1/2 in this document)');
			expect(frame).toMatch(/Clock 0:4\d/);
			expect(frame).toContain('1.5K in, 300 out');
			expect(frame).toContain('$0.06');
			expect(frame).toContain('Read src/index.ts');
			expect(frame).toContain('Task one is done.');
			expect(frame).toContain('s stop after this task');
			m.unmount();
		});

		it('treats a fresh connection as the end of what it held, and the host replay restarts a live run', async () => {
			const m = await mount();
			await openList(m);
			const { events } = runningAt(RECORDED_RUN_POINTS.firstTaskDone + 5);
			await m.replay(events);
			await m.press('w');
			expect(m.frame()).toContain('Running');

			// A resumed connection missed nothing, so the run stands.
			m.fake.push({ type: 'host.connected', host: DESKTOP_HOST, resumed: true });
			await tick();
			expect(m.frame()).toContain('Running');

			// A new connection may have missed the end, so the run closes...
			m.fake.push({ type: 'host.connected', host: DESKTOP_HOST, resumed: false });
			await tick();
			expect(m.frame()).toContain('Ended');
			expect(m.frame()).toContain('No controls');

			// ...and the host's replay of a run still going brings it back.
			await m.replay([
				{
					kind: 'state',
					at: Date.now(),
					state: parseAutoRunProgress({
						isRunning: true,
						totalTasks: 4,
						completedTasks: 1,
						currentTaskIndex: 1,
						documents: ['one', 'two'],
						startTime: Date.now() - 30_000,
					}),
				},
			]);
			expect(m.frame()).toContain('Running');
			expect(m.frame()).toContain('Task 1/4 done');
			m.unmount();
		});

		it('marks a running agent on the document list, and Esc steps back from the progress screen', async () => {
			const m = await mount();
			await openList(m);
			expect(m.frame()).not.toContain('to watch');
			await m.replay(runningAt(10).events);
			expect(m.frame()).toContain('Running');
			expect(m.frame()).toContain('w to watch');
			await m.press('w');
			expect(m.frame()).toContain('Auto Run progress: Alpha');
			await m.press(ESC);
			expect(m.frame()).toContain('Auto Run: Alpha');
			expect(m.frame()).toContain('alpha');
			await m.press(ESC);
			expect(m.frame()).not.toContain('Auto Run: Alpha');
			m.unmount();
		});

		it('shows a finished run with its totals and no controls', async () => {
			const m = await mount();
			await openList(m);
			await m.replay(recordedRunUntil(Date.now() - 300_000, 300));
			await m.press('w');
			expect(m.frame()).toContain('Finished');
			expect(m.frame()).toContain('Task 5/5 done');
			expect(m.frame()).toContain('2:40');
			expect(m.frame()).toContain('2.3K in, 450 out');
			expect(m.frame()).toContain('$0.09');
			expect(m.frame()).toContain('No controls');
			m.unmount();
		});

		it('says nothing is running for an agent with no run', async () => {
			const m = await mount();
			await openList(m);
			await m.press('w');
			expect(m.frame()).toContain('No run for this agent.');
			expect(m.frame()).toContain('Nothing is running.');
			m.unmount();
		});
	});

	describe('controls', () => {
		const pausedEvents = () => {
			const base = Date.now() - 100_000;
			return recordedRunUntil(base, RECORDED_RUN_POINTS.paused + 5);
		};

		it('stops a running run', async () => {
			const m = await mount();
			await openList(m);
			await m.replay(recordedRunUntil(Date.now() - 20_000, 20));
			await m.press('w', 's');
			await tick(40);
			expect(m.fake.requests.at(-1)).toEqual({ method: 'autoRun.stop', args: ['a1'] });
			expect(m.frame()).toContain('Asked Alpha to stop after the current task.');
			m.unmount();
		});

		it('refuses a control the run does not offer, and sends nothing', async () => {
			const m = await mount();
			await openList(m);
			await m.replay(recordedRunUntil(Date.now() - 20_000, 20));
			await m.press('w', 'r');
			expect(m.frame()).toContain('The run is not paused, so there is nothing to resume.');
			expect(m.fake.requests.filter((request) => request.method === 'autoRun.resume')).toEqual([]);
			m.unmount();
		});

		it.each([
			['r', 'autoRun.resume', 'Resumed the run.'],
			['n', 'autoRun.skip', 'Skipping the failing document.'],
			['a', 'autoRun.abort', 'Aborted the run.'],
		])('on an error pause, %s calls %s', async (key, method, message) => {
			const m = await mount();
			await openList(m);
			await m.replay(pausedEvents());
			await m.press('w');
			expect(m.frame()).toContain('Paused on an error');
			expect(m.frame()).toContain('Rate limited by the provider (Write the tests)');
			expect(m.frame()).toContain('resume');
			await m.press(key);
			await tick(40);
			expect(m.fake.requests.at(-1)).toEqual({ method, args: ['a1'] });
			expect(m.frame()).toContain(message);
			m.unmount();
		});

		it('shows the host refusal of a control', async () => {
			const m = await mount({ failures: { 'autoRun.resume': 'host-lost' } });
			await openList(m);
			await m.replay(pausedEvents());
			await m.press('w', 'r');
			await tick(40);
			expect(m.frame()).toContain('fake host-lost');
			m.unmount();
		});

		it('answers a human gate with resume, and offers no skip', async () => {
			const m = await mount();
			await openList(m);
			await m.replay([
				{
					kind: 'state',
					at: Date.now(),
					state: parseAutoRunProgress({
						isRunning: true,
						totalTasks: 3,
						completedTasks: 1,
						currentTaskIndex: 1,
						errorPaused: true,
						errorType: 'hitl_gate',
						errorMessage: 'Review the schema before the migration',
					}),
				},
			]);
			await m.press('w');
			expect(m.frame()).toContain('Waiting for you');
			expect(m.frame()).toContain('Review the schema before the migration');
			expect(m.frame()).toContain('approve and continue');
			expect(m.frame()).not.toContain('skip this document');
			await m.press('r');
			await tick(40);
			expect(m.fake.requests.at(-1)).toEqual({ method: 'autoRun.resume', args: ['a1'] });
			m.unmount();
		});

		it('opens the progress screen from the palette, where a control is not yet pressed', async () => {
			const m = await mount();
			await m.press('j');
			await m.replay(recordedRunUntil(Date.now() - 20_000, 20));
			await m.press('\u000b');
			await m.press(...'Stop the Auto Run'.split(''));
			await m.press(ENTER);
			await tick(40);
			expect(m.frame()).toContain('Auto Run progress: Alpha');
			expect(m.fake.requests.filter((request) => request.method === 'autoRun.stop')).toEqual([]);
			m.unmount();
		});
	});
});
