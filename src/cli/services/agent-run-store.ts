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
import { TERMINAL_AGENT_RUN_STATUSES } from '../../shared/agent-run/lifecycle';
import { assertSerializedJsonIsSafe } from '../../shared/jsonUtils';
import { serializeWithMemoizedArray } from '../../shared/memoizedJsonSerialize';
import { getConfigDirectory } from './storage';
import { withStoreLock } from './agent-run-lock';

const AGENT_RUNS_FILE = 'maestro-agent-runs.json';
const AGENT_RUNS_ARCHIVE_FILE = 'maestro-agent-runs.1.json';
const AGENT_RUN_EVENTS_FILE = 'maestro-agent-run-events.jsonl';
const AGENT_RUN_EVENTS_ARCHIVE_FILE = 'maestro-agent-run-events.1.jsonl';
const CAMPAIGNS_FILE = 'maestro-campaigns.json';

// Retention bound for the runs snapshot, mirroring the events-log bounds below.
//
// The runs file is rewritten IN FULL by every upsert and by every event append,
// and it had no bound at all: a heavy user reached 7,500 runs / 20MB, where a
// single write cost ~150ms (read 13ms, parse 41ms, re-serialize 51ms, plus the
// write) on the Electron main thread - the same thread that answers every IPC
// call. Capping the live file caps that per-write cost.
//
// Only TERMINAL runs are evictable; a queued/running/waiting/needs_review/fixing
// run still describes work in flight and is kept regardless of age or count.
// Evicted runs are moved to AGENT_RUNS_ARCHIVE_FILE, not deleted, and
// readAgentRuns() merges the archive back in - so nothing disappears from the
// dashboard, the hot write path just stops paying for the history.
const AGENT_RUNS_MAX_TERMINAL = 2000;
// The archive is bounded too, or it would simply become the unbounded file we
// just fixed. Together these retain ~2x the live cap before the oldest runs
// are finally dropped.
const AGENT_RUNS_ARCHIVE_MAX = 2000;

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

// --- Process-local cache of the runs ledger ---------------------------------
//
// The desktop app runs this module on the Electron main thread, and every agent
// spawn and exit goes through upsertAgentRun + appendAgentRunEvent. Uncached,
// one spawn read and parsed the multi-MB runs file twice, validated every entry
// twice, re-serialized it twice and re-read the whole events log twice; the
// store watcher then read all of it again ~150ms later. A field trace caught
// that as a 169ms main-thread freeze per spawn.
//
// The parsed documents are therefore kept in memory, validated against the
// file's stat signature (inode, size, mtime in ns) on every read. Another
// process (maestro-cli) writing a file replaces it by rename, which changes the
// signature, so its writes are picked up on the next read. This process's own
// writes refresh the cache with what was just written, so they never cost a
// re-read. A read that races a foreign write can only cache newer content under
// an older signature, which the next read sees as a mismatch and re-reads.
//
// Cached values are SHARED: nothing here mutates a cached document or entry in
// place (every update builds new objects), and that must stay true - it is also
// what lets serializeWithMemoizedArray reuse each unchanged entry's JSON.

/** Store files whose parsed document is cached. Every other file is small. */
const CACHED_JSON_FILES: ReadonlySet<string> = new Set([AGENT_RUNS_FILE, AGENT_RUNS_ARCHIVE_FILE]);

interface FileSignature {
	ino: bigint;
	size: bigint;
	mtimeNs: bigint;
}

function readFileSignature(filePath: string): FileSignature {
	const stats = fs.statSync(filePath, { bigint: true });
	return { ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs };
}

function sameSignature(left: FileSignature, right: FileSignature): boolean {
	return left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

const jsonDocumentCache = new Map<string, { signature: FileSignature; value: unknown }>();

/**
 * Runs entries known to be exactly what JSON.parse would produce for their
 * serialized form: entries parsed from disk, and new entries after
 * {@link normalizeRunEntries}. Only such entries can be cached as "what is on
 * disk" without a re-read.
 */
const normalizedRunEntries = new WeakSet<object>();

function rememberNormalizedRunEntries(document: unknown): void {
	const entries = Array.isArray(document)
		? document
		: isRecord(document) && Array.isArray(document.runs)
			? document.runs
			: [];
	for (const entry of entries) {
		if (typeof entry === 'object' && entry !== null) normalizedRunEntries.add(entry);
	}
}

/**
 * Round-trip any entry not already in on-disk form through JSON (dropping
 * `undefined` fields and the like), so the cached document equals a re-read.
 * Only new or changed entries pay this; untouched ones are returned as is.
 */
function normalizeRunEntries(entries: unknown[]): unknown[] {
	return entries.map((entry) => {
		if (typeof entry === 'object' && entry !== null && normalizedRunEntries.has(entry)) {
			return entry;
		}
		const normalized: unknown = JSON.parse(JSON.stringify(entry) ?? 'null');
		if (typeof normalized === 'object' && normalized !== null) {
			normalizedRunEntries.add(normalized);
		}
		return normalized;
	});
}

/**
 * Parse a store file, serving the runs files from the cache when unchanged.
 * Throws exactly what an uncached read would: an ENOENT error, or a
 * SyntaxError for malformed content.
 */
function readJsonFile(filename: string): unknown {
	const filePath = getStorePath(filename);
	if (!CACHED_JSON_FILES.has(filename)) {
		return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
	}
	let signature: FileSignature;
	try {
		signature = readFileSignature(filePath);
	} catch (error) {
		jsonDocumentCache.delete(filePath);
		throw error;
	}
	const cached = jsonDocumentCache.get(filePath);
	if (cached && sameSignature(cached.signature, signature)) {
		return cached.value;
	}
	const value = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
	rememberNormalizedRunEntries(value);
	jsonDocumentCache.set(filePath, { signature, value });
	return value;
}

function atomicWriteJson(filename: string, value: unknown): void {
	ensureConfigDirectory();
	const filePath = getStorePath(filename);
	const cached = CACHED_JSON_FILES.has(filename);
	// The runs files reuse each unchanged entry's memoized JSON; the output is
	// byte-identical to JSON.stringify(value, null, '\t').
	const content = `${cached ? serializeWithMemoizedArray(value, 'runs') : JSON.stringify(value, null, '\t')}\n`;
	// Guards against writing the literal "undefined" over a good file. Skips the
	// full round-trip parse on large payloads, where it cost more than the write
	// itself - see assertSerializedJsonIsSafe.
	assertSerializedJsonIsSafe(content, filePath);
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tempPath, content, 'utf-8');
	fs.renameSync(tempPath, filePath);
	if (cached) {
		// Every writer holds the store lock, so nothing else can replace the file
		// between the rename and this stat.
		jsonDocumentCache.set(filePath, { signature: readFileSignature(filePath), value });
	}
}

function readJsonValue(filename: string): unknown | undefined {
	try {
		return readJsonFile(filename);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
			return undefined;
		}
		throw error;
	}
}
function readJsonValueForWrite(filename: string): unknown | undefined {
	try {
		return readJsonFile(filename);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
}

/**
 * Validation results for cached (shared, never-mutated) raw entries, per
 * validator. A cache hit on the runs file hands back the same entry objects,
 * so re-validating all of them on every write is pure waste. Entries read
 * uncached are fresh objects and simply miss.
 */
const validationMemo = new WeakMap<object, WeakMap<object, unknown>>();

function validateMemoized<T>(validateEntry: (raw: unknown) => T | null, entry: unknown): T | null {
	if (typeof entry !== 'object' || entry === null) return validateEntry(entry);
	let memo = validationMemo.get(validateEntry);
	if (!memo) {
		memo = new WeakMap();
		validationMemo.set(validateEntry, memo);
	}
	if (memo.has(entry)) return memo.get(entry) as T | null;
	const validated = validateEntry(entry);
	memo.set(entry, validated);
	return validated;
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
		const validated = validateMemoized(validateEntry, entry);
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

/** True when a raw (unvalidated) runs entry is in a terminal status. */
function isTerminalRawRun(entry: unknown): boolean {
	if (!isRecord(entry)) return false;
	const status = entry.status;
	return (
		typeof status === 'string' &&
		(TERMINAL_AGENT_RUN_STATUSES as readonly string[]).includes(status)
	);
}

/** `updatedAt` of a raw runs entry; 0 (i.e. oldest) when missing or malformed. */
function rawRunUpdatedAt(entry: unknown): number {
	if (!isRecord(entry)) return 0;
	const updatedAt = entry.updatedAt;
	return typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : 0;
}

/**
 * Split a runs snapshot into the entries that stay in the live file and the
 * terminal entries that overflow AGENT_RUNS_MAX_TERMINAL and move to the
 * archive. Operates on the RAW entries so unknown forward-compatible fields
 * survive the round trip, exactly as the upsert path already preserves them.
 *
 * Original array order is preserved for the kept entries; only recency decides
 * which terminal entries are evicted.
 */
function partitionRunsForRetention(entries: unknown[]): { kept: unknown[]; archived: unknown[] } {
	let terminalCount = 0;
	for (const entry of entries) {
		if (isTerminalRawRun(entry)) terminalCount += 1;
	}
	if (terminalCount <= AGENT_RUNS_MAX_TERMINAL) {
		return { kept: entries, archived: [] };
	}

	const evictedIndices = new Set(
		entries
			.map((entry, index) => ({ entry, index }))
			.filter(({ entry }) => isTerminalRawRun(entry))
			.sort((left, right) => rawRunUpdatedAt(right.entry) - rawRunUpdatedAt(left.entry))
			.slice(AGENT_RUNS_MAX_TERMINAL)
			.map(({ index }) => index)
	);

	const kept: unknown[] = [];
	const archived: unknown[] = [];
	entries.forEach((entry, index) => {
		(evictedIndices.has(index) ? archived : kept).push(entry);
	});
	return { kept, archived };
}

/** Raw entries currently in the runs archive, or [] when there is no archive. */
function readRunsArchiveEntries(): unknown[] {
	const parsed = readJsonValue(AGENT_RUNS_ARCHIVE_FILE);
	if (parsed === undefined) return [];
	if (Array.isArray(parsed)) return parsed;
	return isRecord(parsed) && Array.isArray(parsed.runs) ? parsed.runs : [];
}

/** Raw run id, or undefined when the entry is malformed. */
function rawRunId(entry: unknown): string | undefined {
	if (!isRecord(entry)) return undefined;
	return typeof entry.id === 'string' ? entry.id : undefined;
}

/**
 * Fold newly evicted runs into the archive, newest first, capped at
 * AGENT_RUNS_ARCHIVE_MAX. Callers MUST hold the store lock.
 *
 * Deduped by id, keeping the newest `updatedAt`. A run CAN legitimately be
 * archived twice: evicted while terminal, reopened by an audited action (which
 * writes a fresh copy to the live file), then evicted again. Without this the
 * archive would hold both copies and readAgentRuns() would list the run twice,
 * because its live-wins dedupe only guards live-vs-archive collisions.
 */
function archiveEvictedRuns(evicted: unknown[]): void {
	const newestById = new Map<string, unknown>();
	const unidentified: unknown[] = [];
	for (const entry of [...evicted, ...readRunsArchiveEntries()]) {
		const id = rawRunId(entry);
		if (id === undefined) {
			unidentified.push(entry);
			continue;
		}
		const existing = newestById.get(id);
		if (existing === undefined || rawRunUpdatedAt(entry) > rawRunUpdatedAt(existing)) {
			newestById.set(id, entry);
		}
	}
	const merged = [...newestById.values(), ...unidentified]
		.sort((left, right) => rawRunUpdatedAt(right) - rawRunUpdatedAt(left))
		.slice(0, AGENT_RUNS_ARCHIVE_MAX);
	atomicWriteJson(AGENT_RUNS_ARCHIVE_FILE, { runs: merged });
}

/**
 * Persist a runs snapshot, evicting terminal overflow to the archive first.
 * Every write to AGENT_RUNS_FILE goes through here so the bound cannot be
 * bypassed by a new call site. Callers MUST hold the store lock.
 */
function writeRunsSnapshot(entries: unknown[]): void {
	const { kept, archived } = partitionRunsForRetention(normalizeRunEntries(entries));
	if (archived.length > 0) {
		archiveEvictedRuns(archived);
	}
	atomicWriteJson(AGENT_RUNS_FILE, { runs: kept });
}

/**
 * Every run the store knows about: the live file plus the archive.
 *
 * Unlike readAgentRunEvents (which deliberately ignores its archive), runs ARE
 * merged back in, because this is what the runs dashboard lists - retention is
 * a write-cost optimization and must not silently shrink the user's history.
 * The write path reads the live file only, so the merge is never on a hot path.
 */
export function readAgentRuns(): AgentRun[] {
	const live = readSnapshot(
		AGENT_RUNS_FILE,
		(raw) => validateAgentRunFile(raw).runs,
		validateAgentRun
	);
	const archived = readSnapshot(
		AGENT_RUNS_ARCHIVE_FILE,
		(raw) => validateAgentRunFile(raw).runs,
		validateAgentRun
	);
	if (archived.length === 0) return live;

	// The live file wins on id collision: an archived run that was later
	// reopened (failed -> running) has a fresher copy in the live file.
	const seen = new Set(live.map((run) => run.id));
	return [...live, ...archived.filter((run) => !seen.has(run.id))];
}

export function writeAgentRuns(runs: AgentRun[]): void {
	const validated = runs.map(assertAgentRun);
	withStoreLock(() => writeRunsSnapshot(validated));
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
		writeRunsSnapshot(nextRuns);
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
	// Live file only: retention never evicts a non-terminal run, so an active
	// run is by definition not in the archive. Reading it here would be pure
	// waste on a lookup that runs whenever work is dispatched to an agent.
	return readSnapshot(
		AGENT_RUNS_FILE,
		(raw) => validateAgentRunFile(raw).runs,
		validateAgentRun
	).find((run) => run.sessionId === sessionId && NON_TERMINAL_STATUSES.includes(run.status));
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
		const log = readEventLog();
		let maxSeq = 0;
		for (const existing of log?.events ?? []) {
			if (existing.runId === validated.runId) maxSeq = Math.max(maxSeq, existing.seq ?? 0);
		}
		const stamped: AgentRunEvent = { ...validated, seq: maxSeq + 1 };
		// Live file only, so an event for an already-archived run does not drag
		// the archive back into the write path. Archived runs are terminal by
		// construction, and a terminal run can only change through an audited
		// action, which goes via upsertAgentRun - so the only thing lost here is
		// an updatedAt bump on a run that is already finished. The event itself
		// is still appended to the log below either way.
		const snapshot = readSnapshotForWrite(AGENT_RUNS_FILE, 'runs', validateAgentRunStrict);
		const existingIndex = snapshot.validatedEntries.findIndex(
			(entry) => entry.id === stamped.runId
		);
		const existingRun = existingIndex === -1 ? undefined : snapshot.validatedEntries[existingIndex];
		// Capture upserts a run and then logs its event with the same timestamp and
		// status, so the rewrite below would change nothing. Skip it: it is a full
		// rewrite of the multi-MB runs file on the main thread.
		const runUnchanged =
			existingRun !== undefined &&
			existingRun.updatedAt === stamped.timestamp &&
			(!stamped.status || stamped.status === existingRun.status);
		if (existingRun !== undefined && !runUnchanged) {
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
			writeRunsSnapshot(nextRuns);
		}
		const line = `${JSON.stringify(stamped)}\n`;
		const eventsPath = getStorePath(AGENT_RUN_EVENTS_FILE);
		fs.appendFileSync(eventsPath, line, 'utf-8');
		recordEventLogAppend(eventsPath, log, line);
		return stamped;
	});
}

/**
 * The parsed current events log. `events` is in file order, validated but not
 * yet ordered or deduped; `lineCount` and `byteLength` feed rotation.
 */
interface EventLogSnapshot {
	signature: FileSignature;
	lineCount: number;
	byteLength: number;
	events: AgentRunEvent[];
}

/** Cached event logs by path, under the same stat-signature rule as the runs files. */
const eventLogCache = new Map<string, EventLogSnapshot>();

function countNewlines(content: string): number {
	let lineCount = 0;
	for (let index = 0; index < content.length; index += 1) {
		if (content.charCodeAt(index) === 10) lineCount += 1;
	}
	return lineCount;
}

/** The current events log, or undefined when there is none. */
function readEventLog(): EventLogSnapshot | undefined {
	const filePath = getStorePath(AGENT_RUN_EVENTS_FILE);
	let signature: FileSignature;
	try {
		signature = readFileSignature(filePath);
	} catch (error) {
		eventLogCache.delete(filePath);
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
	const cached = eventLogCache.get(filePath);
	if (cached && sameSignature(cached.signature, signature)) {
		return cached;
	}
	const content = fs.readFileSync(filePath, 'utf-8');
	const snapshot: EventLogSnapshot = {
		signature,
		lineCount: countNewlines(content),
		byteLength: Buffer.byteLength(content, 'utf-8'),
		events: validateAgentRunEvents(content.split(/\r?\n/)),
	};
	eventLogCache.set(filePath, snapshot);
	return snapshot;
}

/**
 * Fold this process's own append into the cached log instead of re-reading the
 * whole file. Only when the cache described the file right before the append
 * (`before`) and the file grew by exactly `line`; anything else drops the
 * cache so the next read parses the file.
 */
function recordEventLogAppend(
	filePath: string,
	before: EventLogSnapshot | undefined,
	line: string
): void {
	const lineBytes = Buffer.byteLength(line, 'utf-8');
	let signature: FileSignature;
	try {
		signature = readFileSignature(filePath);
	} catch {
		eventLogCache.delete(filePath);
		return;
	}
	if (
		!before ||
		eventLogCache.get(filePath) !== before ||
		signature.ino !== before.signature.ino ||
		signature.size !== before.signature.size + BigInt(lineBytes)
	) {
		eventLogCache.delete(filePath);
		return;
	}
	eventLogCache.set(filePath, {
		signature,
		lineCount: before.lineCount + 1,
		byteLength: before.byteLength + lineBytes,
		// Re-validated from the written line so the entry is exactly what a
		// re-read of the file would produce.
		events: [...before.events, ...validateAgentRunEvents([line])],
	});
}

export function readAgentRunEvents(runId?: string): AgentRunEvent[] {
	// Only the current file is read; rotated archives (AGENT_RUN_EVENTS_ARCHIVE_FILE)
	// exist purely to bound live-file growth and are intentionally not merged in.
	const log = readEventLog();
	if (!log) return [];

	// Order by monotonic seq first (stable per run), timestamp as tiebreaker for
	// legacy events written before seq stamping existed. Sorts a copy: the
	// cached list must keep file order.
	const ordered = [...log.events].sort((left, right) => {
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
	const log = readEventLog();
	if (!log) {
		return false;
	}
	if (log.lineCount < AGENT_RUN_EVENTS_MAX_LINES && log.byteLength < AGENT_RUN_EVENTS_MAX_BYTES) {
		return false;
	}

	const filePath = getStorePath(AGENT_RUN_EVENTS_FILE);
	const archivePath = getStorePath(AGENT_RUN_EVENTS_ARCHIVE_FILE);
	if (fs.existsSync(archivePath)) {
		fs.rmSync(archivePath);
	}
	fs.renameSync(filePath, archivePath);
	eventLogCache.delete(filePath);
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
