/**
 * The Playbook Launch record store, against a real temp directory: what it writes, the one running
 * launch per agent, the per-file write queue, the record cap, and how it reads a damaged file.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

const { mockLogger, mockCaptureException } = vi.hoisted(() => ({
	mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	mockCaptureException: vi.fn(
		async (_error: Error | unknown, _extra?: Record<string, unknown>) => {}
	),
}));

vi.mock('../../../main/utils/logger', () => ({ logger: mockLogger }));
vi.mock('../../../main/utils/sentry', () => ({ captureException: mockCaptureException }));

import {
	MAX_LAUNCH_RECORDS,
	PLAYBOOK_LAUNCHES_FILE,
	createPlaybookLaunchStore,
	getPlaybookLaunchStore,
	type NewPlaybookLaunch,
	type PlaybookLaunchStore,
	type PlaybookLaunchUpdate,
} from '../../../main/stores/playbookLaunchStore';
import {
	MarketplaceLaunchBusyError,
	type PlaybookLaunchCompletion,
	type PlaybookLaunchRecord,
} from '../../../shared/marketplace-types';

let dataDir: string;
let filePath: string;
let store: PlaybookLaunchStore;
let nowSpy: MockInstance<() => number>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function newLaunch(overrides: Partial<NewPlaybookLaunch> = {}): NewPlaybookLaunch {
	return {
		playbookId: 'research-market',
		playbookTitle: 'Market Research',
		sessionId: 'agent-1',
		folderRelativePath: 'research-market-launch-20261111-090000',
		autoRunFolderPath: '/projects/app/.maestro/playbooks',
		spec: {
			inputs: [{ name: 'MARKET_TOPIC', label: 'Market topic', type: 'text', required: true }],
			outro: { summary: 'Mapped {{MARKET_TOPIC}}.', nextSteps: [] },
		},
		savedPlaybookId: 'saved-1',
		keepSavedPlaybook: false,
		values: { MARKET_TOPIC: 'EV chargers', DEPTH_BATCH: 3, SCOPE: ['us', 'eu'] },
		...overrides,
	};
}

/** A finished record as it sits in the file, for seeding. */
function storedRecord(overrides: Partial<PlaybookLaunchRecord> = {}): PlaybookLaunchRecord {
	return {
		...newLaunch(),
		launchId: 'launch-1',
		status: 'completed',
		startedAt: 1_000,
		finishedAt: 2_000,
		...overrides,
	};
}

function seedFile(launches: unknown[]): void {
	fs.writeFileSync(filePath, JSON.stringify({ version: 1, launches }));
}

function readStoredFile(): { version: number; launches: PlaybookLaunchRecord[] } {
	return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function storedIds(): string[] {
	return readStoredFile().launches.map((launch) => launch.launchId);
}

/** Create a launch whose start time is `time`. */
function createAt(time: number, overrides: Partial<NewPlaybookLaunch> = {}) {
	nowSpy.mockReturnValue(time);
	return store.createLaunch(newLaunch(overrides));
}

const completion: PlaybookLaunchCompletion = {
	completedTasks: 4,
	totalTasks: 4,
	elapsedTimeMs: 61_000,
	totalCostUsd: 0.42,
	wasStopped: false,
};

beforeEach(() => {
	vi.clearAllMocks();
	nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playbook-launch-store-'));
	filePath = path.join(dataDir, PLAYBOOK_LAUNCHES_FILE);
	store = createPlaybookLaunchStore(filePath);
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('createLaunch', () => {
	it('records a running launch with a new id, this app run and the start time', async () => {
		const record = await createAt(5_000);

		expect(record).toEqual({
			...newLaunch(),
			launchId: expect.stringMatching(UUID),
			status: 'running',
			appRunId: expect.stringMatching(UUID),
			startedAt: 5_000,
		});
	});

	it('stamps every launch of this app run with the same app run id', async () => {
		const first = await store.createLaunch(newLaunch({ sessionId: 'agent-1' }));
		const second = await createPlaybookLaunchStore(filePath).createLaunch(
			newLaunch({ sessionId: 'agent-2' })
		);

		expect(second.appRunId).toBe(first.appRunId);
	});

	it('keeps the Auto Run folder, the SSH remote and the spec that cleanup and the outro need', async () => {
		const spec = {
			inputs: [],
			cleanup: 'keep' as const,
			outro: { summary: 'Done.', nextSteps: ['Read the report'], reportFile: 'REPORT.md' },
		};

		const record = await store.createLaunch(
			newLaunch({ autoRunFolderPath: '~/playbooks', sshRemoteId: 'remote-1', spec })
		);

		expect(record).toMatchObject({
			autoRunFolderPath: '~/playbooks',
			sshRemoteId: 'remote-1',
			spec,
		});
		expect(readStoredFile().launches).toEqual([record]);
	});

	it.each([[undefined], ['']])(
		'writes no SSH remote for an agent on this computer (%j)',
		async (sshRemoteId) => {
			const record = await store.createLaunch(newLaunch({ sshRemoteId }));

			expect(record).not.toHaveProperty('sshRemoteId');
			expect(readStoredFile().launches[0]).not.toHaveProperty('sshRemoteId');
		}
	);

	it('writes a versioned file and leaves no temp file behind', async () => {
		const record = await store.createLaunch(newLaunch());

		expect(readStoredFile()).toEqual({ version: 1, launches: [record] });
		expect(fs.readdirSync(dataDir)).toEqual([PLAYBOOK_LAUNCHES_FILE]);
	});

	it('keeps the record for a new store object on the file, as after a restart', async () => {
		const record = await store.createLaunch(newLaunch());

		await expect(createPlaybookLaunchStore(filePath).getLaunch(record.launchId)).resolves.toEqual(
			record
		);
	});

	it('gives every launch its own id', async () => {
		const first = await store.createLaunch(newLaunch({ sessionId: 'agent-1' }));
		const second = await store.createLaunch(newLaunch({ sessionId: 'agent-2' }));

		expect(first.launchId).not.toBe(second.launchId);
	});

	it('sets the id, the status, the app run and the start time itself, whatever the caller passes', async () => {
		nowSpy.mockReturnValue(7_000);
		const smuggled = {
			...newLaunch(),
			launchId: 'chosen-by-caller',
			status: 'completed',
			appRunId: 'an-earlier-app-run',
			startedAt: 1,
			cleanup: 'done',
		} as NewPlaybookLaunch;

		const record = await store.createLaunch(smuggled);

		expect(record.launchId).not.toBe('chosen-by-caller');
		expect(record.status).toBe('running');
		expect(record.appRunId).toMatch(UUID);
		expect(record.appRunId).not.toBe('an-earlier-app-run');
		expect(record.startedAt).toBe(7_000);
		expect(record).not.toHaveProperty('cleanup');
		expect(readStoredFile().launches).toEqual([record]);
	});

	it('refuses a second launch while the agent runs one, and writes nothing', async () => {
		const running = await store.createLaunch(newLaunch());
		const before = fs.readFileSync(filePath, 'utf-8');

		const refusal = store.createLaunch(
			newLaunch({ playbookId: 'development-security', playbookTitle: 'Security' })
		);

		await expect(refusal).rejects.toBeInstanceOf(MarketplaceLaunchBusyError);
		await expect(refusal).rejects.toMatchObject({
			runningLaunchId: running.launchId,
			message: expect.stringContaining('"Market Research"'),
		});
		expect(fs.readFileSync(filePath, 'utf-8')).toBe(before);
	});

	it('starts a new launch on the agent once the earlier one has finished', async () => {
		const first = await createAt(1_000);
		await store.updateLaunch(first.launchId, { status: 'completed', finishedAt: 2_000 });

		const second = await createAt(3_000);

		expect(second.status).toBe('running');
		expect(storedIds()).toEqual([first.launchId, second.launchId]);
	});

	it('runs launches on different agents at the same time', async () => {
		await store.createLaunch(newLaunch({ sessionId: 'agent-1' }));
		await store.createLaunch(newLaunch({ sessionId: 'agent-2' }));

		const launches = await store.listLaunches();
		expect(launches.map((launch) => launch.status)).toEqual(['running', 'running']);
	});

	it('lets only one of two simultaneous launches on one agent through', async () => {
		const results = await Promise.allSettled([
			store.createLaunch(newLaunch()),
			store.createLaunch(newLaunch({ playbookId: 'development-security' })),
		]);

		const fulfilled = results.filter((result) => result.status === 'fulfilled');
		const rejected = results.filter((result) => result.status === 'rejected');
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
			MarketplaceLaunchBusyError
		);
		expect(readStoredFile().launches).toHaveLength(1);
	});
});

describe('updateLaunch', () => {
	it('applies the update, keeps every other field and persists the result', async () => {
		const created = await store.createLaunch(newLaunch());
		const update = {
			status: 'completed' as const,
			finishedAt: 9_000,
			completion,
			cleanup: 'done' as const,
		};

		const updated = await store.updateLaunch(created.launchId, update);

		expect(updated).toEqual({ ...created, ...update });
		await expect(createPlaybookLaunchStore(filePath).getLaunch(created.launchId)).resolves.toEqual(
			updated
		);
	});

	it('keeps a field whose update is undefined', async () => {
		const created = await store.createLaunch(newLaunch());

		const updated = await store.updateLaunch(created.launchId, {
			status: undefined,
			cleanup: 'kept',
		});

		expect(updated).toMatchObject({ status: 'running', cleanup: 'kept' });
		await expect(store.findRunningLaunchForSession('agent-1')).resolves.toEqual(updated);
	});

	it('never changes a field outside the update fields, such as the launch folder', async () => {
		const created = await store.createLaunch(newLaunch());
		const smuggled = {
			status: 'completed',
			folderRelativePath: '../../elsewhere',
			sessionId: 'agent-2',
			launchId: 'renamed',
		} as PlaybookLaunchUpdate;

		const updated = await store.updateLaunch(created.launchId, smuggled);

		expect(updated).toEqual({ ...created, status: 'completed' });
		expect(readStoredFile().launches).toEqual([updated]);
	});

	it('leaves the other launches as they are', async () => {
		const first = await store.createLaunch(newLaunch({ sessionId: 'agent-1' }));
		const second = await store.createLaunch(newLaunch({ sessionId: 'agent-2' }));

		await store.updateLaunch(first.launchId, { status: 'failed', finishedAt: 2_000 });

		await expect(store.getLaunch(second.launchId)).resolves.toEqual(second);
	});

	it('resolves undefined for an unknown id and creates no file', async () => {
		await expect(store.updateLaunch('no-such-launch', { status: 'failed' })).resolves.toBe(
			undefined
		);
		expect(fs.existsSync(filePath)).toBe(false);
	});

	it('resolves undefined for an unknown id and leaves the file as it was', async () => {
		await store.createLaunch(newLaunch());
		const before = fs.readFileSync(filePath, 'utf-8');

		await expect(store.updateLaunch('no-such-launch', { status: 'failed' })).resolves.toBe(
			undefined
		);
		expect(fs.readFileSync(filePath, 'utf-8')).toBe(before);
	});

	it('keeps both changes when two launches are updated at once', async () => {
		// One file holds every launch. A queue key per launch would let these two read the same
		// file, and the later write would drop the earlier change.
		const first = await store.createLaunch(newLaunch({ sessionId: 'agent-1' }));
		const second = await store.createLaunch(newLaunch({ sessionId: 'agent-2' }));

		await Promise.all([
			store.updateLaunch(first.launchId, { status: 'completed', finishedAt: 2_000 }),
			store.updateLaunch(second.launchId, { status: 'stopped', finishedAt: 3_000 }),
		]);

		const stored = readStoredFile().launches;
		expect(stored.find((launch) => launch.launchId === first.launchId)?.status).toBe('completed');
		expect(stored.find((launch) => launch.launchId === second.launchId)?.status).toBe('stopped');
	});

	it('keeps both changes when one launch is updated twice at once', async () => {
		const created = await store.createLaunch(newLaunch());

		await Promise.all([
			store.updateLaunch(created.launchId, {
				status: 'completed',
				finishedAt: 2_000,
				completion,
			}),
			store.updateLaunch(created.launchId, { cleanup: 'kept' }),
		]);

		await expect(store.getLaunch(created.launchId)).resolves.toMatchObject({
			status: 'completed',
			completion,
			cleanup: 'kept',
		});
	});

	it('keeps fields of a record that this build does not know', async () => {
		seedFile([{ ...storedRecord({ status: 'running' }), addedByANewerBuild: { kept: true } }]);

		await store.updateLaunch('launch-1', { status: 'completed', finishedAt: 2_000 });

		expect(readStoredFile().launches[0]).toMatchObject({
			status: 'completed',
			addedByANewerBuild: { kept: true },
		});
	});

	it('records why cleanup could not remove the launch folder', async () => {
		const created = await store.createLaunch(newLaunch());

		const updated = await store.updateLaunch(created.launchId, {
			cleanup: 'failed',
			cleanupError: 'Refusing to delete the launch folder "x": it is not a folder',
		});

		expect(updated).toEqual({
			...created,
			cleanup: 'failed',
			cleanupError: 'Refusing to delete the launch folder "x": it is not a folder',
		});
		expect(readStoredFile().launches).toEqual([updated]);
	});
});

describe('finishLaunch', () => {
	const finish = {
		status: 'completed' as const,
		finishedAt: 9_000,
		completion,
	};

	it('ends a running launch, persists it and frees its agent', async () => {
		const created = await store.createLaunch(newLaunch());

		const result = await store.finishLaunch(created.launchId, finish);

		expect(result).toEqual({ record: { ...created, ...finish }, finished: true });
		expect(readStoredFile().launches).toEqual([{ ...created, ...finish }]);
		await expect(store.findRunningLaunchForSession('agent-1')).resolves.toBeUndefined();
	});

	it('changes nothing for a launch that has already ended, and says so', async () => {
		seedFile([storedRecord({ status: 'stopped', finishedAt: 2_000 })]);
		const before = fs.readFileSync(filePath, 'utf-8');

		const result = await store.finishLaunch('launch-1', finish);

		expect(result).toEqual({
			record: storedRecord({ status: 'stopped', finishedAt: 2_000 }),
			finished: false,
		});
		expect(fs.readFileSync(filePath, 'utf-8')).toBe(before);
	});

	it('resolves undefined for an unknown id and creates no file', async () => {
		await expect(store.finishLaunch('no-such-launch', finish)).resolves.toBeUndefined();
		expect(fs.existsSync(filePath)).toBe(false);
	});

	it('lets only one of two reports of the same run end it', async () => {
		const created = await store.createLaunch(newLaunch());

		const results = await Promise.all([
			store.finishLaunch(created.launchId, { status: 'completed', finishedAt: 2_000, completion }),
			store.finishLaunch(created.launchId, {
				status: 'stopped',
				finishedAt: 3_000,
				completion: { ...completion, wasStopped: true },
			}),
		]);

		expect(results.map((result) => result?.finished)).toEqual([true, false]);
		// The second sees the record as the first left it.
		expect(results[1]?.record).toEqual(results[0]?.record);
		await expect(store.getLaunch(created.launchId)).resolves.toMatchObject({
			status: 'completed',
			finishedAt: 2_000,
		});
	});

	it('never changes a field outside the update fields, such as the launch folder', async () => {
		const created = await store.createLaunch(newLaunch());
		const smuggled = {
			...finish,
			folderRelativePath: '../../elsewhere',
			autoRunFolderPath: '/',
			sessionId: 'agent-2',
		} as typeof finish;

		const result = await store.finishLaunch(created.launchId, smuggled);

		expect(result?.record).toEqual({ ...created, ...finish });
	});

	it('treats a launch an earlier app run left running as ended', async () => {
		seedFile([storedRecord({ status: 'running', appRunId: 'an-earlier-app-run' })]);

		const result = await store.finishLaunch('launch-1', finish);

		expect(result?.finished).toBe(false);
		expect(result?.record.status).toBe('failed');
	});
});

describe('getLaunch', () => {
	it('returns the launch with that id', async () => {
		const first = await store.createLaunch(newLaunch({ sessionId: 'agent-1' }));
		await store.createLaunch(newLaunch({ sessionId: 'agent-2' }));

		await expect(store.getLaunch(first.launchId)).resolves.toEqual(first);
	});

	it('returns undefined for an unknown id', async () => {
		await store.createLaunch(newLaunch());

		await expect(store.getLaunch('no-such-launch')).resolves.toBe(undefined);
	});

	it('reads a missing file as no launches and does not create it', async () => {
		await expect(store.getLaunch('launch-1')).resolves.toBe(undefined);
		expect(fs.existsSync(filePath)).toBe(false);
	});
});

describe('listLaunches', () => {
	it('lists the launches newest first', async () => {
		const oldest = await createAt(1_000, { sessionId: 'agent-1' });
		const newest = await createAt(3_000, { sessionId: 'agent-2' });
		const middle = await createAt(2_000, { sessionId: 'agent-3' });

		const launches = await store.listLaunches();

		expect(launches.map((launch) => launch.launchId)).toEqual([
			newest.launchId,
			middle.launchId,
			oldest.launchId,
		]);
	});

	it('puts the record written later first when two started at the same time', async () => {
		seedFile([
			storedRecord({ launchId: 'written-first', startedAt: 5_000 }),
			storedRecord({ launchId: 'written-second', startedAt: 5_000 }),
		]);

		const launches = await store.listLaunches();

		expect(launches.map((launch) => launch.launchId)).toEqual(['written-second', 'written-first']);
	});

	it('lists only the launches of one agent', async () => {
		const mine = await createAt(1_000, { sessionId: 'agent-1' });
		await createAt(2_000, { sessionId: 'agent-2' });

		const launches = await store.listLaunches({ sessionId: 'agent-1' });

		expect(launches).toEqual([mine]);
	});

	it('applies the limit after the agent filter, keeping the newest', async () => {
		seedFile([
			storedRecord({ launchId: 'a-1', sessionId: 'agent-1', startedAt: 1_000 }),
			storedRecord({ launchId: 'a-2', sessionId: 'agent-1', startedAt: 2_000 }),
			storedRecord({ launchId: 'b-1', sessionId: 'agent-2', startedAt: 3_000 }),
			storedRecord({ launchId: 'a-3', sessionId: 'agent-1', startedAt: 4_000 }),
		]);

		const launches = await store.listLaunches({ sessionId: 'agent-1', limit: 2 });

		expect(launches.map((launch) => launch.launchId)).toEqual(['a-3', 'a-2']);
	});

	it('returns every launch when the limit is larger than the list', async () => {
		seedFile([storedRecord({ launchId: 'only' })]);

		const launches = await store.listLaunches({ limit: 50 });

		expect(launches.map((launch) => launch.launchId)).toEqual(['only']);
	});

	it('reads a missing file as no launches and does not create it', async () => {
		await expect(store.listLaunches()).resolves.toEqual([]);
		expect(fs.existsSync(filePath)).toBe(false);
	});

	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		'rejects a limit of %s',
		async (limit) => {
			await expect(store.listLaunches({ limit })).rejects.toThrow(RangeError);
		}
	);
});

describe('findRunningLaunchForSession', () => {
	it('finds the running launch of the agent', async () => {
		const mine = await store.createLaunch(newLaunch({ sessionId: 'agent-1' }));
		await store.createLaunch(newLaunch({ sessionId: 'agent-2' }));

		await expect(store.findRunningLaunchForSession('agent-1')).resolves.toEqual(mine);
	});

	it('ignores launches that have finished', async () => {
		const created = await store.createLaunch(newLaunch());
		await store.updateLaunch(created.launchId, { status: 'stopped', finishedAt: 2_000 });

		await expect(store.findRunningLaunchForSession('agent-1')).resolves.toBe(undefined);
	});

	it('returns undefined for an agent with no launches', async () => {
		await store.createLaunch(newLaunch({ sessionId: 'agent-1' }));

		await expect(store.findRunningLaunchForSession('agent-2')).resolves.toBe(undefined);
	});

	it('returns the newest when the file holds two running launches for the agent', async () => {
		seedFile([
			storedRecord({ launchId: 'newer', status: 'running', startedAt: 2_000 }),
			storedRecord({ launchId: 'older', status: 'running', startedAt: 1_000 }),
		]);

		await expect(store.findRunningLaunchForSession('agent-1')).resolves.toMatchObject({
			launchId: 'newer',
		});
	});
});

describe('record cap', () => {
	/** `count` finished records on separate agents. File order is the reverse of start order. */
	function finishedRecords(count: number): PlaybookLaunchRecord[] {
		return Array.from({ length: count }, (_, i) =>
			storedRecord({ launchId: `launch-${i}`, sessionId: `agent-${i}`, startedAt: 10_000 + i })
		).reverse();
	}

	it('drops the finished launch that started first when a new launch goes over the cap', async () => {
		seedFile(finishedRecords(MAX_LAUNCH_RECORDS));

		const created = await createAt(99_000, { sessionId: 'agent-new' });

		const ids = storedIds();
		expect(ids).toHaveLength(MAX_LAUNCH_RECORDS);
		// launch-0 started first, although it is the LAST record in the file.
		expect(ids).not.toContain('launch-0');
		expect(ids).toContain('launch-1');
		expect(ids).toContain(created.launchId);
	});

	it('never drops a running launch, however old', async () => {
		const records = finishedRecords(MAX_LAUNCH_RECORDS);
		records[records.length - 1] = storedRecord({
			launchId: 'old-but-running',
			sessionId: 'agent-old',
			status: 'running',
			startedAt: 1,
		});
		seedFile(records);

		await createAt(99_000, { sessionId: 'agent-new' });

		const ids = storedIds();
		expect(ids).toHaveLength(MAX_LAUNCH_RECORDS);
		expect(ids).toContain('old-but-running');
		// The finished launch that started first goes instead.
		expect(ids).not.toContain('launch-1');
	});

	it('keeps every running launch even when they alone pass the cap', async () => {
		seedFile(
			Array.from({ length: MAX_LAUNCH_RECORDS }, (_, i) =>
				storedRecord({
					launchId: `running-${i}`,
					sessionId: `agent-${i}`,
					status: 'running',
					startedAt: 10_000 + i,
				})
			)
		);

		await createAt(99_000, { sessionId: 'agent-new' });

		expect(storedIds()).toHaveLength(MAX_LAUNCH_RECORDS + 1);
	});

	it('trims a file that is already over the cap back to the cap', async () => {
		seedFile(finishedRecords(MAX_LAUNCH_RECORDS + 5));

		await createAt(99_000, { sessionId: 'agent-new' });

		const ids = storedIds();
		expect(ids).toHaveLength(MAX_LAUNCH_RECORDS);
		for (let i = 0; i <= 5; i++) expect(ids).not.toContain(`launch-${i}`);
		expect(ids).toContain('launch-6');
	});

	it('drops nothing while the file is under the cap', async () => {
		seedFile(finishedRecords(MAX_LAUNCH_RECORDS - 1));

		await createAt(99_000, { sessionId: 'agent-new' });

		expect(storedIds()).toHaveLength(MAX_LAUNCH_RECORDS);
		expect(storedIds()).toContain('launch-0');
	});

	it('does not drop records on update', async () => {
		seedFile([
			...finishedRecords(MAX_LAUNCH_RECORDS),
			storedRecord({ launchId: 'running', status: 'running', startedAt: 50_000 }),
		]);

		await store.updateLaunch('running', { status: 'completed', finishedAt: 60_000 });

		expect(storedIds()).toHaveLength(MAX_LAUNCH_RECORDS + 1);
	});
});

describe('reading a damaged file', () => {
	function sidecars(): string[] {
		return fs.readdirSync(dataDir).filter((name) => name.startsWith('playbook-launches.corrupt-'));
	}

	it('moves bytes that are not JSON aside, reports them, and starts empty', async () => {
		const torn = '{"version":1,"launches":[{"launchId":"launch-1","sess';
		fs.writeFileSync(filePath, torn);

		await expect(store.listLaunches()).resolves.toEqual([]);

		expect(fs.existsSync(filePath)).toBe(false);
		const preserved = sidecars();
		expect(preserved).toHaveLength(1);
		expect(fs.readFileSync(path.join(dataDir, preserved[0]), 'utf-8')).toBe(torn);
		expect(mockCaptureException).toHaveBeenCalledOnce();

		// The next launch starts a clean file.
		const record = await store.createLaunch(newLaunch());
		expect(readStoredFile()).toEqual({ version: 1, launches: [record] });
	});

	it.each([
		['a list', '[]'],
		['null', 'null'],
		['a launches field that is not a list', '{"version":1,"launches":"many"}'],
	])('reads a document that is %s as empty, with a warning', async (_label, text) => {
		fs.writeFileSync(filePath, text);

		await expect(store.listLaunches()).resolves.toEqual([]);

		expect(mockLogger.warn).toHaveBeenCalledWith(
			expect.stringContaining('has no list of launches'),
			'PlaybookLaunchStore'
		);
		expect(mockCaptureException).not.toHaveBeenCalled();
	});

	it('reads an empty object as no launches, without a warning', async () => {
		fs.writeFileSync(filePath, '{}');

		await expect(store.listLaunches()).resolves.toEqual([]);

		expect(mockLogger.warn).not.toHaveBeenCalled();
	});

	it('skips records with missing or invalid fields and keeps the rest', async () => {
		const valid = storedRecord({ launchId: 'valid' });
		seedFile([
			valid,
			null,
			'launch',
			{ ...valid, launchId: '' },
			{ ...valid, launchId: 'bad-session', sessionId: 42 },
			{ ...valid, launchId: 'bad-status', status: 'paused' },
			{ ...valid, launchId: 'bad-start', startedAt: 'yesterday' },
		]);

		await expect(store.listLaunches()).resolves.toEqual([valid]);

		expect(mockLogger.warn).toHaveBeenCalledWith(
			expect.stringContaining('ignored 6 launch record(s)'),
			'PlaybookLaunchStore'
		);
	});

	it('reads a file that starts with a byte order mark', async () => {
		const record = storedRecord();
		fs.writeFileSync(filePath, `﻿${JSON.stringify({ version: 1, launches: [record] })}`);

		await expect(store.listLaunches()).resolves.toEqual([record]);
	});

	it('passes on a read error other than a missing file', async () => {
		fs.mkdirSync(filePath);

		await expect(store.listLaunches()).rejects.toMatchObject({ code: 'EISDIR' });
		expect(mockCaptureException).not.toHaveBeenCalled();
	});
});

describe('launches an earlier app run left running', () => {
	/** A launch that was running when Maestro quit or crashed */
	const interrupted = () =>
		storedRecord({
			launchId: 'interrupted',
			status: 'running',
			appRunId: 'an-earlier-app-run',
			finishedAt: undefined,
		});

	it('marks it failed on the next operation, saves that, and leaves its end time unset', async () => {
		seedFile([interrupted()]);

		const read = await store.getLaunch('interrupted');

		expect(read).toEqual({ ...interrupted(), status: 'failed' });
		expect(read).not.toHaveProperty('finishedAt');
		expect(readStoredFile().launches).toEqual([{ ...interrupted(), status: 'failed' }]);
		expect(mockLogger.info).toHaveBeenCalledWith(
			`${PLAYBOOK_LAUNCHES_FILE}: marked 1 launch(es) as failed, because Maestro quit or crashed while they ran`,
			'PlaybookLaunchStore'
		);
	});

	it('no longer holds its agent', async () => {
		seedFile([interrupted()]);

		await expect(store.findRunningLaunchForSession('agent-1')).resolves.toBeUndefined();
		await expect(store.createLaunch(newLaunch())).resolves.toMatchObject({ status: 'running' });
	});

	it('leaves a running launch of this app run alone, for any store object', async () => {
		const running = await store.createLaunch(newLaunch());

		await expect(
			createPlaybookLaunchStore(filePath).findRunningLaunchForSession('agent-1')
		).resolves.toEqual(running);
	});

	it('leaves a running launch that names no app run alone', async () => {
		const unnamed = storedRecord({ status: 'running', finishedAt: undefined });
		seedFile([unnamed]);

		await expect(store.findRunningLaunchForSession('agent-1')).resolves.toEqual(unnamed);
	});

	it('leaves finished launches of an earlier app run alone, and writes nothing when none was interrupted', async () => {
		const finished = storedRecord({ appRunId: 'an-earlier-app-run' });
		seedFile([finished]);
		const before = fs.readFileSync(filePath, 'utf-8');

		await expect(store.listLaunches()).resolves.toEqual([finished]);

		expect(fs.readFileSync(filePath, 'utf-8')).toBe(before);
		expect(mockLogger.info).not.toHaveBeenCalled();
	});
});

describe('getPlaybookLaunchStore', () => {
	it('keeps the records in playbook-launches.json in the userData folder', async () => {
		const app = { getPath: vi.fn((_name: string) => dataDir) };

		const record = await getPlaybookLaunchStore(app).createLaunch(newLaunch());

		expect(app.getPath).toHaveBeenCalledWith('userData');
		expect(readStoredFile().launches).toEqual([record]);
	});

	it('shares one write queue with every other store object on the same file', async () => {
		const app = { getPath: (_name: string) => dataDir };
		const first = await store.createLaunch(newLaunch({ sessionId: 'agent-1' }));
		const second = await store.createLaunch(newLaunch({ sessionId: 'agent-2' }));
		// Another spelling of the same path (relative, unless the temp folder is on another drive).
		const other = createPlaybookLaunchStore(path.relative(process.cwd(), filePath));

		await Promise.all([
			getPlaybookLaunchStore(app).updateLaunch(first.launchId, { status: 'completed' }),
			other.updateLaunch(second.launchId, { status: 'failed' }),
		]);

		const stored = readStoredFile().launches;
		expect(stored.find((launch) => launch.launchId === first.launchId)?.status).toBe('completed');
		expect(stored.find((launch) => launch.launchId === second.launchId)?.status).toBe('failed');
	});
});
