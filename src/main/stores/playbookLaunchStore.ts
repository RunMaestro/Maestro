/**
 * Playbook Launch records, persisted in `userData/playbook-launches.json`.
 *
 * A launch is one run of a marketplace playbook started with Launch, from the Playbook Exchange or
 * the CLI. Its record lives in main so the CLI can read its status, the outro can be shown after a
 * restart, and cleanup knows the one folder it may delete. Main is the only process that reads or
 * writes the file; the renderer and the CLI reach the records through main. The file is local
 * metadata, so an SSH-remote agent changes nothing here. A record only names the launch folder,
 * wherever the agent's Auto Run folder is.
 *
 * Every operation, reads included, runs on one write-queue key per FILE, not per launch. One file
 * holds every record, so with a key per launch, two launches updated at once would read the same
 * base and the later write would drop the earlier change. Writes are atomic (temp file plus
 * rename). Bytes that are not JSON anyway (a disk fault, a hand edit) are moved aside by
 * `createStoreDeserializer` and the store starts empty, so one bad file cannot block every launch.
 *
 * The file keeps at most `MAX_LAUNCH_RECORDS` records. When a new launch goes over the cap, the
 * finished records that started first are dropped first. A running record is never dropped,
 * because its completion and cleanup still need it.
 *
 * A launch's Auto Run runs in the renderer of the app run that started it, and a quit or a crash
 * ends it. Each record names its app run (`appRunId`), and every operation first marks a record
 * that an earlier app run left `running` as `failed`, so an interrupted launch never holds its
 * agent or waits for a completion that cannot come.
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { App } from 'electron';

import {
	MarketplaceLaunchBusyError,
	type PlaybookLaunchRecord,
} from '../../shared/marketplace-types';
import { atomicWriteJson, createKeyedWriteQueue } from '../utils/atomic-json-store';
import { logger } from '../utils/logger';
import { createStoreDeserializer } from './corrupt-store-recovery';

export const PLAYBOOK_LAUNCHES_FILE = 'playbook-launches.json';

/** The most records the file keeps. See the module comment for which records go first. */
export const MAX_LAUNCH_RECORDS = 200;

const LOG_CONTEXT = 'PlaybookLaunchStore';

const LAUNCH_STATUSES: ReadonlySet<unknown> = new Set<PlaybookLaunchRecord['status']>([
	'running',
	'completed',
	'stopped',
	'failed',
]);

let appRunId: string | undefined;

/**
 * The id of this app run. A record still `running` under any other app run's id was interrupted
 * by a quit or a crash, because an Auto Run does not outlive the app run that started it. Made on
 * first use, so importing this module has no side effect.
 */
function currentAppRunId(): string {
	appRunId ??= randomUUID();
	return appRunId;
}

/**
 * What a caller supplies when a launch starts. The store sets `launchId`, `status` (`running`),
 * `appRunId` and `startedAt`.
 */
export type NewPlaybookLaunch = Pick<
	PlaybookLaunchRecord,
	| 'playbookId'
	| 'playbookTitle'
	| 'sessionId'
	| 'folderRelativePath'
	| 'autoRunFolderPath'
	| 'sshRemoteId'
	| 'spec'
	| 'savedPlaybookId'
	| 'keepSavedPlaybook'
	| 'values'
>;

/**
 * The fields that change after a launch starts. A field left out, or `undefined`, keeps its value.
 * All other fields are fixed when the launch is created, including the folder that cleanup may
 * delete. A launch never goes back to `running`: Run again starts a new launch.
 */
export interface PlaybookLaunchUpdate {
	status?: Exclude<PlaybookLaunchRecord['status'], 'running'>;
	finishedAt?: number;
	completion?: PlaybookLaunchRecord['completion'];
	cleanup?: PlaybookLaunchRecord['cleanup'];
}

export interface ListLaunchesOptions {
	/** Only the launches of this agent */
	sessionId?: string;
	/** At most this many records. Must be a positive whole number. */
	limit?: number;
}

export interface PlaybookLaunchStore {
	/**
	 * Record a new running launch. Rejects with `MarketplaceLaunchBusyError` when the agent already
	 * runs a launch. The check and the write are one queued step, so two launches on one agent
	 * cannot both pass it.
	 */
	createLaunch(launch: NewPlaybookLaunch): Promise<PlaybookLaunchRecord>;
	/** Apply `update` to one launch. Resolves `undefined`, and writes nothing, for an unknown id. */
	updateLaunch(
		launchId: string,
		update: PlaybookLaunchUpdate
	): Promise<PlaybookLaunchRecord | undefined>;
	getLaunch(launchId: string): Promise<PlaybookLaunchRecord | undefined>;
	/** Launches, newest first. Rejects with a `RangeError` when `limit` is not a positive whole number. */
	listLaunches(options?: ListLaunchesOptions): Promise<PlaybookLaunchRecord[]>;
	/** The running launch of an agent, if it has one. */
	findRunningLaunchForSession(sessionId: string): Promise<PlaybookLaunchRecord | undefined>;
}

interface PlaybookLaunchesFile {
	version: 1;
	launches: PlaybookLaunchRecord[];
}

/** One chain per file, shared by every store object on that file. */
const fileQueue = createKeyedWriteQueue();

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Checks the fields the store reads. A record without them cannot be found, ordered or capped. */
function isLaunchRecord(value: unknown): value is PlaybookLaunchRecord {
	return (
		isPlainObject(value) &&
		typeof value.launchId === 'string' &&
		value.launchId.length > 0 &&
		typeof value.sessionId === 'string' &&
		LAUNCH_STATUSES.has(value.status) &&
		Number.isFinite(value.startedAt)
	);
}

async function readLaunches(filePath: string): Promise<PlaybookLaunchRecord[]> {
	let text: string;
	try {
		text = await fs.readFile(filePath, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
	// For bytes that are not JSON, the deserializer moves the file aside, reports it and returns {}.
	const data = createStoreDeserializer<unknown>(filePath)(text);
	const stored = isPlainObject(data) ? (data.launches ?? []) : undefined;
	if (!Array.isArray(stored)) {
		logger.warn(
			`${path.basename(filePath)} has no list of launches. It is read as empty, and the next launch replaces it.`,
			LOG_CONTEXT
		);
		return [];
	}
	const launches = stored.filter(isLaunchRecord);
	if (launches.length < stored.length) {
		logger.warn(
			`${path.basename(filePath)}: ignored ${stored.length - launches.length} launch record(s) with missing or invalid fields`,
			LOG_CONTEXT
		);
	}
	return launches;
}

function writeLaunches(filePath: string, launches: PlaybookLaunchRecord[]): Promise<void> {
	const file: PlaybookLaunchesFile = { version: 1, launches };
	return atomicWriteJson(filePath, file);
}

/** A record still `running` under an app run that has ended. A record without an app run is left alone. */
function isInterrupted(launch: PlaybookLaunchRecord): boolean {
	return (
		launch.status === 'running' &&
		launch.appRunId !== undefined &&
		launch.appRunId !== currentAppRunId()
	);
}

/**
 * Mark every launch an earlier app run left `running` as `failed`, and save that. Its folder and
 * saved playbook stay, because no cleanup ran, and `finishedAt` stays unset, because nobody saw the
 * run end.
 */
async function settleInterruptedLaunches(
	filePath: string,
	launches: PlaybookLaunchRecord[]
): Promise<PlaybookLaunchRecord[]> {
	const interrupted = launches.filter(isInterrupted).length;
	if (interrupted === 0) return launches;
	const settled = launches.map((launch) =>
		isInterrupted(launch) ? { ...launch, status: 'failed' as const } : launch
	);
	await writeLaunches(filePath, settled);
	logger.info(
		`${path.basename(filePath)}: marked ${interrupted} launch(es) as failed, because Maestro quit or crashed while they ran`,
		LOG_CONTEXT
	);
	return settled;
}

/** Newest first by `startedAt`. For equal times, the record written later comes first. */
function newestFirst(launches: readonly PlaybookLaunchRecord[]): PlaybookLaunchRecord[] {
	return [...launches].reverse().sort((a, b) => b.startedAt - a.startedAt);
}

function runningLaunchOf(
	launches: readonly PlaybookLaunchRecord[],
	sessionId: string
): PlaybookLaunchRecord | undefined {
	return newestFirst(launches).find(
		(launch) => launch.sessionId === sessionId && launch.status === 'running'
	);
}

/**
 * Copy only the fields an update may change, and only those it sets, so neither an `undefined`
 * nor a field outside `PlaybookLaunchUpdate` (such as the launch folder) can reach the record.
 */
function applyUpdate(
	record: PlaybookLaunchRecord,
	update: PlaybookLaunchUpdate
): PlaybookLaunchRecord {
	const next = { ...record };
	if (update.status !== undefined) next.status = update.status;
	if (update.finishedAt !== undefined) next.finishedAt = update.finishedAt;
	if (update.completion !== undefined) next.completion = update.completion;
	if (update.cleanup !== undefined) next.cleanup = update.cleanup;
	return next;
}

/** Drop finished records, earliest start first, until the cap holds or none is left to drop. */
function capLaunches(launches: PlaybookLaunchRecord[]): PlaybookLaunchRecord[] {
	const excess = launches.length - MAX_LAUNCH_RECORDS;
	if (excess <= 0) return launches;
	const dropped = new Set(
		launches
			.filter((launch) => launch.status !== 'running')
			.sort((a, b) => a.startedAt - b.startedAt)
			.slice(0, excess)
	);
	return launches.filter((launch) => !dropped.has(launch));
}

/** A store over one launch record file. Store objects on the same file share one write queue. */
export function createPlaybookLaunchStore(launchesFilePath: string): PlaybookLaunchStore {
	// Resolved, so two spellings of one path still share a queue key.
	const filePath = path.resolve(launchesFilePath);
	const withLaunches = <T>(fn: (launches: PlaybookLaunchRecord[]) => T | Promise<T>): Promise<T> =>
		fileQueue.enqueue(filePath, async () =>
			fn(await settleInterruptedLaunches(filePath, await readLaunches(filePath)))
		);

	return {
		createLaunch: (launch) =>
			withLaunches(async (launches) => {
				const running = runningLaunchOf(launches, launch.sessionId);
				if (running) throw new MarketplaceLaunchBusyError(running);
				const record: PlaybookLaunchRecord = {
					launchId: randomUUID(),
					playbookId: launch.playbookId,
					playbookTitle: launch.playbookTitle,
					sessionId: launch.sessionId,
					folderRelativePath: launch.folderRelativePath,
					autoRunFolderPath: launch.autoRunFolderPath,
					...(launch.sshRemoteId ? { sshRemoteId: launch.sshRemoteId } : {}),
					spec: launch.spec,
					savedPlaybookId: launch.savedPlaybookId,
					keepSavedPlaybook: launch.keepSavedPlaybook,
					values: launch.values,
					status: 'running',
					appRunId: currentAppRunId(),
					startedAt: Date.now(),
				};
				await writeLaunches(filePath, capLaunches([...launches, record]));
				return record;
			}),

		updateLaunch: (launchId, update) =>
			withLaunches(async (launches) => {
				const index = launches.findIndex((launch) => launch.launchId === launchId);
				if (index === -1) return undefined;
				const record = applyUpdate(launches[index], update);
				await writeLaunches(
					filePath,
					launches.map((launch, i) => (i === index ? record : launch))
				);
				return record;
			}),

		getLaunch: (launchId) =>
			withLaunches((launches) => launches.find((launch) => launch.launchId === launchId)),

		async listLaunches({ sessionId, limit } = {}) {
			if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
				throw new RangeError(`limit must be a positive whole number, not ${limit}`);
			}
			return withLaunches((launches) => {
				const matching = newestFirst(launches).filter(
					(launch) => sessionId === undefined || launch.sessionId === sessionId
				);
				return limit === undefined ? matching : matching.slice(0, limit);
			});
		},

		findRunningLaunchForSession: (sessionId) =>
			withLaunches((launches) => runningLaunchOf(launches, sessionId)),
	};
}

/** The app's launch store, in Electron's userData folder. */
export function getPlaybookLaunchStore(app: Pick<App, 'getPath'>): PlaybookLaunchStore {
	return createPlaybookLaunchStore(path.join(app.getPath('userData'), PLAYBOOK_LAUNCHES_FILE));
}
