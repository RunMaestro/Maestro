/**
 * Computer History - the ONE main-process implementation.
 *
 * IPC (desktop UI), the WS bridge (`maestro-cli computer-history ...` writes),
 * and the first-party supervisor hooks all call this class. There is no
 * second copy of any verb anywhere.
 *
 * Ingest pipeline, per helper line:
 *   validate (rebuild from known fields) -> helper.* bookkeeping
 *   -> pause check -> rules (built-ins, app/domain rules, Maestro's pids,
 *   private windows) -> snapshots toggle -> redaction + caps -> segment writer
 *
 * The helper enforces blockApps / blockDomains / private windows itself (it
 * receives them through `configure`); every check is repeated here so a
 * helper bug can never put an excluded app on disk.
 *
 * Files: `SCHEMA.md` and `config.json` are (re)written on every start. Only
 * this service writes `config.json`.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import {
	CONFIG_FILE,
	DIGESTS_DIR,
	INDEX_FILE,
	SCHEMA_FILE,
	SEGMENTS_DIR,
	SEGMENT_MS,
	computerHistoryDir,
	parseSegmentRelativePath,
	resolveStorePath,
} from '../../shared/computer-history/paths';
import {
	MAX_SNAPSHOT_BYTES,
	MAX_TEXT_BYTES,
	applyConfigPatch,
	isPausedAt,
	normalizeConfig,
	normalizeRuleValue,
	ruleIdFor,
	type ComputerHistoryConfigPatch,
} from '../../shared/computer-history/config';
import { builtInBlockedApps, observedPlatformFor } from '../../shared/computer-history/exclusions';
import { appRuleMatches, dropReason, validateRuleInput } from '../../shared/computer-history/rules';
import { redactObservedEvent, validateObservedEvent } from '../../shared/computer-history/sanitize';
import { buildSchemaDoc } from '../../shared/computer-history/schemaDoc';
import {
	listDigests,
	queryEvents,
	readIndex,
	summarizeApps,
	type AppUsage,
	type QueryOptions,
	type QueryResult,
	type TimeRange,
} from '../../shared/computer-history/reader';
import type {
	AccessibilityRequestResult,
	ComputerHistoryStatus,
	ObserverProcessStatus,
	RecorderState,
	RuleAddResult,
	SeenApp,
} from '../../shared/computer-history/status';
import type {
	CaptureRule,
	CaptureRuleMatch,
	ComputerHistoryConfig,
	HelperCommand,
	HelperStatus,
	ObservedPlatform,
	StoredEventKind,
} from '../../shared/computer-history/types';
import { atomicWriteFile, createKeyedWriteQueue } from '../utils/atomic-json-store';
import { captureException } from '../utils/sentry';
import { SegmentWriter, INDEX_QUEUE_KEY, STORE_DIR_MODE, STORE_FILE_MODE } from './segment-writer';
import { deleteSegments, listSegmentFiles, runRetention } from './retention';
import { DigestScheduler, type DigestConsult, type DigestStatus } from './digests';
import type { ObserverSupervisorDeps } from './observer-supervisor';

/** The slice of ObserverSupervisor the service drives (injectable for tests). */
export interface ObserverSupervisorLike {
	start(): void;
	stop(): void;
	send(command: HelperCommand): boolean;
	isRunning(): boolean;
	status(): ObserverProcessStatus;
}

export interface ComputerHistoryServiceDeps {
	userDataDir: string;
	/** `resolveEncoreFeatures(...).computerHistory`, re-read on every start. */
	isEnabled: () => boolean;
	createSupervisor: (deps: ObserverSupervisorDeps) => ObserverSupervisorLike;
	resolveBinary: () => string | null;
	platform?: NodeJS.Platform;
	now?: () => number;
	/** macOS: `systemPreferences.isTrustedAccessibilityClient(prompt)`. */
	isMacAccessibilityTrusted?: (prompt: boolean) => boolean;
	/** Maestro's own process ids (main + renderers); never recorded. */
	getBlockPids?: () => number[];
	onStatusChange?: (status: ComputerHistoryStatus) => void;
	getConsult?: () => DigestConsult | null;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface ClearResult {
	deletedSegments: number;
	freedBytes: number;
}

export interface RulesListing {
	rules: CaptureRule[];
	/** Always-on exclusions for this platform (not editable). */
	builtIn: string[];
}

const ROLLOVER_CHECK_MS = 15_000;
const RETENTION_INTERVAL_MS = 60 * 60_000;
/** setTimeout overflows past ~24.8 days; long pauses re-arm in steps. */
const MAX_TIMER_MS = 2_147_000_000;
/** UI recent-activity queries are capped so one IPC call stays small. */
const MAX_QUERY_LIMIT = 2000;
const CONFIG_QUEUE_KEY = 'computer-history:config';
const MAX_SEEN_APPS = 500;
const RULE_PREVIEW_DAYS = 14;

export class ComputerHistoryService {
	readonly storeDir: string;
	readonly platform: ObservedPlatform;
	private readonly deps: ComputerHistoryServiceDeps;
	private readonly now: () => number;
	private readonly queue = createKeyedWriteQueue();
	private readonly writer: SegmentWriter;
	private readonly supervisor: ObserverSupervisorLike;
	private readonly digests: DigestScheduler;
	private config: ComputerHistoryConfig | null = null;
	private running = false;
	private helperStatus: HelperStatus | null = null;
	private eventsStored = 0;
	private eventsDropped = 0;
	private lastEventAt: string | null = null;
	private rolloverTimer: ReturnType<typeof setInterval> | undefined;
	private retentionTimer: ReturnType<typeof setInterval> | undefined;
	private pauseTimer: ReturnType<typeof setTimeout> | undefined;
	private lastNotifiedState: RecorderState | null = null;
	/** Recently seen app id -> name (insertion order = recency), bounded. */
	private readonly seenApps = new Map<string, string>();

	constructor(deps: ComputerHistoryServiceDeps) {
		this.deps = deps;
		this.now = deps.now ?? Date.now;
		this.storeDir = computerHistoryDir(deps.userDataDir);
		this.platform = observedPlatformFor(deps.platform ?? process.platform);
		this.digests = new DigestScheduler({
			storeDir: this.storeDir,
			getConfig: () => this.getConfig(),
			getConsult: () => deps.getConsult?.() ?? null,
			now: this.now,
			log: (level, message) => deps.log?.(level, message),
		});
		this.writer = new SegmentWriter({
			storeDir: this.storeDir,
			queue: this.queue,
			now: this.now,
			onSegmentClosed: (entry, startMs) => this.digests.onSegmentClosed(entry, startMs),
		});
		this.supervisor = deps.createSupervisor({
			resolveBinary: deps.resolveBinary,
			onMessage: (message) => {
				void this.ingest(message).catch((err) => this.logError('ingest', err));
			},
			onSpawned: () => this.configureHelper(),
			onStateChange: () => this.notify(true),
			log: deps.log,
		});
	}

	// ------------------------------------------------------------------
	// Lifecycle
	// ------------------------------------------------------------------

	isRunning(): boolean {
		return this.running;
	}

	/** Start recording if the flag is on. Idempotent. */
	async start(): Promise<void> {
		if (this.running || !this.deps.isEnabled()) return;
		this.running = true;
		try {
			await fsp.mkdir(this.storeDir, { recursive: true, mode: STORE_DIR_MODE });
			// mkdir's mode only applies to a directory it creates; tighten an
			// existing store too (POSIX only: Windows relies on the profile ACL).
			if (this.platform !== 'windows') await fsp.chmod(this.storeDir, STORE_DIR_MODE);
			const config = this.getConfig();
			if (config.pausedUntil !== null && !isPausedAt(config.pausedUntil, this.now())) {
				config.pausedUntil = null;
			}
			await this.saveConfig(config);
			await atomicWriteFile(
				resolveStorePath(this.storeDir, SCHEMA_FILE),
				buildSchemaDoc({ storeDir: this.storeDir }),
				{ mode: STORE_FILE_MODE }
			);
			await this.writer.start();
			this.digests.start();
		} catch (err) {
			// Nothing was started yet; leave the service cleanly off so a retry works.
			this.running = false;
			throw err;
		}
		await this.runRetentionSafely();
		// A stop() that raced the awaits above wins: arm nothing.
		if (!this.running) return;
		// Queue digests a previous run missed (bounded; no-op when digests are off).
		void this.digests.catchUp().catch((err) => this.logError('digestCatchUp', err));
		this.rolloverTimer = setInterval(() => {
			void this.writer
				.closeIfExpired()
				.then(() => {
					// After the close (which queues the last window's digest), so a
					// block's roll-up is queued behind it. See digests.ts.
					const open = this.writer.currentInfo();
					this.digests.tick(open ? parseSegmentRelativePath(open.file) : null);
				})
				.catch((err) => this.logError('rollover', err));
		}, ROLLOVER_CHECK_MS);
		this.retentionTimer = setInterval(() => void this.runRetentionSafely(), RETENTION_INTERVAL_MS);
		this.armPauseTimer();
		this.supervisor.start();
		this.notify(true);
	}

	/** Stop recording, close the open segment. Idempotent. */
	async stop(): Promise<void> {
		if (!this.running) return;
		this.running = false;
		this.supervisor.stop();
		if (this.rolloverTimer) clearInterval(this.rolloverTimer);
		if (this.retentionTimer) clearInterval(this.retentionTimer);
		if (this.pauseTimer) clearTimeout(this.pauseTimer);
		this.rolloverTimer = this.retentionTimer = this.pauseTimer = undefined;
		this.digests.stop();
		this.helperStatus = null;
		await this.writer.close();
		this.notify(true);
	}

	/** Start or stop to match the flag. */
	async reconcile(): Promise<void> {
		if (this.deps.isEnabled()) await this.start();
		else await this.stop();
	}

	// ------------------------------------------------------------------
	// Ingest
	// ------------------------------------------------------------------

	/** Handle one helper message. Resolves true when an event was stored. */
	async ingest(raw: unknown): Promise<boolean> {
		if (!this.running) return false;
		const event = validateObservedEvent(raw);
		if (!event) {
			this.eventsDropped += 1;
			return false;
		}
		if (event.kind === 'helper.status') {
			this.helperStatus = event.status ?? null;
			this.notify(true);
			return false;
		}
		if (event.kind === 'helper.error') {
			this.deps.log?.('warn', `maestro-observer: ${event.text ?? ''}`);
			return false;
		}
		this.noteSeenApp(event.app);
		const config = this.getConfig();
		if (isPausedAt(config.pausedUntil, this.now())) {
			this.eventsDropped += 1;
			return false;
		}
		if (dropReason(event, { rules: config.rules, blockPids: this.blockPids() })) {
			this.eventsDropped += 1;
			return false;
		}
		if (event.kind === 'content.snapshot' && !config.snapshots) {
			this.eventsDropped += 1;
			return false;
		}
		const clean = redactObservedEvent(event, {
			maxTextBytes: MAX_TEXT_BYTES,
			maxSnapshotBytes: MAX_SNAPSHOT_BYTES,
		});
		const stored = await this.writer.append({ ...clean, kind: clean.kind as StoredEventKind });
		if (!stored) {
			// Per-segment byte guard (runaway helper); counted in the index line.
			this.eventsDropped += 1;
			return false;
		}
		this.eventsStored += 1;
		this.lastEventAt = clean.ts;
		return true;
	}

	// ------------------------------------------------------------------
	// Status
	// ------------------------------------------------------------------

	status(): ComputerHistoryStatus {
		const config = this.getConfig();
		return {
			enabled: this.deps.isEnabled(),
			running: this.running,
			state: this.recorderState(config),
			storeDir: this.storeDir,
			platform: this.platform,
			pausedUntil: config.pausedUntil,
			helper: this.supervisor.status(),
			helperStatus: this.helperStatus,
			eventsStored: this.eventsStored,
			eventsDropped: this.eventsDropped,
			lastEventAt: this.lastEventAt,
			currentSegment: this.writer.currentInfo(),
			digests: this.digests.status(),
		};
	}

	digestStatus(): DigestStatus {
		return this.digests.status();
	}

	private recorderState(config: ComputerHistoryConfig): RecorderState {
		if (!this.running) return 'off';
		const helper = this.supervisor.status().state;
		if (helper === 'binary-missing') return 'binary-missing';
		if (helper === 'failed') return 'failed';
		if (helper === 'backing-off') return 'restarting';
		if (isPausedAt(config.pausedUntil, this.now())) return 'paused';
		if (!this.helperStatus) return 'starting';
		if (this.helperStatus.state === 'blocked') return 'blocked';
		return 'recording';
	}

	/** Push status to listeners. `force` skips the same-state dedupe. */
	private notify(force = false): void {
		if (!this.deps.onStatusChange) return;
		const status = this.status();
		if (!force && status.state === this.lastNotifiedState) return;
		this.lastNotifiedState = status.state;
		this.deps.onStatusChange(status);
	}

	// ------------------------------------------------------------------
	// Config
	// ------------------------------------------------------------------

	getConfig(): ComputerHistoryConfig {
		if (!this.config) this.config = this.readConfigFromDisk();
		return this.config;
	}

	async setConfig(patch: ComputerHistoryConfigPatch): Promise<ComputerHistoryConfig> {
		const before = this.getConfig();
		const next = applyConfigPatch(before, patch);
		await this.saveConfig(next);
		if (next.snapshots !== before.snapshots) this.configureHelper();
		if (
			this.running &&
			(next.retentionDays < before.retentionDays || next.maxBytes < before.maxBytes)
		) {
			await this.runRetentionSafely();
		}
		this.notify(true);
		return next;
	}

	private readConfigFromDisk(): ComputerHistoryConfig {
		try {
			const text = fs.readFileSync(resolveStorePath(this.storeDir, CONFIG_FILE), 'utf-8');
			return normalizeConfig(JSON.parse(text));
		} catch {
			// Missing or corrupt: defaults. The next save rewrites a valid file.
			return normalizeConfig(null);
		}
	}

	/**
	 * Update the in-memory config now and persist it through the keyed queue:
	 * `atomicWriteFile` uses a fixed `.tmp` name, so two unserialized saves
	 * (a pause racing a rule add) could rename the same temp file twice and
	 * fail with ENOENT. Each queued write persists the latest config.
	 */
	private async saveConfig(config: ComputerHistoryConfig): Promise<void> {
		this.config = normalizeConfig(config);
		await this.queue.enqueue(CONFIG_QUEUE_KEY, async () => {
			await fsp.mkdir(this.storeDir, { recursive: true, mode: STORE_DIR_MODE });
			await atomicWriteFile(
				resolveStorePath(this.storeDir, CONFIG_FILE),
				JSON.stringify(this.config, null, 2) + '\n',
				{ mode: STORE_FILE_MODE }
			);
		});
	}

	// ------------------------------------------------------------------
	// Pause / resume
	// ------------------------------------------------------------------

	/** Pause for `forMs`, or until resumed when omitted. */
	async pause(forMs?: number | null): Promise<ComputerHistoryStatus> {
		const config = this.getConfig();
		config.pausedUntil =
			forMs && forMs > 0 ? new Date(this.now() + forMs).toISOString() : 'forever';
		await this.saveConfig(config);
		this.supervisor.send({ cmd: 'pause' });
		this.armPauseTimer();
		this.notify(true);
		return this.status();
	}

	async resume(): Promise<ComputerHistoryStatus> {
		const config = this.getConfig();
		config.pausedUntil = null;
		await this.saveConfig(config);
		if (this.pauseTimer) clearTimeout(this.pauseTimer);
		this.pauseTimer = undefined;
		this.supervisor.send({ cmd: 'resume' });
		this.notify(true);
		return this.status();
	}

	private armPauseTimer(): void {
		if (this.pauseTimer) clearTimeout(this.pauseTimer);
		this.pauseTimer = undefined;
		if (!this.running) return;
		const until = this.getConfig().pausedUntil;
		if (until === null || until === 'forever') return;
		const delay = Date.parse(until) - this.now();
		if (delay <= 0) {
			void this.resume().catch((err) => this.logError('resume', err));
			return;
		}
		this.pauseTimer = setTimeout(
			() => {
				this.pauseTimer = undefined;
				if (delay > MAX_TIMER_MS) this.armPauseTimer();
				else void this.resume().catch((err) => this.logError('resume', err));
			},
			Math.min(delay, MAX_TIMER_MS)
		);
	}

	// ------------------------------------------------------------------
	// Rules
	// ------------------------------------------------------------------

	listRules(): RulesListing {
		return { rules: [...this.getConfig().rules], builtIn: builtInBlockedApps(this.platform) };
	}

	/**
	 * Add an ignore rule. Returns the rule (the existing one when already
	 * present) and, for app rules, the recently seen apps it matches by id or
	 * name, so a rule that matches nothing can be flagged to the user.
	 */
	async addRule(match: CaptureRuleMatch, value: string): Promise<RuleAddResult> {
		if (match !== 'app' && match !== 'domain') throw new Error(`Unknown rule type "${match}"`);
		const error = validateRuleInput(match, value);
		if (error) throw new Error(error);
		const normalized = normalizeRuleValue(match, value);
		const config = this.getConfig();
		const existing = config.rules.find((r) => r.match === match && r.value === normalized);
		if (existing) return { rule: existing, matches: await this.appsMatching(existing) };
		const rule: CaptureRule = {
			id: ruleIdFor(match, normalized),
			match,
			value: normalized,
			action: 'ignore',
		};
		config.rules = [...config.rules, rule];
		await this.saveConfig(config);
		this.configureHelper();
		return { rule, matches: await this.appsMatching(rule) };
	}

	/** Remember an app the helper reported (bounded), for rule match previews. */
	private noteSeenApp(app: { id: string; name: string } | undefined): void {
		if (!app) return;
		this.seenApps.delete(app.id);
		this.seenApps.set(app.id, app.name);
		if (this.seenApps.size > MAX_SEEN_APPS) {
			const oldest = this.seenApps.keys().next().value;
			if (oldest !== undefined) this.seenApps.delete(oldest);
		}
	}

	/**
	 * Apps seen recently (this session's helper events plus the app ids in the
	 * last RULE_PREVIEW_DAYS of index lines) that an app rule matches.
	 */
	private async appsMatching(rule: CaptureRule): Promise<SeenApp[]> {
		if (rule.match !== 'app') return [];
		const seen = new Map<string, string | undefined>(this.seenApps);
		try {
			const since = this.now() - RULE_PREVIEW_DAYS * 86_400_000;
			for (const entry of await readIndex(this.storeDir)) {
				if (Date.parse(entry.end) < since) continue;
				for (const id of Object.keys(entry.apps ?? {})) if (!seen.has(id)) seen.set(id, undefined);
			}
		} catch {
			// An unreadable index only narrows the preview.
		}
		const out: SeenApp[] = [];
		for (const [id, name] of seen) {
			if (appRuleMatches(rule.value, { id, name })) out.push(name ? { id, name } : { id });
		}
		return out;
	}

	/** Remove a rule by id or by value. Returns the removed rule, or null. */
	async removeRule(idOrValue: string): Promise<CaptureRule | null> {
		const config = this.getConfig();
		const q = idOrValue.trim();
		const lower = q.toLowerCase();
		const rule =
			config.rules.find((r) => r.id === q) ??
			config.rules.find((r) => r.value === normalizeRuleValue(r.match, lower));
		if (!rule) return null;
		config.rules = config.rules.filter((r) => r !== rule);
		await this.saveConfig(config);
		this.configureHelper();
		return rule;
	}

	// ------------------------------------------------------------------
	// Clear
	// ------------------------------------------------------------------

	/**
	 * Delete recorded history. `sinceMs`: every segment whose window ends after
	 * that instant (the boundary segment goes whole, erring toward deleting).
	 * `all`: segments, digests, and the index; config and SCHEMA.md stay.
	 */
	async clear(options: { sinceMs?: number; all?: boolean }): Promise<ClearResult> {
		if (!options.all && options.sinceMs === undefined) {
			throw new Error('Specify a start time or clear everything');
		}
		// Digests first: a consult in flight for a cleared window must discard
		// its answer rather than write it after the delete.
		this.digests.cancel(options.all ? { all: true } : { sinceMs: options.sinceMs! });
		const result = await this.writer.exclusive(async () => {
			if (options.all) {
				const files = await listSegmentFiles(this.storeDir);
				this.writer.dropCurrentUnsafe();
				await fsp.rm(resolveStorePath(this.storeDir, SEGMENTS_DIR), {
					recursive: true,
					force: true,
				});
				await fsp.rm(resolveStorePath(this.storeDir, DIGESTS_DIR), {
					recursive: true,
					force: true,
				});
				await this.queue.enqueue(INDEX_QUEUE_KEY, () =>
					fsp.rm(resolveStorePath(this.storeDir, INDEX_FILE), { force: true })
				);
				return {
					deletedSegments: files.length,
					freedBytes: files.reduce((sum, f) => sum + f.bytes, 0),
				};
			}
			const sinceMs = options.sinceMs!;
			const doomed = (await listSegmentFiles(this.storeDir)).filter(
				(f) => f.startMs + SEGMENT_MS > sinceMs
			);
			const current = this.writer.currentInfo();
			if (current && doomed.some((f) => f.file === current.file)) this.writer.dropCurrentUnsafe();
			const freedBytes = await deleteSegments(this.storeDir, doomed, this.queue);
			// Digests covering the cleared range go too: 15-minute digests whose
			// window overlaps it (deleteSegments got those with a segment) and every
			// 6-hour roll-up whose block overlaps it.
			for (const d of await listDigests(this.storeDir, { sinceMs })) {
				await fsp.rm(resolveStorePath(this.storeDir, d.file), { force: true });
			}
			return { deletedSegments: doomed.length, freedBytes };
		});
		this.notify(true);
		return result;
	}

	// ------------------------------------------------------------------
	// Permissions
	// ------------------------------------------------------------------

	/**
	 * macOS: show the Accessibility prompt for Maestro (the helper is Maestro's
	 * child, so TCC attributes it to Maestro). Linux: ask the helper to turn on
	 * the session accessibility bus (D12; the caller confirmed with the user).
	 * Windows: nothing to do.
	 */
	async requestAccessibility(): Promise<AccessibilityRequestResult> {
		if (this.platform === 'windows') {
			return { platform: 'windows', outcome: 'not_required' };
		}
		if (this.platform === 'macos') {
			const check = this.deps.isMacAccessibilityTrusted;
			if (check?.(false)) return { platform: 'macos', outcome: 'granted' };
			check?.(true);
			return {
				platform: 'macos',
				outcome: 'prompted',
				detail:
					'macOS opened System Settings > Privacy & Security > Accessibility. Turn Maestro on there; recording starts on its own within a few seconds.',
			};
		}
		if (!this.supervisor.send({ cmd: 'enable-accessibility' })) {
			return {
				platform: 'linux',
				outcome: 'helper-not-running',
				detail: 'Turn Computer History on first; the recorder flips the accessibility switch.',
			};
		}
		return {
			platform: 'linux',
			outcome: 'enabled',
			detail:
				'Accessibility is on for this session. Apps started from now on expose their text; restart apps that were already open (browsers and Electron apps especially).',
		};
	}

	// ------------------------------------------------------------------
	// Reads (UI recent activity; the CLI reads disk directly with the same reader)
	// ------------------------------------------------------------------

	async query(options: QueryOptions): Promise<QueryResult> {
		const limit = Math.min(options.limit ?? 200, MAX_QUERY_LIMIT);
		return queryEvents(this.storeDir, { ...options, limit });
	}

	async apps(range: TimeRange): Promise<AppUsage[]> {
		return summarizeApps(this.storeDir, range);
	}

	// ------------------------------------------------------------------
	// Internals
	// ------------------------------------------------------------------

	private blockPids(): number[] {
		return this.deps.getBlockPids?.() ?? [process.pid];
	}

	/** Send the helper its exclusions and caps (and re-assert pause). */
	private configureHelper(): void {
		const config = this.getConfig();
		const appRules = config.rules.filter((r) => r.match === 'app').map((r) => r.value);
		this.supervisor.send({
			cmd: 'configure',
			blockApps: [...new Set([...builtInBlockedApps(this.platform), ...appRules])],
			blockPids: this.blockPids(),
			blockDomains: config.rules.filter((r) => r.match === 'domain').map((r) => r.value),
			snapshots: config.snapshots,
			maxTextBytes: MAX_TEXT_BYTES,
			maxSnapshotBytes: MAX_SNAPSHOT_BYTES,
		});
		if (isPausedAt(config.pausedUntil, this.now())) this.supervisor.send({ cmd: 'pause' });
	}

	private async runRetentionSafely(): Promise<void> {
		const config = this.getConfig();
		try {
			const result = await runRetention({
				storeDir: this.storeDir,
				retentionDays: config.retentionDays,
				maxBytes: config.maxBytes,
				nowMs: this.now(),
				queue: this.queue,
				protectFile: this.writer.currentInfo()?.file ?? null,
			});
			if (result.deletedSegments > 0) {
				this.deps.log?.(
					'info',
					`Computer History retention removed ${result.deletedSegments} segment(s)`
				);
			}
		} catch (err) {
			this.logError('retention', err);
		}
	}

	/** Background failures (no caller to throw to): log and report to Sentry. */
	private logError(operation: string, err: unknown): void {
		void captureException(err instanceof Error ? err : new Error(String(err)), {
			operation: `computerHistory:${operation}`,
		});
		this.deps.log?.(
			'error',
			`Computer History ${operation} failed: ${err instanceof Error ? err.message : String(err)}`
		);
	}
}
