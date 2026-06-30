import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
	appendAgentRunEvent,
	getAgentRun,
	getCampaign,
	listAgentRuns,
	listCampaigns,
	readAgentRunEvents,
	readAgentRuns,
	readCampaigns,
	readPianolaCampaigns,
	upsertAgentRun,
	upsertCampaign,
	writeAgentRuns,
	writeCampaigns,
	type AgentRun,
	type AgentRunEvent,
	type Campaign,
} from '../../../cli/services/agent-run-store';

const mockFs = vi.hoisted(() => ({
	configDir: '/config/Maestro',
	files: new Map<string, string>(),
	dirs: new Set<string>(),
}));

vi.mock('fs', () => ({
	existsSync: vi.fn((filePath: string) => {
		const key = String(filePath);
		return mockFs.files.has(key) || mockFs.dirs.has(key);
	}),
	mkdirSync: vi.fn((dirPath: string) => {
		mockFs.dirs.add(String(dirPath));
	}),
	readFileSync: vi.fn((filePath: string) => {
		const key = String(filePath);
		if (!mockFs.files.has(key)) {
			throw Object.assign(new Error('File not found'), { code: 'ENOENT' });
		}
		return mockFs.files.get(key);
	}),
	writeFileSync: vi.fn((filePath: string, content: string) => {
		mockFs.files.set(String(filePath), String(content));
	}),
	renameSync: vi.fn((fromPath: string, toPath: string) => {
		const fromKey = String(fromPath);
		const toKey = String(toPath);
		const content = mockFs.files.get(fromKey);
		if (content === undefined) {
			throw Object.assign(new Error('File not found'), { code: 'ENOENT' });
		}
		mockFs.files.set(toKey, content);
		mockFs.files.delete(fromKey);
	}),
	appendFileSync: vi.fn((filePath: string, content: string) => {
		const key = String(filePath);
		mockFs.files.set(key, `${mockFs.files.get(key) ?? ''}${content}`);
	}),
}));

vi.mock('../../../cli/services/storage', () => ({
	getConfigDirectory: vi.fn(() => mockFs.configDir),
}));

describe('agent-run-store', () => {
	const runsPath = path.join(mockFs.configDir, 'maestro-agent-runs.json');
	const eventsPath = path.join(mockFs.configDir, 'maestro-agent-run-events.jsonl');
	const campaignsPath = path.join(mockFs.configDir, 'maestro-campaigns.json');
	const pianolaPlansPath = path.join(mockFs.configDir, 'maestro-pianola-plans.json');

	const run = (overrides: Partial<AgentRun> = {}): AgentRun => ({
		id: 'run-1',
		createdAt: 100,
		updatedAt: 100,
		provider: 'claude-code',
		status: 'queued',
		artifacts: [],
		touchedFiles: [],
		checks: [],
		reviews: [],
		...overrides,
	});

	const event = (overrides: Partial<AgentRunEvent> = {}): AgentRunEvent => ({
		id: 'event-1',
		runId: 'run-1',
		timestamp: 200,
		type: 'status',
		...overrides,
	});

	const campaign = (overrides: Partial<Campaign> = {}): Campaign => ({
		id: 'campaign-1',
		title: 'Campaign One',
		createdAt: 100,
		updatedAt: 100,
		status: 'queued',
		runIds: [],
		tasks: [],
		...overrides,
	});

	beforeEach(() => {
		vi.clearAllMocks();
		mockFs.files.clear();
		mockFs.dirs.clear();
		mockFs.dirs.add(mockFs.configDir);
	});

	it('returns empty arrays when store files are missing', () => {
		expect(readAgentRuns()).toEqual([]);
		expect(readAgentRunEvents()).toEqual([]);
		expect(readCampaigns()).toEqual([]);
	});

	it('returns empty arrays for malformed JSON snapshots', () => {
		mockFs.files.set(runsPath, '{not valid json');
		mockFs.files.set(campaignsPath, '{not valid json');

		expect(readAgentRuns()).toEqual([]);
		expect(readCampaigns()).toEqual([]);
	});

	it('drops invalid run entries while preserving future provider metadata', () => {
		mockFs.files.set(
			runsPath,
			JSON.stringify({
				runs: [
					run({ provider: 'future-provider', metadata: { adapter: 'alpha' }, source: 'plugin-x' }),
					{ id: 'missing-status', createdAt: 1, updatedAt: 1, provider: 'claude-code' },
					{
						id: 'bad-time',
						createdAt: null,
						updatedAt: 1,
						provider: 'claude-code',
						status: 'queued',
					},
					null,
				],
			})
		);

		const result = readAgentRuns();

		expect(result).toHaveLength(1);
		expect(result[0].provider).toBe('future-provider');
		expect(result[0].metadata).toEqual({ adapter: 'alpha' });
		expect(result[0].source).toBe('plugin-x');
	});

	it('atomically writes runs and replaces an existing run by id', () => {
		writeAgentRuns([run({ status: 'queued' })]);

		const updated = upsertAgentRun(run({ status: 'running', updatedAt: 300 }));
		const persisted = JSON.parse(mockFs.files.get(runsPath) ?? '{"runs":[]}') as {
			runs: AgentRun[];
		};

		expect(updated.status).toBe('running');
		expect(persisted.runs).toHaveLength(1);
		expect(persisted.runs[0].status).toBe('running');
		expect(getAgentRun('run-1')?.updatedAt).toBe(300);
		expect(
			vi.mocked(fs.writeFileSync).mock.calls.some(([filePath]) => String(filePath).includes('.tmp'))
		).toBe(true);
		expect(vi.mocked(fs.renameSync)).toHaveBeenCalled();
	});

	it('preserves future run fields when replacing an existing run by id', () => {
		mockFs.files.set(
			runsPath,
			JSON.stringify({
				runs: [{ ...run({ status: 'queued' }), futureField: 'keep-me' }],
			})
		);

		upsertAgentRun(run({ status: 'running', updatedAt: 300 }));

		const persisted = JSON.parse(mockFs.files.get(runsPath) ?? '{"runs":[]}') as {
			runs: Array<AgentRun & { futureField?: string }>;
		};
		expect(persisted.runs).toHaveLength(1);
		expect(persisted.runs[0]).toMatchObject({
			status: 'running',
			updatedAt: 300,
			futureField: 'keep-me',
		});
	});

	it('rejects malformed child evidence on writes instead of dropping it', () => {
		const invalid = {
			...run(),
			checks: [{ status: 'passed' }],
		} as unknown as AgentRun;

		expect(() => writeAgentRuns([invalid])).toThrow('Invalid agent run');
		expect(mockFs.files.has(runsPath)).toBe(false);
	});

	it('rejects malformed existing run snapshots during upsert instead of dropping them', () => {
		mockFs.files.set(
			runsPath,
			JSON.stringify({
				runs: [
					run({ id: 'valid-run' }),
					{ ...run({ id: 'bad-run' }), checks: [{ status: 'passed' }] },
				],
			})
		);

		expect(() => upsertAgentRun(run({ id: 'new-run' }))).toThrow('Invalid runs entry');
		const persisted = JSON.parse(mockFs.files.get(runsPath) ?? '{"runs":[]}') as {
			runs: AgentRun[];
		};
		expect(persisted.runs.map((entry) => entry.id)).toEqual(['valid-run', 'bad-run']);
	});

	it('lists runs sorted by recency with status, campaign, and limit filters', () => {
		writeAgentRuns([
			run({ id: 'old', status: 'running', updatedAt: 10 }),
			run({ id: 'new-not-campaign', status: 'running', updatedAt: 50 }),
			run({ id: 'new-campaign', status: 'running', updatedAt: 40 }),
			run({
				id: 'completed-campaign',
				status: 'completed',
				updatedAt: 60,
				metadata: { campaignId: 'campaign-1' },
			}),
		]);
		writeCampaigns([
			campaign({
				id: 'campaign-1',
				runIds: ['old'],
				tasks: [
					{
						id: 'task-1',
						title: 'Task One',
						status: 'queued',
						dependsOn: [],
						runId: 'new-campaign',
					},
				],
			}),
		]);

		const result = listAgentRuns({ status: 'running', campaignId: 'campaign-1', limit: 2 });

		expect(result.map((entry) => entry.id)).toEqual(['new-campaign', 'old']);
	});

	it('appends events as JSONL and updates an existing run status and timestamp', () => {
		writeAgentRuns([run({ status: 'running', updatedAt: 100 })]);

		appendAgentRunEvent(event({ status: 'completed', timestamp: 500 }));
		appendAgentRunEvent(event({ id: 'event-2', runId: 'other-run', timestamp: 600 }));

		const lines = (mockFs.files.get(eventsPath) ?? '').trim().split('\n');
		expect(lines.map((line) => JSON.parse(line).id)).toEqual(['event-1', 'event-2']);
		expect(readAgentRunEvents('run-1').map((entry) => entry.id)).toEqual(['event-1']);
		expect(getAgentRun('run-1')).toMatchObject({ status: 'completed', updatedAt: 500 });
	});

	it('preserves future run fields when updating a run from an event', () => {
		mockFs.files.set(
			runsPath,
			JSON.stringify({
				runs: [{ ...run({ status: 'running', updatedAt: 100 }), futureField: 'keep-me' }],
			})
		);

		appendAgentRunEvent(event({ status: 'completed', timestamp: 500 }));

		const persisted = JSON.parse(mockFs.files.get(runsPath) ?? '{"runs":[]}') as {
			runs: Array<AgentRun & { futureField?: string }>;
		};
		expect(persisted.runs[0]).toMatchObject({
			status: 'completed',
			updatedAt: 500,
			futureField: 'keep-me',
		});
	});

	it('does not append events when strict run snapshot update would fail', () => {
		mockFs.files.set(
			runsPath,
			JSON.stringify({
				runs: [run(), { ...run({ id: 'bad-run' }), reviews: [{ status: 'open' }] }],
			})
		);

		expect(() => appendAgentRunEvent(event({ status: 'completed' }))).toThrow('Invalid runs entry');
		expect(mockFs.files.get(eventsPath)).toBeUndefined();
		expect(getAgentRun('run-1')).toMatchObject({ status: 'queued', updatedAt: 100 });
	});

	it('drops malformed JSONL lines and invalid events during event reads', () => {
		mockFs.files.set(
			eventsPath,
			[
				JSON.stringify(event({ id: 'older', timestamp: 50 })),
				'not json',
				JSON.stringify({ id: 'bad', runId: 'run-1', timestamp: 60 }),
				JSON.stringify(event({ id: 'newer', timestamp: 70 })),
			].join('\n')
		);

		expect(readAgentRunEvents('run-1').map((entry) => entry.id)).toEqual(['older', 'newer']);
	});

	it('drops invalid campaigns and invalid tasks while preserving metadata', () => {
		mockFs.files.set(
			campaignsPath,
			JSON.stringify({
				campaigns: [
					{
						id: 'campaign-1',
						title: 'Campaign One',
						createdAt: 100,
						updatedAt: 100,
						status: 'queued',
						runIds: [],
						metadata: { adapter: 'future' },
						tasks: [
							{ id: 'task-1', title: 'Task One', status: 'queued', dependsOn: [] },
							{ id: 'bad-task', title: 'Bad Task', status: 'not-real', dependsOn: [] },
						],
					},
					{ id: 'bad-campaign', title: 'Bad', createdAt: 1, updatedAt: 1, status: 'not-real' },
				],
			})
		);

		const result = readCampaigns();

		expect(result).toHaveLength(1);
		expect(result[0].metadata).toEqual({ adapter: 'future' });
		expect(result[0].tasks.map((task) => task.id)).toEqual(['task-1']);
	});

	it('rejects malformed campaign tasks on writes instead of dropping them', () => {
		const invalid = {
			...campaign(),
			tasks: [{ id: 'task-1', title: 'Bad Task', status: 'not-real', dependsOn: [] }],
		} as unknown as Campaign;

		expect(() => writeCampaigns([invalid])).toThrow('Invalid campaign');
		expect(mockFs.files.has(campaignsPath)).toBe(false);
	});

	it('rejects malformed existing campaign snapshots during upsert instead of dropping them', () => {
		mockFs.files.set(
			campaignsPath,
			JSON.stringify({
				campaigns: [
					campaign({ id: 'valid-campaign' }),
					{
						...campaign({ id: 'bad-campaign' }),
						tasks: [{ id: 'task-1', title: 'Bad Task', status: 'not-real', dependsOn: [] }],
					},
				],
			})
		);

		expect(() => upsertCampaign(campaign({ id: 'new-campaign' }))).toThrow(
			'Invalid campaigns entry'
		);
		const persisted = JSON.parse(mockFs.files.get(campaignsPath) ?? '{"campaigns":[]}') as {
			campaigns: Campaign[];
		};
		expect(persisted.campaigns.map((entry) => entry.id)).toEqual([
			'valid-campaign',
			'bad-campaign',
		]);
	});

	it('preserves future campaign fields when replacing an existing campaign by id', () => {
		mockFs.files.set(
			campaignsPath,
			JSON.stringify({
				campaigns: [{ ...campaign({ title: 'Original' }), futureField: 'keep-me' }],
			})
		);

		upsertCampaign(campaign({ title: 'Updated', updatedAt: 300 }));

		const persisted = JSON.parse(mockFs.files.get(campaignsPath) ?? '{"campaigns":[]}') as {
			campaigns: Array<Campaign & { futureField?: string }>;
		};
		expect(persisted.campaigns).toHaveLength(1);
		expect(persisted.campaigns[0]).toMatchObject({
			title: 'Updated',
			updatedAt: 300,
			futureField: 'keep-me',
		});
	});

	it('atomically writes campaigns, replaces by id, and lists with filters', () => {
		writeCampaigns([
			campaign({ id: 'campaign-old', status: 'running', updatedAt: 10 }),
			campaign({ id: 'campaign-keep', status: 'running', updatedAt: 20 }),
			campaign({ id: 'campaign-archived', status: 'archived', updatedAt: 30 }),
		]);

		upsertCampaign(
			campaign({ id: 'campaign-old', title: 'Updated', status: 'running', updatedAt: 40 })
		);

		expect(getCampaign('campaign-old')?.title).toBe('Updated');
		expect(listCampaigns({ status: 'running', limit: 1 }).map((entry) => entry.id)).toEqual([
			'campaign-old',
		]);
		expect(vi.mocked(fs.renameSync)).toHaveBeenCalled();
	});

	it('surfaces Pianola plans as read-only campaign records', () => {
		mockFs.files.set(
			pianolaPlansPath,
			JSON.stringify({
				plans: [
					{
						id: 'plan-1',
						title: 'Autonomous plan',
						createdAt: 100,
						tasks: [
							{
								id: 'setup',
								title: 'Setup',
								prompt: 'prepare',
								dependsOn: [],
								status: 'done',
								agentType: 'claude-code',
								cwd: '/repo',
							},
							{
								id: 'build',
								title: 'Build',
								prompt: 'build',
								dependsOn: ['setup'],
								status: 'pending',
							},
						],
					},
				],
			})
		);

		expect(readPianolaCampaigns().map((entry) => entry.id)).toEqual(['pianola:plan-1']);
		expect(getCampaign('pianola:plan-1')?.tasks[0]).toMatchObject({
			status: 'passed',
			prompt: 'prepare',
			agentType: 'claude-code',
			cwd: '/repo',
		});
		expect(listCampaigns({ status: 'queued' }).map((entry) => entry.id)).toEqual([
			'pianola:plan-1',
		]);
		mockFs.files.set(
			campaignsPath,
			JSON.stringify({
				campaigns: [
					campaign({
						id: 'pianola:plan-1',
						title: 'Stale Shadow',
						status: 'running',
						updatedAt: 999,
					}),
				],
			})
		);

		expect(getCampaign('pianola:plan-1')?.title).toBe('Autonomous plan');
		expect(readCampaigns().map((entry) => entry.id)).toEqual(['pianola:plan-1']);
	});

	it('rejects native writes that would shadow read-only Pianola campaigns', () => {
		const bridged = campaign({ id: 'pianola:plan-1' });

		expect(() => writeCampaigns([bridged])).toThrow('Pianola campaign ids are read-only');
		expect(() => upsertCampaign(bridged)).toThrow('Pianola campaign ids are read-only');
		expect(mockFs.files.has(campaignsPath)).toBe(false);
	});

	it('rejects existing native snapshots that contain Pianola adapter ids during upsert', () => {
		mockFs.files.set(
			campaignsPath,
			JSON.stringify({
				campaigns: [campaign({ id: 'pianola:plan-1', title: 'Stale Shadow' })],
			})
		);

		expect(() => upsertCampaign(campaign({ id: 'campaign-2' }))).toThrow('Invalid campaigns entry');
	});
});
