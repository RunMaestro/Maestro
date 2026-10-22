/**
 * @file cue-schedule-create.test.ts
 * @description Integration tests for `maestro-cli cue schedule` - the create
 * branch (Phase 03 task 1 of the time.once feature). The list/cancel branches
 * are covered in `cue-schedule-list-cancel.test.ts`; this file exercises the
 * end-to-end write path with a real temp directory so the YAML round-trip
 * (mkdir + dump + reload) is asserted on disk, not against a mocked writer.
 *
 * Only the agent lookup (`readSessions`) is mocked - every other dependency
 * (`appendSubscriptionsToYaml`, `loadCueConfigDetailed`,
 * `removeSubscriptionFromYaml`) runs unmodified against the temp project root.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

// Mocks must be set up before importing the module under test.
const mockReadSessions = vi.fn();

vi.mock('../../../cli/services/storage', () => ({
	readSessions: () => mockReadSessions(),
	readLiveSessions: () => mockReadSessions(),
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

import { cueSchedule } from '../../../cli/commands/cue-schedule';

type Session = {
	id: string;
	name: string;
	toolType: string;
	projectRoot: string;
	cwd: string;
};

function session(overrides: Partial<Session> = {}): Session {
	return {
		id: 'agent-aaaaaaaa-1111',
		name: 'Alpha',
		toolType: 'claude-code',
		projectRoot: '/projects/alpha',
		cwd: '/projects/alpha',
		...overrides,
	};
}

function readCueYaml(projectRoot: string): {
	raw: string;
	parsed: Record<string, unknown>;
} {
	const filePath = path.join(projectRoot, '.maestro', 'cue.yaml');
	const raw = fs.readFileSync(filePath, 'utf-8');
	return { raw, parsed: yaml.load(raw) as Record<string, unknown> };
}

const AUTO_NAME_REGEX = /^task-\d{4}-\d{2}-\d{2}-\d{4}-[a-f0-9]{8}$/;
// Phase 04 stamps fire_at via toISOString() which always emits a trailing `Z`.
// Accept either `Z` or a `±HH:MM` / `±HHMM` offset so the test stays valid if
// the implementation switches to keeping the user's local offset.
const TZ_SUFFIX_REGEX = /[+-]\d{2}:?\d{2}$|Z$/;

describe('cue schedule (create)', () => {
	let projectRoot = '';
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-schedule-create-'));
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (projectRoot && fs.existsSync(projectRoot)) {
			fs.rmSync(projectRoot, { recursive: true, force: true });
		}
	});

	it('--in 5m --agent X --notify --message writes a single notify sub with default pipeline and auto-name', async () => {
		mockReadSessions.mockReturnValue([session({ id: 'agent-alpha', name: 'Alpha', projectRoot })]);
		const before = Date.now();

		await cueSchedule({
			in: '5m',
			agent: 'Alpha',
			notify: true,
			message: 'hi',
		});

		const after = Date.now();
		expect(processExitSpy).not.toHaveBeenCalled();

		const { parsed } = readCueYaml(projectRoot);
		const subs = parsed.subscriptions as Array<Record<string, unknown>>;
		expect(subs).toHaveLength(1);

		const sub = subs[0];
		expect(sub.event).toBe('time.once');
		expect(sub.enabled).toBe(true);
		expect(sub.action).toBe('notify');
		expect(sub.agent_id).toBe('agent-alpha');
		expect(sub.pipeline_name).toBe('Tasks');
		expect((sub.notify as Record<string, unknown>).message).toBe('hi');
		// No -notify suffix when only one action is requested (single sub).
		expect(sub.name as string).toMatch(AUTO_NAME_REGEX);

		// fire_at should be ~5 minutes in the future (allowing for test latency).
		const fireMs = Date.parse(sub.fire_at as string);
		expect(Number.isFinite(fireMs)).toBe(true);
		expect(fireMs).toBeGreaterThanOrEqual(before + 5 * 60_000 - 1000);
		expect(fireMs).toBeLessThanOrEqual(after + 5 * 60_000 + 1000);
		expect(sub.fire_at as string).toMatch(TZ_SUFFIX_REGEX);
	});

	it('--in 1h --agent X --notify --prompt writes TWO subs sharing fire_at and pipeline_name', async () => {
		mockReadSessions.mockReturnValue([session({ id: 'agent-alpha', name: 'Alpha', projectRoot })]);

		await cueSchedule({
			in: '1h',
			agent: 'Alpha',
			notify: true,
			prompt: 'do X',
		});

		expect(processExitSpy).not.toHaveBeenCalled();

		const { parsed } = readCueYaml(projectRoot);
		const subs = parsed.subscriptions as Array<Record<string, unknown>>;
		expect(subs).toHaveLength(2);

		const promptSub = subs.find((s) => s.action === 'prompt')!;
		const notifySub = subs.find((s) => s.action === 'notify')!;
		expect(promptSub).toBeDefined();
		expect(notifySub).toBeDefined();

		// Same fire_at and pipeline_name across both.
		expect(promptSub.fire_at).toBe(notifySub.fire_at);
		expect(promptSub.pipeline_name).toBe('Tasks');
		expect(notifySub.pipeline_name).toBe('Tasks');

		// Auto-name with -prompt / -notify suffix in dual mode.
		expect(promptSub.name as string).toMatch(/^task-\d{4}-\d{2}-\d{2}-\d{4}-[a-f0-9]{8}-prompt$/);
		expect(notifySub.name as string).toMatch(/^task-\d{4}-\d{2}-\d{2}-\d{4}-[a-f0-9]{8}-notify$/);
		// Base name (sans suffix) matches across the pair.
		const promptBase = (promptSub.name as string).replace(/-prompt$/, '');
		const notifyBase = (notifySub.name as string).replace(/-notify$/, '');
		expect(promptBase).toBe(notifyBase);

		expect(promptSub.prompt).toBe('do X');
		expect((notifySub.notify as Record<string, unknown>).message).toBe('do X');
	});

	it('--list returns rows for every pending task across multiple agents', async () => {
		const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-schedule-create-beta-'));
		try {
			mockReadSessions.mockReturnValue([
				session({ id: 'agent-alpha', name: 'Alpha', projectRoot }),
				session({
					id: 'agent-beta',
					name: 'Beta',
					projectRoot: otherRoot,
					cwd: otherRoot,
				}),
			]);

			await cueSchedule({
				in: '5m',
				agent: 'Alpha',
				notify: true,
				message: 'first',
			});
			await cueSchedule({
				in: '1h',
				agent: 'Beta',
				prompt: 'second',
			});

			expect(processExitSpy).not.toHaveBeenCalled();
			consoleSpy.mockClear();

			await cueSchedule({ list: true, json: true });

			expect(processExitSpy).not.toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalledTimes(1);
			const rows = JSON.parse(consoleSpy.mock.calls[0][0] as string) as Array<
				Record<string, unknown>
			>;
			expect(rows).toHaveLength(2);
			// Sort order is ascending by fire_at - the 5m task should come first.
			expect(rows[0].agent_id).toBe('agent-alpha');
			expect(rows[0].action).toBe('notify');
			expect(rows[1].agent_id).toBe('agent-beta');
			expect(rows[1].action).toBe('prompt');
		} finally {
			fs.rmSync(otherRoot, { recursive: true, force: true });
		}
	});

	it('--cancel removes the named sub and exits 0', async () => {
		mockReadSessions.mockReturnValue([session({ id: 'agent-alpha', name: 'Alpha', projectRoot })]);

		await cueSchedule({
			in: '5m',
			agent: 'Alpha',
			notify: true,
			message: 'doomed',
			name: 'my-task',
		});

		expect(processExitSpy).not.toHaveBeenCalled();
		let { parsed } = readCueYaml(projectRoot);
		let subs = parsed.subscriptions as Array<Record<string, unknown>>;
		expect(subs).toHaveLength(1);
		expect(subs[0].name).toBe('my-task');

		consoleSpy.mockClear();
		await cueSchedule({ cancel: 'my-task' });
		expect(processExitSpy).not.toHaveBeenCalled();
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining(`Cancelled task 'my-task' on agent Alpha.`)
		);

		({ parsed } = readCueYaml(projectRoot));
		subs = (parsed.subscriptions as Array<Record<string, unknown>>) ?? [];
		expect(subs).toHaveLength(0);
	});

	// The CLI half of the Auto Run window's Schedule button: same payload, same
	// writer, so a run an agent schedules reads back like one a person did.
	describe('--auto-run', () => {
		function writeDoc(name: string): string {
			const dir = path.join(projectRoot, '.maestro', 'playbooks');
			fs.mkdirSync(dir, { recursive: true });
			const file = path.join(dir, name);
			fs.writeFileSync(file, '- [ ] ship it\n');
			return file;
		}

		it('writes an autorun sub pinned to the absolute document paths', async () => {
			mockReadSessions.mockReturnValue([
				session({ id: 'agent-alpha', name: 'Alpha', projectRoot }),
			]);
			const doc = writeDoc('ship-it.md');

			await cueSchedule({ in: '2h', agent: 'Alpha', autoRun: [doc] });

			expect(processExitSpy).not.toHaveBeenCalled();
			const subs = readCueYaml(projectRoot).parsed.subscriptions as Array<Record<string, unknown>>;
			expect(subs).toHaveLength(1);
			expect(subs[0]).toMatchObject({
				event: 'time.once',
				action: 'autorun',
				agent_id: 'agent-alpha',
				// Kept on a failed launch without --keep-on-failure being passed.
				self_destruct_on_failure: false,
				auto_run: { documents: [doc] },
			});
			expect(subs[0].label).toBe('Auto Run: ship-it.md');
		});

		it('carries every run option the Auto Run window can schedule', async () => {
			mockReadSessions.mockReturnValue([
				session({ id: 'agent-alpha', name: 'Alpha', projectRoot }),
			]);
			const doc = writeDoc('nightly.md');

			await cueSchedule({
				in: '2h',
				agent: 'Alpha',
				autoRun: [doc],
				prompt: 'Work the list',
				resetOnCompletion: true,
				maxLoops: '3',
				model: 'opus',
				effort: 'high',
				perDocument: true,
				ignoreModelHints: true,
			});

			const subs = readCueYaml(projectRoot).parsed.subscriptions as Array<Record<string, unknown>>;
			// One sub: with --auto-run the prompt is the run's instructions, not a
			// second prompt subscription.
			expect(subs).toHaveLength(1);
			expect(subs[0].auto_run).toEqual({
				documents: [doc],
				reset_on_completion: [true],
				prompt: 'Work the list',
				// --max-loops implies --loop.
				loop_enabled: true,
				max_loops: 3,
				model: 'opus',
				effort: 'high',
				task_selection_mode: 'document',
				ignore_model_hints: true,
			});
		});

		it('schedules the run into a worktree created when it fires', async () => {
			mockReadSessions.mockReturnValue([
				session({ id: 'agent-alpha', name: 'Alpha', projectRoot }),
			]);
			const doc = writeDoc('ship-it.md');

			await cueSchedule({
				in: '2h',
				agent: 'Alpha',
				autoRun: [doc],
				worktreeBranch: 'nightly',
				baseBranch: 'rc',
				createPr: true,
			});

			expect(processExitSpy).not.toHaveBeenCalled();
			const subs = readCueYaml(projectRoot).parsed.subscriptions as Array<Record<string, unknown>>;
			expect((subs[0].auto_run as Record<string, unknown>).worktree).toEqual({
				mode: 'create-new',
				branch: 'nightly',
				base_branch: 'rc',
				create_pr: true,
			});
		});

		// Every write has a read: what was scheduled, and where it will run, comes
		// back from --list.
		it('reports the Auto Run payload, worktree included, in --list --json', async () => {
			mockReadSessions.mockReturnValue([
				session({ id: 'agent-alpha', name: 'Alpha', projectRoot }),
			]);
			const doc = writeDoc('ship-it.md');
			await cueSchedule({ in: '2h', agent: 'Alpha', autoRun: [doc], worktreeBranch: 'nightly' });
			consoleSpy.mockClear();

			await cueSchedule({ list: true, json: true });

			const rows = JSON.parse(consoleSpy.mock.calls[0][0] as string) as Array<
				Record<string, unknown>
			>;
			expect(rows).toHaveLength(1);
			expect(rows[0].action).toBe('autorun');
			expect(rows[0].auto_run).toEqual({
				documents: [doc],
				worktree: { mode: 'create-new', branch: 'nightly' },
			});
		});

		it('schedules the run into an already-open worktree agent, by name', async () => {
			mockReadSessions.mockReturnValue([
				session({ id: 'agent-alpha', name: 'Alpha', projectRoot }),
				session({ id: 'agent-wt', name: 'nightly', projectRoot: '/projects/alpha-wt/nightly' }),
			]);
			const doc = writeDoc('ship-it.md');

			await cueSchedule({ in: '2h', agent: 'Alpha', autoRun: [doc], worktreeAgent: 'nightly' });

			const subs = readCueYaml(projectRoot).parsed.subscriptions as Array<Record<string, unknown>>;
			expect((subs[0].auto_run as Record<string, unknown>).worktree).toEqual({
				mode: 'existing-open',
				agent_id: 'agent-wt',
			});
		});

		it('schedules the run into a worktree already on disk', async () => {
			mockReadSessions.mockReturnValue([
				session({ id: 'agent-alpha', name: 'Alpha', projectRoot }),
			]);
			const doc = writeDoc('ship-it.md');
			const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-schedule-wt-'));

			try {
				await cueSchedule({ in: '2h', agent: 'Alpha', autoRun: [doc], worktreePath });

				const subs = readCueYaml(projectRoot).parsed.subscriptions as Array<
					Record<string, unknown>
				>;
				expect((subs[0].auto_run as Record<string, unknown>).worktree).toEqual({
					mode: 'existing-closed',
					path: worktreePath,
				});
			} finally {
				fs.rmSync(worktreePath, { recursive: true, force: true });
			}
		});

		it('writes the auto-resume settings', async () => {
			mockReadSessions.mockReturnValue([
				session({ id: 'agent-alpha', name: 'Alpha', projectRoot }),
			]);
			const doc = writeDoc('ship-it.md');

			await cueSchedule({
				in: '2h',
				agent: 'Alpha',
				autoRun: [doc],
				autoResume: false,
				autoResumeAfter: '10',
				maxAutoResumes: '3',
			});

			const subs = readCueYaml(projectRoot).parsed.subscriptions as Array<Record<string, unknown>>;
			expect(subs[0].auto_run).toMatchObject({
				auto_resume_on_error: false,
				auto_resume_after_min: 10,
				max_auto_resumes: 3,
			});
		});

		it('refuses more than one way of naming the worktree', async () => {
			processExitSpy.mockImplementation(() => {
				throw new Error('process.exit');
			});
			mockReadSessions.mockReturnValue([
				session({ id: 'agent-alpha', name: 'Alpha', projectRoot }),
			]);
			const doc = writeDoc('ship-it.md');

			await expect(
				cueSchedule({
					in: '2h',
					agent: 'Alpha',
					autoRun: [doc],
					worktreeBranch: 'nightly',
					worktreeAgent: 'nightly',
				})
			).rejects.toThrow('process.exit');

			expect(consoleErrorSpy.mock.calls[0]?.[0] as string).toMatch(/pass only one of/);
			expect(fs.existsSync(path.join(projectRoot, '.maestro', 'cue.yaml'))).toBe(false);
		});

		it('refuses a worktree agent or path that cannot be found, writing nothing', async () => {
			processExitSpy.mockImplementation(() => {
				throw new Error('process.exit');
			});
			mockReadSessions.mockReturnValue([
				session({ id: 'agent-alpha', name: 'Alpha', projectRoot }),
			]);
			const doc = writeDoc('ship-it.md');

			await expect(
				cueSchedule({ in: '2h', agent: 'Alpha', autoRun: [doc], worktreeAgent: 'gone' })
			).rejects.toThrow('process.exit');
			await expect(
				cueSchedule({
					in: '2h',
					agent: 'Alpha',
					autoRun: [doc],
					worktreePath: path.join(projectRoot, 'no-such-worktree'),
				})
			).rejects.toThrow('process.exit');

			const messages = consoleErrorSpy.mock.calls.map((call) => call[0] as string);
			expect(messages[0]).toMatch(/worktree agent "gone" not found/);
			expect(messages[1]).toMatch(/--worktree-path: .* does not exist/);
			expect(fs.existsSync(path.join(projectRoot, '.maestro', 'cue.yaml'))).toBe(false);
		});

		it('refuses a worktree option with no worktree named', async () => {
			processExitSpy.mockImplementation(() => {
				throw new Error('process.exit');
			});
			mockReadSessions.mockReturnValue([
				session({ id: 'agent-alpha', name: 'Alpha', projectRoot }),
			]);
			const doc = writeDoc('ship-it.md');

			await expect(
				cueSchedule({ in: '2h', agent: 'Alpha', autoRun: [doc], createPr: true })
			).rejects.toThrow('process.exit');

			expect(consoleErrorSpy.mock.calls[0]?.[0] as string).toMatch(/--create-pr requires/);
		});

		it('refuses --no-auto-resume without --auto-run', async () => {
			processExitSpy.mockImplementation(() => {
				throw new Error('process.exit');
			});
			mockReadSessions.mockReturnValue([
				session({ id: 'agent-alpha', name: 'Alpha', projectRoot }),
			]);

			await expect(
				cueSchedule({ in: '2h', agent: 'Alpha', prompt: 'hello', autoResume: false })
			).rejects.toThrow('process.exit');

			expect(consoleErrorSpy.mock.calls[0]?.[0] as string).toMatch(
				/--no-auto-resume requires --auto-run/
			);
		});

		it('refuses a document that does not exist, writing nothing', async () => {
			processExitSpy.mockImplementation(() => {
				throw new Error('process.exit');
			});
			mockReadSessions.mockReturnValue([
				session({ id: 'agent-alpha', name: 'Alpha', projectRoot }),
			]);

			await expect(
				cueSchedule({
					in: '2h',
					agent: 'Alpha',
					autoRun: [path.join(projectRoot, 'missing.md')],
				})
			).rejects.toThrow('process.exit');

			expect(consoleErrorSpy.mock.calls[0]?.[0] as string).toMatch(/does not exist/);
			expect(fs.existsSync(path.join(projectRoot, '.maestro', 'cue.yaml'))).toBe(false);
		});

		it('refuses --notify alongside --auto-run', async () => {
			processExitSpy.mockImplementation(() => {
				throw new Error('process.exit');
			});
			mockReadSessions.mockReturnValue([
				session({ id: 'agent-alpha', name: 'Alpha', projectRoot }),
			]);
			const doc = writeDoc('ship-it.md');

			await expect(
				cueSchedule({ in: '2h', agent: 'Alpha', autoRun: [doc], notify: true })
			).rejects.toThrow('process.exit');

			expect(consoleErrorSpy.mock.calls[0]?.[0] as string).toMatch(
				/--auto-run cannot be combined with --notify/
			);
			expect(fs.existsSync(path.join(projectRoot, '.maestro', 'cue.yaml'))).toBe(false);
		});

		// `--model` and `--effort` are shared with the prompt run's model choice
		// (`tier` / `model` / `effort` on the subscription). With --auto-run they
		// describe the run and must stay inside its payload.
		it('keeps --model and --effort inside the Auto Run payload, off the subscription', async () => {
			mockReadSessions.mockReturnValue([
				session({ id: 'agent-alpha', name: 'Alpha', projectRoot }),
			]);
			const doc = writeDoc('nightly.md');

			// `max` is a provider effort word, not low | medium | high: the Auto Run
			// payload takes it as given, the subscription-level field would not.
			await cueSchedule({ in: '2h', agent: 'Alpha', autoRun: [doc], model: 'opus', effort: 'max' });

			const subs = readCueYaml(projectRoot).parsed.subscriptions as Array<Record<string, unknown>>;
			expect(subs).toHaveLength(1);
			expect(subs[0].auto_run).toMatchObject({ model: 'opus', effort: 'max' });
			expect(subs[0]).not.toHaveProperty('model');
			expect(subs[0]).not.toHaveProperty('effort');
			expect(subs[0]).not.toHaveProperty('tier');
		});

		it('refuses --tier alongside --auto-run', async () => {
			processExitSpy.mockImplementation(() => {
				throw new Error('process.exit');
			});
			mockReadSessions.mockReturnValue([
				session({ id: 'agent-alpha', name: 'Alpha', projectRoot }),
			]);
			const doc = writeDoc('nightly.md');

			await expect(
				cueSchedule({ in: '2h', agent: 'Alpha', autoRun: [doc], tier: 'high' })
			).rejects.toThrow('process.exit');

			expect(consoleErrorSpy.mock.calls[0]?.[0] as string).toMatch(
				/--tier cannot be combined with --auto-run/
			);
			expect(fs.existsSync(path.join(projectRoot, '.maestro', 'cue.yaml'))).toBe(false);
		});

		it('refuses an Auto Run option passed without --auto-run', async () => {
			processExitSpy.mockImplementation(() => {
				throw new Error('process.exit');
			});
			mockReadSessions.mockReturnValue([
				session({ id: 'agent-alpha', name: 'Alpha', projectRoot }),
			]);

			await expect(
				cueSchedule({ in: '2h', agent: 'Alpha', prompt: 'hello', loop: true })
			).rejects.toThrow('process.exit');

			expect(consoleErrorSpy.mock.calls[0]?.[0] as string).toMatch(/--loop requires --auto-run/);
		});
	});

	describe('--tier / --model / --effort on a prompt run', () => {
		it('writes the model choice on the subscription when there is no --auto-run', async () => {
			mockReadSessions.mockReturnValue([
				session({ id: 'agent-alpha', name: 'Alpha', projectRoot }),
			]);

			await cueSchedule({
				in: '2h',
				agent: 'Alpha',
				prompt: 'Review it',
				model: 'opus',
				effort: 'low',
			});

			const subs = readCueYaml(projectRoot).parsed.subscriptions as Array<Record<string, unknown>>;
			expect(subs).toHaveLength(1);
			expect(subs[0]).toMatchObject({ action: 'prompt', model: 'opus', effort: 'low' });
			expect(subs[0]).not.toHaveProperty('auto_run');
		});

		it('writes a tier, and refuses an effort outside low | medium | high', async () => {
			mockReadSessions.mockReturnValue([
				session({ id: 'agent-alpha', name: 'Alpha', projectRoot }),
			]);

			await cueSchedule({ in: '2h', agent: 'Alpha', prompt: 'Review it', tier: 'high' });
			const subs = readCueYaml(projectRoot).parsed.subscriptions as Array<Record<string, unknown>>;
			expect(subs[0]).toMatchObject({ tier: 'high' });

			processExitSpy.mockImplementation(() => {
				throw new Error('process.exit');
			});
			await expect(
				cueSchedule({ in: '2h', agent: 'Alpha', prompt: 'Review it', effort: 'max' })
			).rejects.toThrow('process.exit');
			expect(consoleErrorSpy.mock.calls[0]?.[0] as string).toMatch(/--effort must be one of/);
		});
	});

	it('missing --agent exits 1 with a useful error', async () => {
		processExitSpy.mockImplementation(() => {
			throw new Error('process.exit');
		});
		mockReadSessions.mockReturnValue([]);

		await expect(cueSchedule({ in: '5m', notify: true, message: 'hi' })).rejects.toThrow(
			'process.exit'
		);

		expect(processExitSpy).toHaveBeenCalledWith(1);
		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('--agent'));
		// No file should be written when validation fails before the write.
		expect(fs.existsSync(path.join(projectRoot, '.maestro', 'cue.yaml'))).toBe(false);
	});

	it('neither --prompt nor --notify exits 1 with a useful error', async () => {
		processExitSpy.mockImplementation(() => {
			throw new Error('process.exit');
		});
		mockReadSessions.mockReturnValue([session({ id: 'agent-alpha', name: 'Alpha', projectRoot })]);

		await expect(cueSchedule({ in: '5m', agent: 'Alpha' })).rejects.toThrow('process.exit');

		expect(processExitSpy).toHaveBeenCalledWith(1);
		const errMsg = consoleErrorSpy.mock.calls[0]?.[0] as string;
		expect(errMsg).toMatch(/--prompt|--notify/);
		expect(fs.existsSync(path.join(projectRoot, '.maestro', 'cue.yaml'))).toBe(false);
	});

	it('rejects a create whose name already exists in cue.yaml (exit 1, file unchanged)', async () => {
		mockReadSessions.mockReturnValue([session({ id: 'agent-alpha', name: 'Alpha', projectRoot })]);

		// First create succeeds.
		await cueSchedule({
			in: '5m',
			agent: 'Alpha',
			notify: true,
			message: 'first',
			name: 'dup-task',
		});
		expect(processExitSpy).not.toHaveBeenCalled();
		expect((readCueYaml(projectRoot).parsed.subscriptions as unknown[]).length).toBe(1);

		// Second create reusing the name must fail loudly - otherwise a later
		// --cancel would delete both (removeSubscriptionFromYaml keys on name).
		processExitSpy.mockImplementation(() => {
			throw new Error('process.exit');
		});
		await expect(
			cueSchedule({ in: '10m', agent: 'Alpha', notify: true, message: 'second', name: 'dup-task' })
		).rejects.toThrow('process.exit');

		expect(processExitSpy).toHaveBeenCalledWith(1);
		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('already exists'));
		// File still holds exactly the original sub.
		const subs = readCueYaml(projectRoot).parsed.subscriptions as Array<Record<string, unknown>>;
		expect(subs).toHaveLength(1);
		expect(subs[0].name).toBe('dup-task');
	});

	it('--at "YYYY-MM-DD HH:MM" (naive local) converts to ISO-8601 with TZ marker', async () => {
		mockReadSessions.mockReturnValue([session({ id: 'agent-alpha', name: 'Alpha', projectRoot })]);

		// Use a year safely in the future so the validator (if it ever rejects
		// past timestamps) stays happy. The exact local-vs-UTC conversion is
		// system-dependent - we only assert the resulting ISO string carries a
		// recognizable timezone suffix.
		await cueSchedule({
			at: '2099-12-15 14:30',
			agent: 'Alpha',
			notify: true,
			message: 'future',
		});

		expect(processExitSpy).not.toHaveBeenCalled();
		const { parsed } = readCueYaml(projectRoot);
		const sub = (parsed.subscriptions as Array<Record<string, unknown>>)[0];
		expect(sub.fire_at as string).toMatch(TZ_SUFFIX_REGEX);
	});
});
