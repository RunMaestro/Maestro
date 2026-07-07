import * as fs from 'fs';
import * as path from 'path';
import {
	PIANOLA_PLANS_FILE,
	pianolaPlansToCampaigns,
	validateAgentRun,
	validateAgentRunStrict,
	validateAgentRunEventStrict,
	validateAgentRunEvents,
	validateAgentRunFile,
	type AgentRun,
	type AgentRunEvent,
	type AgentRunStatus,
} from '../../shared/agent-run';
import {
	validateCampaign,
	validateCampaignStrict,
	validateCampaignFile,
	type Campaign,
	type CampaignStatus,
} from '../../shared/campaign';
import { getConfigDirectory } from './storage';
import { withStoreLock } from './agent-run-lock';

const AGENT_RUNS_FILE = 'maestro-agent-runs.json';
const AGENT_RUN_EVENTS_FILE = 'maestro-agent-run-events.jsonl';
const AGENT_RUN_EVENTS_ARCHIVE_FILE = 'maestro-agent-run-events.1.jsonl';
const CAMPAIGNS_FILE = 'maestro-campaigns.json';

// Rotation bounds for the events JSONL. When either threshold is exceeded the
// current log is archived to AGENT_RUN_EVENTS_ARCHIVE_FILE and a fresh file is
// started. readAgentRunEvents only reads the current file; archived files are
// retained on disk for forensics but are not merged back in.
const AGENT_RUN_EVENTS_MAX_LINES = 5000;
const AGENT_RUN_EVENTS_MAX_BYTES = 5 * 1024 * 1024;

export type { AgentRun, AgentRunEvent, AgentRunStatus } from '../../shared/agent-run';
export type { Campaign, CampaignStatus } from '../../shared/campaign';

export interface ListAgentRunsOptions {
	status?: AgentRunStatus;
	campaignId?: string;
	limit?: number;
	offset?: number;
}

export interface ListCampaignsOptions {
	status?: CampaignStatus;
	limit?: number;
}

function getStorePath(filename: string): string {
	return path.join(getConfigDirectory(), filename);
}

function ensureConfigDirectory(): void {
	const configDirectory = getConfigDirectory();
	if (!fs.existsSync(configDirectory)) {
		fs.mkdirSync(configDirectory, { recursive: true });
	}
}

function atomicWriteJson(filename: string, value: unknown): void {
	ensureConfigDirectory();
	const filePath = getStorePath(filename);
	const content = `${JSON.stringify(value, null, '\t')}\n`;
	JSON.parse(content);
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tempPath, content, 'utf-8');
	fs.renameSync(tempPath, filePath);
}

function readJsonValue(filename: string): unknown | undefined {
	try {
		const content = fs.readFileSync(getStorePath(filename), 'utf-8');
		return JSON.parse(content) as unknown;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
			return undefined;
		}
		throw error;
	}
}
function readJsonValueForWrite(filename: string): unknown | undefined {
	try {
		const content = fs.readFileSync(getStorePath(filename), 'utf-8');
		return JSON.parse(content) as unknown;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
}

interface SnapshotForWrite<T> {
	entries: unknown[];
	validatedEntries: T[];
}

function readSnapshotForWrite<T>(
	filename: string,
	wrappedKey: string,
	validateEntry: (raw: unknown) => T | null
): SnapshotForWrite<T> {
	const parsed = readJsonValueForWrite(filename);
	if (parsed === undefined) {
		return { entries: [], validatedEntries: [] };
	}

	const rawEntries = Array.isArray(parsed)
		? parsed
		: isRecord(parsed) && Array.isArray(parsed[wrappedKey])
			? parsed[wrappedKey]
			: null;
	if (!rawEntries) {
		throw new Error(`Invalid ${wrappedKey} snapshot`);
	}

	const validatedEntries = rawEntries.map((entry) => {
		const validated = validateEntry(entry);
		if (!validated) {
			throw new Error(`Invalid ${wrappedKey} entry`);
		}
		return validated;
	});

	return { entries: rawEntries, validatedEntries };
}

function readSnapshot<T>(
	filename: string,
	readWrapped: (raw: unknown) => T[],
	validateEntry: (raw: unknown) => T | null
): T[] {
	const parsed = readJsonValue(filename);
	if (parsed === undefined) {
		return [];
	}
	if (Array.isArray(parsed)) {
		return parsed.flatMap((entry) => {
			const validated = validateEntry(entry);
			return validated ? [validated] : [];
		});
	}
	return readWrapped(parsed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertAgentRun(run: AgentRun): AgentRun {
	const validated = validateAgentRunStrict(run);
	if (!validated) {
		throw new Error('Invalid agent run');
	}
	return validated;
}

function assertAgentRunEvent(event: AgentRunEvent): AgentRunEvent {
	const validated = validateAgentRunEventStrict(event);
	if (!validated) {
		throw new Error('Invalid agent run event');
	}
	return validated;
}

function assertNativeCampaignId(campaign: Campaign): void {
	if (campaign.id.startsWith('pianola:')) {
		throw new Error('Pianola campaign ids are read-only adapter ids');
	}
}

function assertCampaign(campaign: Campaign): Campaign {
	const validated = validateCampaignStrict(campaign);
	if (!validated) {
		throw new Error('Invalid campaign');
	}
	assertNativeCampaignId(validated);
	return validated;
}

function validateNativeCampaign(raw: unknown): Campaign | null {
	const campaign = validateCampaign(raw);
	if (!campaign || campaign.id.startsWith('pianola:')) return null;
	return campaign;
}

function validateNativeCampaignStrict(raw: unknown): Campaign | null {
	const campaign = validateCampaignStrict(raw);
	if (!campaign || campaign.id.startsWith('pianola:')) return null;
	return campaign;
}

function byUpdatedAtDescending<T extends { updatedAt: number }>(left: T, right: T): number {
	return right.updatedAt - left.updatedAt;
}

function applyLimit<T>(entries: T[], limit?: number): T[] {
	if (limit === undefined || !Number.isFinite(limit)) {
		return entries;
	}
	return entries.slice(0, Math.max(0, Math.floor(limit)));
}

function applyWindow<T>(entries: T[], offset?: number, limit?: number): T[] {
	const start =
		offset !== undefined && Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
	const windowed = start > 0 ? entries.slice(start) : entries;
	return applyLimit(windowed, limit);
}

function runMatchesCampaign(
	run: AgentRun,
	campaignId: string,
	campaignRunIds: Set<string>
): boolean {
	if (campaignRunIds.has(run.id) || run.source === campaignId) {
		return true;
	}
	return isRecord(run.metadata) && run.metadata.campaignId === campaignId;
}

export function readAgentRuns(): AgentRun[] {
	return readSnapshot(AGENT_RUNS_FILE, (raw) => validateAgentRunFile(raw).runs, validateAgentRun);
}

export function writeAgentRuns(runs: AgentRun[]): void {
	const validated = runs.map(assertAgentRun);
	withStoreLock(() => atomicWriteJson(AGENT_RUNS_FILE, { runs: validated }));
}

export function upsertAgentRun(run: AgentRun): AgentRun {
	const validated = assertAgentRun(run);
	return withStoreLock(() => {
		const snapshot = readSnapshotForWrite(AGENT_RUNS_FILE, 'runs', validateAgentRunStrict);
		const existingIndex = snapshot.validatedEntries.findIndex((entry) => entry.id === validated.id);
		const nextRuns =
			existingIndex === -1
				? [...snapshot.entries, validated]
				: snapshot.entries.map((entry, index) =>
						index === existingIndex ? { ...(isRecord(entry) ? entry : {}), ...validated } : entry
					);
		atomicWriteJson(AGENT_RUNS_FILE, { runs: nextRuns });
		return validated;
	});
}

export function getAgentRun(runId: string): AgentRun | undefined {
	return readAgentRuns().find((run) => run.id === runId);
}

const NON_TERMINAL_STATUSES: readonly AgentRunStatus[] = [
	'queued',
	'running',
	'waiting',
	'needs_review',
	'fixing',
];

export function findActiveRunBySession(sessionId: string): AgentRun | undefined {
	return readAgentRuns().find(
		(run) => run.sessionId === sessionId && NON_TERMINAL_STATUSES.includes(run.status)
	);
}

export function listAgentRuns(options: ListAgentRunsOptions = {}): AgentRun[] {
	const campaign = options.campaignId
		? readCampaigns().find((entry) => entry.id === options.campaignId)
		: undefined;
	const campaignRunIds = new Set([
		...(campaign?.runIds ?? []),
		...(campaign?.tasks.flatMap((task) => (task.runId ? [task.runId] : [])) ?? []),
	]);
	const filteredRuns = readAgentRuns()
		.filter((run) => (options.status ? run.status === options.status : true))
		.filter((run) =>
			options.campaignId ? runMatchesCampaign(run, options.campaignId, campaignRunIds) : true
		)
		.sort(byUpdatedAtDescending);
	return applyWindow(filteredRuns, options.offset, options.limit);
}

export function appendAgentRunEvent(event: AgentRunEvent): AgentRunEvent {
	const validated = assertAgentRunEvent(event);
	ensureConfigDirectory();
	return withStoreLock(() => {
		// Bound the events log before appending so the current file stays small.
		rotateEventLogIfNeeded();
		// Stamp a monotonic per-run sequence from the (post-rotation) current file.
		const nextSeq =
			readAgentRunEvents(validated.runId).reduce(
				(max, existing) => Math.max(max, existing.seq ?? 0),
				0
			) + 1;
		const stamped: AgentRunEvent = { ...validated, seq: nextSeq };
		const snapshot = readSnapshotForWrite(AGENT_RUNS_FILE, 'runs', validateAgentRunStrict);
		const existingIndex = snapshot.validatedEntries.findIndex(
			(entry) => entry.id === stamped.runId
		);
		if (existingIndex !== -1) {
			const existingRun = snapshot.validatedEntries[existingIndex];
			const nextRuns = snapshot.entries.map((entry, index) =>
				index === existingIndex
					? {
							...(isRecord(entry) ? entry : {}),
							...existingRun,
							updatedAt: stamped.timestamp,
							...(stamped.status ? { status: stamped.status } : {}),
						}
					: entry
			);
			atomicWriteJson(AGENT_RUNS_FILE, { runs: nextRuns });
		}
		fs.appendFileSync(getStorePath(AGENT_RUN_EVENTS_FILE), `${JSON.stringify(stamped)}\n`, 'utf-8');
		return stamped;
	});
}

export function readAgentRunEvents(runId?: string): AgentRunEvent[] {
	// Only the current file is read; rotated archives (AGENT_RUN_EVENTS_ARCHIVE_FILE)
	// exist purely to bound live-file growth and are intentionally not merged in.
	let lines: string[];
	try {
		lines = fs.readFileSync(getStorePath(AGENT_RUN_EVENTS_FILE), 'utf-8').split(/\r?\n/);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}
		throw error;
	}

	// Order by monotonic seq first (stable per run), timestamp as tiebreaker for
	// legacy events written before seq stamping existed.
	const ordered = validateAgentRunEvents(lines).sort((left, right) => {
		const seqDelta = (left.seq ?? 0) - (right.seq ?? 0);
		return seqDelta !== 0 ? seqDelta : left.timestamp - right.timestamp;
	});

	// Dedupe by event id, keeping the first (lowest-ordered) occurrence.
	const seen = new Set<string>();
	const deduped: AgentRunEvent[] = [];
	for (const event of ordered) {
		if (seen.has(event.id)) continue;
		seen.add(event.id);
		deduped.push(event);
	}

	return runId ? deduped.filter((event) => event.runId === runId) : deduped;
}

/**
 * Archive the current events JSONL and start a fresh one when it grows past the
 * line/byte bounds. Callers MUST hold the store lock (appendAgentRunEvent does).
 * Returns true when a rotation happened. Only the most recent archive is kept;
 * an older archive is overwritten.
 */
export function rotateEventLogIfNeeded(): boolean {
	const filePath = getStorePath(AGENT_RUN_EVENTS_FILE);
	let content: string;
	try {
		content = fs.readFileSync(filePath, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return false;
		}
		throw error;
	}

	const byteLength = Buffer.byteLength(content, 'utf-8');
	let lineCount = 0;
	for (let index = 0; index < content.length; index += 1) {
		if (content.charCodeAt(index) === 10) lineCount += 1;
	}
	if (lineCount < AGENT_RUN_EVENTS_MAX_LINES && byteLength < AGENT_RUN_EVENTS_MAX_BYTES) {
		return false;
	}

	const archivePath = getStorePath(AGENT_RUN_EVENTS_ARCHIVE_FILE);
	if (fs.existsSync(archivePath)) {
		fs.rmSync(archivePath);
	}
	fs.renameSync(filePath, archivePath);
	return true;
}

export function readPianolaCampaigns(): Campaign[] {
	return pianolaPlansToCampaigns(readJsonValue(PIANOLA_PLANS_FILE));
}

export function readCampaigns(): Campaign[] {
	const nativeCampaigns = readSnapshot(
		CAMPAIGNS_FILE,
		(raw) =>
			validateCampaignFile(raw).campaigns.filter((campaign) => !campaign.id.startsWith('pianola:')),
		validateNativeCampaign
	);
	const nativeIds = new Set(nativeCampaigns.map((campaign) => campaign.id));
	const pianolaCampaigns = readPianolaCampaigns().filter((campaign) => !nativeIds.has(campaign.id));
	return [...nativeCampaigns, ...pianolaCampaigns];
}

export function writeCampaigns(campaigns: Campaign[]): void {
	const validated = campaigns.map(assertCampaign);
	withStoreLock(() => atomicWriteJson(CAMPAIGNS_FILE, { campaigns: validated }));
}

export function upsertCampaign(campaign: Campaign): Campaign {
	const validated = assertCampaign(campaign);
	return withStoreLock(() => {
		const snapshot = readSnapshotForWrite(
			CAMPAIGNS_FILE,
			'campaigns',
			validateNativeCampaignStrict
		);
		const existingIndex = snapshot.validatedEntries.findIndex((entry) => entry.id === validated.id);
		const nextCampaigns =
			existingIndex === -1
				? [...snapshot.entries, validated]
				: snapshot.entries.map((entry, index) =>
						index === existingIndex ? { ...(isRecord(entry) ? entry : {}), ...validated } : entry
					);
		atomicWriteJson(CAMPAIGNS_FILE, { campaigns: nextCampaigns });
		return validated;
	});
}

export function getCampaign(campaignId: string): Campaign | undefined {
	return readCampaigns().find((campaign) => campaign.id === campaignId);
}

export function listCampaigns(options: ListCampaignsOptions = {}): Campaign[] {
	const filteredCampaigns = readCampaigns()
		.filter((campaign) => (options.status ? campaign.status === options.status : true))
		.sort(byUpdatedAtDescending);
	return applyLimit(filteredCampaigns, options.limit);
}
