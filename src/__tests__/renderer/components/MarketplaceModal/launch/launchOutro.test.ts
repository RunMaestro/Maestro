/**
 * Tests for launchOutro: what the Playbook Launch outro says about a launch that ended.
 *
 * The rules are pure, so the cases that matter are the words and the numbers: how a run ended
 * (completed, or stopped with its documents kept), the stats, what cleanup did, and the author's
 * own text filled from the launch RECORD with the built-ins the run saw (the agent's name, the
 * Auto Run folder, the day the run started).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	buildLaunchOutro,
	launchBulletList,
	launchOutroBuiltins,
} from '../../../../../renderer/components/MarketplaceModal/launch/launchOutro';
import type { PlaybookLaunchRecord } from '../../../../../shared/marketplace-types';
import type { TemplateSessionInfo } from '../../../../../shared/templateVariables';
import { createMockLaunchRecord } from '../../../../helpers';

/** 2026-11-09 15:00 UTC: the same calendar day in every time zone the suite can run in. */
const STARTED_AT = Date.UTC(2026, 10, 9, 15, 0, 0);

const ALPHA: TemplateSessionInfo = {
	id: 'session-1',
	name: 'Alpha',
	toolType: 'claude-code',
	cwd: '/work/alpha',
};

function completed(overrides: Partial<PlaybookLaunchRecord> = {}): PlaybookLaunchRecord {
	return createMockLaunchRecord({
		status: 'completed',
		startedAt: STARTED_AT,
		finishedAt: STARTED_AT + 125_000,
		completion: {
			completedTasks: 6,
			totalTasks: 6,
			elapsedTimeMs: 125_000,
			totalCostUsd: 1.25,
			wasStopped: false,
		},
		cleanup: 'done',
		...overrides,
	});
}

function stopped(overrides: Partial<PlaybookLaunchRecord> = {}): PlaybookLaunchRecord {
	return completed({
		status: 'stopped',
		completion: {
			completedTasks: 3,
			totalTasks: 6,
			elapsedTimeMs: 61_000,
			totalCostUsd: 0.4,
			wasStopped: true,
		},
		cleanup: 'skipped-stopped',
		...overrides,
	});
}

afterEach(() => {
	vi.useRealTimers();
});

describe('launchOutroBuiltins', () => {
	it('names the agent that ran the playbook', () => {
		const builtins = launchOutroBuiltins(completed(), ALPHA);

		expect(builtins.AGENT_NAME).toBe('Alpha');
		expect(builtins.AGENT_PATH).toBe('/work/alpha');
		expect(builtins.AGENT_ID).toBe('session-1');
	});

	it('reads {{AUTORUN_FOLDER}} as the folder the launch imported into, as the run did', () => {
		const builtins = launchOutroBuiltins(completed({ autoRunFolderPath: '/runs/Auto Run Docs' }), {
			...ALPHA,
			autoRunFolderPath: '/somewhere/the/agent/moved/to',
		});

		expect(builtins.AUTORUN_FOLDER).toBe('/runs/Auto Run Docs');
	});

	it('reads {{DATE}} as the day the run started, not the day the outro is drawn', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2027-03-04T09:00:00Z'));

		const builtins = launchOutroBuiltins(completed(), ALPHA);

		expect(builtins.DATE).toBe('2026-11-09');
		expect(builtins.YEAR).toBe('2026');
	});

	it('still knows the folder and the day when the agent has been deleted', () => {
		const builtins = launchOutroBuiltins(completed({ autoRunFolderPath: '/runs/docs' }), undefined);

		expect(builtins.AUTORUN_FOLDER).toBe('/runs/docs');
		expect(builtins.DATE).toBe('2026-11-09');
		expect(builtins.AGENT_ID).toBe('session-1');
		expect(builtins.AGENT_NAME).toBe('');
	});
});

describe('buildLaunchOutro', () => {
	describe('the title', () => {
		it("is the author's title", () => {
			const view = buildLaunchOutro(
				completed({
					spec: {
						inputs: [],
						outro: { title: 'Market vault is ready', summary: 's', nextSteps: [] },
					},
				}),
				ALPHA
			);

			expect(view.title).toBe('Market vault is ready');
		});

		it('is the playbook title when the author gave none', () => {
			expect(buildLaunchOutro(completed({ playbookTitle: 'Market Research' }), ALPHA).title).toBe(
				'Market Research'
			);
		});

		it('is the playbook title when the author title is blank', () => {
			const view = buildLaunchOutro(
				completed({
					playbookTitle: 'Market Research',
					spec: { inputs: [], outro: { title: '   ', summary: 's', nextSteps: [] } },
				}),
				ALPHA
			);

			expect(view.title).toBe('Market Research');
		});

		it('has its tokens filled', () => {
			const view = buildLaunchOutro(
				completed({
					spec: {
						inputs: [],
						outro: { title: '{{AGENT_NAME}} is done', summary: 's', nextSteps: [] },
					},
				}),
				ALPHA
			);

			expect(view.title).toBe('Alpha is done');
		});
	});

	describe('how the run ended', () => {
		it('says completed for a run that finished', () => {
			expect(buildLaunchOutro(completed(), ALPHA).status).toEqual({
				tone: 'success',
				text: 'Completed',
			});
		});

		it('says a stopped run kept its documents so the person can resume', () => {
			expect(buildLaunchOutro(stopped(), ALPHA).status).toEqual({
				tone: 'warning',
				text: 'Stopped. The task documents were kept so you can resume.',
			});
		});

		it('says a launch that failed did not finish', () => {
			const view = buildLaunchOutro(
				createMockLaunchRecord({ status: 'failed', startedAt: STARTED_AT }),
				ALPHA
			);

			expect(view.status).toEqual({ tone: 'error', text: 'The launch did not finish.' });
		});

		it('says a launch that is still running is still running', () => {
			expect(buildLaunchOutro(createMockLaunchRecord(), ALPHA).status).toEqual({
				tone: 'dim',
				text: 'Still running.',
			});
		});
	});

	describe('the stats', () => {
		it('give tasks, time and cost', () => {
			expect(buildLaunchOutro(completed(), ALPHA).stats).toEqual([
				{ id: 'tasks', label: 'Tasks', value: '6 of 6' },
				{ id: 'time', label: 'Time', value: '2m 5s' },
				{ id: 'cost', label: 'Cost', value: '$1.25' },
			]);
		});

		it('count the tasks a stopped run got through', () => {
			expect(buildLaunchOutro(stopped(), ALPHA).stats).toEqual([
				{ id: 'tasks', label: 'Tasks', value: '3 of 6' },
				{ id: 'time', label: 'Time', value: '1m 1s' },
				{ id: 'cost', label: 'Cost', value: '$0.40' },
			]);
		});

		it('say Task for a run of one', () => {
			const view = buildLaunchOutro(
				completed({
					completion: {
						completedTasks: 1,
						totalTasks: 1,
						elapsedTimeMs: 45_000,
						wasStopped: false,
					},
				}),
				ALPHA
			);

			expect(view.stats[0]).toEqual({ id: 'tasks', label: 'Task', value: '1 of 1' });
		});

		it('leave the cost out when the run did not report one', () => {
			const view = buildLaunchOutro(
				completed({
					completion: {
						completedTasks: 2,
						totalTasks: 2,
						elapsedTimeMs: 3_000,
						wasStopped: false,
					},
				}),
				ALPHA
			);

			expect(view.stats.map((stat) => stat.id)).toEqual(['tasks', 'time']);
		});

		it.each([
			[0, '$0.00'],
			[0.004, '<$0.01'],
			[1234.5, '$1,234.50'],
		])('write a cost of %s as %s', (cost, text) => {
			const view = buildLaunchOutro(
				completed({
					completion: {
						completedTasks: 1,
						totalTasks: 1,
						elapsedTimeMs: 1_000,
						totalCostUsd: cost,
						wasStopped: false,
					},
				}),
				ALPHA
			);

			expect(view.stats.find((stat) => stat.id === 'cost')?.value).toBe(text);
		});

		it.each([
			[0, '0ms'],
			[45_000, '45s'],
			[330_000, '5m 30s'],
			[8_100_000, '2h 15m'],
		])('write a run time of %i ms as %s', (elapsedTimeMs, text) => {
			const view = buildLaunchOutro(
				completed({
					completion: { completedTasks: 1, totalTasks: 1, elapsedTimeMs, wasStopped: false },
				}),
				ALPHA
			);

			expect(view.stats.find((stat) => stat.id === 'time')?.value).toBe(text);
		});

		it('are empty when the launch never recorded how the run ended', () => {
			expect(buildLaunchOutro(createMockLaunchRecord({ status: 'failed' }), ALPHA).stats).toEqual(
				[]
			);
		});
	});

	describe("the author's text", () => {
		const spec = {
			inputs: [
				{ name: 'MARKET_TOPIC', label: 'Topic', type: 'text', required: true },
				{
					name: 'OUTPUT_FOLDER',
					label: 'Output',
					type: 'path',
					default: '{{AUTORUN_FOLDER}}/vault',
				},
				{ name: 'DEEP', label: 'Deep', type: 'boolean' },
			],
			outro: {
				title: 'Vault on {{MARKET_TOPIC}}',
				summary: 'The vault is in `{{OUTPUT_FOLDER}}`. Deep: {{DEEP}}. Ran on {{AGENT_NAME}}.',
				nextSteps: ['Open `{{OUTPUT_FOLDER}}/INDEX.md`.', 'Check {{DATE}}.'],
				files: [
					{ label: 'Index', path: '{{OUTPUT_FOLDER}}/INDEX.md' },
					{ label: 'Log', path: '{{AUTORUN_FOLDER}}/LOG_{{AGENT_NAME}}_{{DATE}}.md' },
				],
				reportFile: '{{OUTPUT_FOLDER}}/INDEX.md',
			},
		} as const;

		const record = () =>
			completed({
				autoRunFolderPath: '/runs/docs',
				// The shape a launch record keeps: the values the run was launched with.
				values: { MARKET_TOPIC: 'Edge AI', OUTPUT_FOLDER: '{{AUTORUN_FOLDER}}/vault', DEEP: true },
				spec: spec as never,
			});

		it('has the answers and the built-ins the run saw filled in', () => {
			const view = buildLaunchOutro(record(), ALPHA);

			expect(view.title).toBe('Vault on Edge AI');
			expect(view.summary).toBe('The vault is in `/runs/docs/vault`. Deep: yes. Ran on Alpha.');
			expect(view.nextSteps).toEqual(['Open `/runs/docs/vault/INDEX.md`.', 'Check 2026-11-09.']);
		});

		it('names the files to open and the report with their paths filled', () => {
			const view = buildLaunchOutro(record(), ALPHA);

			expect(view.files).toEqual([
				{ label: 'Index', path: '/runs/docs/vault/INDEX.md' },
				{ label: 'Log', path: '/runs/docs/LOG_Alpha_2026-11-09.md' },
			]);
			expect(view.reportFile).toBe('/runs/docs/vault/INDEX.md');
		});

		it('has no files and no report when the author names none', () => {
			const view = buildLaunchOutro(completed(), ALPHA);

			expect(view.files).toEqual([]);
			expect(view.reportFile).toBeUndefined();
			expect(view.nextSteps).toEqual([]);
		});

		it('leaves a token that is neither an answer nor a built-in as written, so a typo shows', () => {
			const view = buildLaunchOutro(
				completed({
					spec: { inputs: [], outro: { summary: 'See {{NOT_A_THING}}.', nextSteps: [] } },
				}),
				ALPHA
			);

			expect(view.summary).toBe('See {{NOT_A_THING}}.');
		});

		it("follows the launch's own copy of the block, whatever the manifest says now", () => {
			const view = buildLaunchOutro(
				completed({
					playbookTitle: 'Code Review',
					spec: {
						inputs: [],
						outro: { summary: 'As it was at launch.', nextSteps: ['Old step.'] },
					},
				}),
				ALPHA
			);

			expect(view.summary).toBe('As it was at launch.');
			expect(view.nextSteps).toEqual(['Old step.']);
		});

		it('names the file for the day the run started even when the outro opens days later', () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2027-01-01T00:00:00Z'));

			const view = buildLaunchOutro(record(), ALPHA);

			expect(view.files[1].path).toBe('/runs/docs/LOG_Alpha_2026-11-09.md');
		});
	});

	describe('what cleanup did', () => {
		it('says the documents were removed', () => {
			expect(buildLaunchOutro(completed({ cleanup: 'done' }), ALPHA).cleanup).toEqual({
				tone: 'dim',
				text: 'Cleanup: the task documents were removed.',
			});
		});

		it('says the documents were kept because the playbook asks to keep them', () => {
			const view = buildLaunchOutro(
				completed({ cleanup: 'kept', folderRelativePath: 'market-launch-1' }),
				ALPHA
			);

			expect(view.cleanup).toEqual({
				tone: 'dim',
				text: 'Cleanup: the task documents were kept in "market-launch-1", as this playbook asks.',
			});
		});

		it('says the documents were kept because the person saved the playbook to reuse', () => {
			const view = buildLaunchOutro(
				completed({
					cleanup: 'kept',
					keepSavedPlaybook: true,
					folderRelativePath: 'market-launch-1',
				}),
				ALPHA
			);

			expect(view.cleanup?.text).toBe(
				'Cleanup: the task documents were kept in "market-launch-1", because you saved this playbook to reuse.'
			);
		});

		it('says cleanup was skipped for a stopped run, and where the documents are', () => {
			const view = buildLaunchOutro(stopped({ folderRelativePath: 'market-launch-1' }), ALPHA);

			expect(view.cleanup).toEqual({
				tone: 'dim',
				text: 'Cleanup: skipped, because the run was stopped. The task documents are in "market-launch-1".',
			});
		});

		it('says cleanup failed, with the reason, as an error', () => {
			const view = buildLaunchOutro(
				completed({
					cleanup: 'failed',
					cleanupError: 'EACCES: permission denied',
					folderRelativePath: 'market-launch-1',
				}),
				ALPHA
			);

			expect(view.cleanup).toEqual({
				tone: 'error',
				text: 'Cleanup: could not remove the task documents in "market-launch-1". EACCES: permission denied',
			});
		});

		it('says cleanup failed even when it gave no reason', () => {
			const view = buildLaunchOutro(
				completed({ cleanup: 'failed', folderRelativePath: 'market-launch-1' }),
				ALPHA
			);

			expect(view.cleanup?.text).toBe(
				'Cleanup: could not remove the task documents in "market-launch-1".'
			);
		});

		it('says nothing while cleanup has not run', () => {
			expect(buildLaunchOutro(completed({ cleanup: undefined }), ALPHA).cleanup).toBeUndefined();
		});
	});
});

describe('launchBulletList', () => {
	it('makes one bullet per step', () => {
		expect(launchBulletList(['Run `lifeos`.', 'Open the dashboard.'])).toBe(
			'- Run `lifeos`.\n- Open the dashboard.'
		);
	});

	it('keeps a step that runs over several lines under its bullet', () => {
		expect(launchBulletList(['First line\nsecond line', 'Next'])).toBe(
			'- First line\n  second line\n- Next'
		);
	});

	it('trims the space around a step', () => {
		expect(launchBulletList(['  padded  '])).toBe('- padded');
	});

	it('is empty for no steps', () => {
		expect(launchBulletList([])).toBe('');
	});
});
