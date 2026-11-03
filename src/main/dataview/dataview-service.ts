/**
 * The Dataview service (D2, DV-3 to DV-7): the one owner of every open `VaultIndex` in the main process.
 *
 * - One index per `(root, sshRemoteId)`, opened on first use. `getIndex(filePath, agent)` resolves the
 *   file's vault root (DV-4) and returns that root's index, ready to query.
 * - An index nobody queried for {@link DATAVIEW_INDEX_IDLE_MS} is disposed: its watcher or poller stops
 *   and its pending cache write lands. At most {@link DATAVIEW_MAX_OPEN_ROOTS} roots stay open; opening
 *   one more disposes the least recently queried.
 * - Revisions never go back for a root. A reopened index (after idle disposal, eviction, or a rebuild)
 *   counts on from where the last one stopped, so a consumer that keyed a result by `(root, revision)`
 *   never mistakes a new answer for an old one.
 * - `onChange` relays every index's changes with the root they belong to (DV-7).
 * - Each root's DQL runs on that root's query worker (`DataviewQueryRunner`), never on this thread, so a
 *   slow query cannot freeze the app; the runner is disposed with its index.
 *
 * IPC handlers and the WS bridge (the CLI) both call this one instance (`getDataviewService()`), so every
 * surface reads the same index. The request methods (`query`, `queryInline`, `indexStatus`, `rebuildIndex`,
 * and DataviewJS's `jsSnapshot` and `readInRoot`) are the handler bodies: they take the wire requests,
 * resolve the agent in main, and answer in wire form. The quit handler calls `shutdownDataviewService()`.
 *
 * DataviewJS (D3, D4): `jsSnapshot` and `readInRoot` are what a sandboxed script can learn about a vault, so
 * they also refuse unless the DataviewJS setting is on and the note's root is trusted: in
 * `dataviewJsTrustedRoots` (read live on every request), or granted for this app session by a block's
 * "Run once" (`grantJsRunOnce`). `readInRoot` re-checks the path in main whatever the renderer checked.
 *
 * Trust (D3, D8): `trustedRootList`, `trustRoot`, and `untrustRoot` are the one way the settings UI and the
 * CLI read and edit `dataviewJsTrustedRoots`, and `onTrustedRootsChange` tells the windows to reload
 * settings after an edit. `untrustRoot` also revokes that root's "Run once" grants.
 *
 * Gate (D3): while the `dataview` Encore Feature is off, every request method, `getIndex`, and `rebuild`
 * throw `encoreDisabledMessage('dataview')` (the text a gated CLI verb prints) before touching anything, so no root opens and nothing is
 * watched. The Encore lifecycle's `stopAll` hook ({@link createDataviewSupervisorHooks}) disposes what was
 * open when the flag turned off.
 */

import * as path from 'path';
import { app } from 'electron';
import { getSettingsStore, getSshRemoteById } from '../stores/getters';
import { encoreDisabledMessage, isEncoreFeatureEnabled } from '../../shared/encoreFeatureDefaults';
import { sshUnresolvedRemoteMessage } from '../../shared/maestro-lib/launch/ssh-spawn-wrapper';
import { isAbsolutePath } from '../../shared/formatters';
import {
	extractDataviewBlocks,
	type DataviewChangeEvent,
	type DataviewErrorResult,
	type DataviewFileBlock,
	type DataviewFileQueryRequest,
	type DataviewFileQueryResult,
	type DataviewIndexStatus,
	type DataviewInlineQueryRequest,
	type DataviewInlineResult,
	type DataviewQueryRequest,
	type DataviewQueryResponse,
	type DataviewJsRoot,
	type DataviewJsRootRequest,
	type DataviewJsSnapshotRequest,
	type DataviewReadInRootRequest,
	type DataviewReadInRootResponse,
	type DataviewRebuildRequest,
	type DataviewResult,
	type DataviewStatusRequest,
	type DataviewTrustRequest,
	type DataviewTrustResponse,
	type SandboxSnapshotPayload,
} from '../../shared/dataview';
import {
	cleanTrustedRoots,
	isTrustableDataviewRoot,
	isTrustedDataviewRoot,
	normalizeTrustedRoot,
	withTrustedRoot,
	withoutTrustedRoot,
} from '../../shared/dataview/trust';
import { normalizeRootRelativePath } from '../../shared/pathContainment';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { DATAVIEW_CACHE_DIR_NAME, dataviewCachePath, deleteVaultCache } from './vault-cache';
import {
	createLocalVaultFs,
	createRemoteVaultFs,
	isIndexedVaultPath,
	type VaultFs,
} from './vault-fs';
import { VaultIndex } from './vault-index';
import { DataviewQueryRunner, type DataviewQueryRunnerOptions } from './query-runner';
import { resolveVaultRoot } from './vault-root';
import { toVaultRelativePath } from './vault-watcher';
import { resolveDataviewAgentContext } from './agent-context';
import type { FirstPartySupervisorHooks } from '../plugins/first-party-bridge';

const LOG_CONTEXT = 'Dataview';

/** An index with no query for this long is disposed (watcher stopped, cache flushed). */
export const DATAVIEW_INDEX_IDLE_MS = 10 * 60 * 1000;

/** Most roots indexed at once. Opening one more disposes the least recently queried. */
export const DATAVIEW_MAX_OPEN_ROOTS = 8;

/** The largest file a DataviewJS script may read (`dv.io.load`, `dv.io.csv`, `dv.view`). */
export const DATAVIEW_JS_MAX_READ_BYTES = 16 * 1024 * 1024;

/** Why a DataviewJS request was refused while the DataviewJS setting is off. */
export const DATAVIEW_JS_DISABLED_MESSAGE =
	'Dataview: DataviewJS is turned off. Turn on Run DataviewJS in the Dataview settings.';

/** Why a DataviewJS request was refused in a vault that is not trusted. */
export function dataviewJsUntrustedMessage(root: string): string {
	return `Dataview: DataviewJS does not run in ${root}, a vault that is not trusted.`;
}

/** The agent a query runs for: where a file outside any vault is rooted, and which remote it lives on. */
export interface DataviewAgentContext {
	agentCwd: string;
	sshRemoteId?: string | null;
}

// The wire shapes live in `src/shared/dataview/types.ts`, so the preload and the CLI can name them.
export type { DataviewChangeEvent, DataviewIndexStatus };

export type DataviewChangeListener = (event: DataviewChangeEvent) => void;

export interface DataviewServiceOptions {
	/** The folder holding cache files. Null keeps nothing on disk. Defaults to `<userData>/dataview-cache`. */
	cacheDir?: () => string | null;
	/** Defaults to `resolveVaultRoot`. */
	resolveRoot?: typeof resolveVaultRoot;
	/** Defaults to a local `VaultFs`, or a remote one for a configured SSH remote. */
	createVaultFs?: (root: string, sshRemoteId: string | null) => VaultFs;
	/** Whether indexes watch (local) or poll (remote) once open. Defaults to true. */
	watch?: boolean;
	/** Defaults to `resolveDataviewAgentContext` (the stored agent record). */
	resolveAgent?: (agentId: string) => DataviewAgentContext;
	/** Whether the `dataview` Encore Feature is on. Defaults to reading the settings store. */
	isEnabled?: () => boolean;
	/** Whether the DataviewJS setting is on. Defaults to reading the settings store. */
	isJsEnabled?: () => boolean;
	/** The trusted vault roots (`dataviewJsTrustedRoots`). Defaults to reading the settings store. */
	trustedRoots?: () => readonly unknown[];
	/** Store a new trust list. Defaults to writing the settings store. */
	setTrustedRoots?: (roots: string[]) => void;
	/** How each root's queries run (`query-runner.ts`). Defaults to a worker thread per root. */
	queryRunner?: DataviewQueryRunnerOptions;
}

export type DataviewTrustedRootsListener = (roots: string[]) => void;

interface IndexEntry {
	key: string;
	index: VaultIndex;
	/** Runs the root's DQL off the main thread, under a watchdog. */
	runner: DataviewQueryRunner;
	/** Settles when the index has opened; rejects when it could not. */
	ready: Promise<void>;
	idleTimer: ReturnType<typeof setTimeout> | null;
	unsubscribe: () => void;
}

function defaultCacheDir(): string {
	return path.join(app.getPath('userData'), DATAVIEW_CACHE_DIR_NAME);
}

function defaultIsEnabled(): boolean {
	return isEncoreFeatureEnabled(getSettingsStore(), 'dataview');
}

function defaultIsJsEnabled(): boolean {
	return getSettingsStore().get('dataviewJsEnabled') === true;
}

function defaultTrustedRoots(): readonly unknown[] {
	const roots: unknown = getSettingsStore().get('dataviewJsTrustedRoots');
	return Array.isArray(roots) ? roots : [];
}

function defaultSetTrustedRoots(roots: string[]): void {
	getSettingsStore().set('dataviewJsTrustedRoots', roots);
}

function defaultVaultFs(root: string, sshRemoteId: string | null): VaultFs {
	if (!sshRemoteId) return createLocalVaultFs(root);
	const sshRemote = getSshRemoteById(sshRemoteId);
	// Never fall back to the local disk: the same path there is a different folder.
	if (!sshRemote)
		throw new Error(sshUnresolvedRemoteMessage({ enabled: true, remoteId: sshRemoteId }));
	return createRemoteVaultFs(root, sshRemote);
}

/** One spelling per root: a local root resolved and without a trailing separator, a remote one normalized. */
export function normalizeVaultRoot(root: string, sshRemoteId: string | null): string {
	if (!sshRemoteId) return path.resolve(root);
	const normalized = path.posix.normalize(root);
	return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

function rootKey(root: string, sshRemoteId: string | null): string {
	return `${sshRemoteId ?? ''}\0${root}`;
}

export class DataviewService {
	/** Open indexes in least-recently-queried order: the first entry is the next to evict. */
	private readonly entries = new Map<string, IndexEntry>();
	/** A root being disposed or having its cache deleted. A new index for it waits for this first. */
	private readonly closing = new Map<string, Promise<void>>();
	/** The revision each root's last index ended at, so a reopened one counts on from there. */
	private readonly revisionFloors = new Map<string, number>();
	private readonly listeners = new Set<DataviewChangeListener>();
	private readonly cacheDir: () => string | null;
	private readonly resolveRoot: typeof resolveVaultRoot;
	private readonly createVaultFs: (root: string, sshRemoteId: string | null) => VaultFs;
	private readonly watch: boolean;
	private readonly resolveAgent: (agentId: string) => DataviewAgentContext;
	private readonly isEnabled: () => boolean;
	private readonly isJsEnabled: () => boolean;
	private readonly trustedRoots: () => readonly unknown[];
	private readonly setTrustedRoots: (roots: string[]) => void;
	private readonly queryRunnerOptions: DataviewQueryRunnerOptions;
	private readonly trustListeners = new Set<DataviewTrustedRootsListener>();
	/** Roots a block's "Run once" opened for this app session, keyed like `entries`. Never persisted. */
	private readonly runOnceGrants = new Set<string>();

	constructor(options: DataviewServiceOptions = {}) {
		this.cacheDir = options.cacheDir ?? defaultCacheDir;
		this.resolveRoot = options.resolveRoot ?? resolveVaultRoot;
		this.createVaultFs = options.createVaultFs ?? defaultVaultFs;
		this.watch = options.watch ?? true;
		this.resolveAgent = options.resolveAgent ?? resolveDataviewAgentContext;
		this.isEnabled = options.isEnabled ?? defaultIsEnabled;
		this.isJsEnabled = options.isJsEnabled ?? defaultIsJsEnabled;
		this.trustedRoots = options.trustedRoots ?? defaultTrustedRoots;
		this.setTrustedRoots = options.setTrustedRoots ?? defaultSetTrustedRoots;
		this.queryRunnerOptions = options.queryRunner ?? {};
	}

	/** How many roots are open right now. */
	get openRootCount(): number {
		return this.entries.size;
	}

	/**
	 * The ready index of the vault `filePath` belongs to (DV-4: the nearest `.obsidian/` ancestor, else the
	 * agent's cwd), opening it on first use. Counts as a query: it keeps the root open for another
	 * {@link DATAVIEW_INDEX_IDLE_MS}. Throws when the root cannot be resolved or opened; a later call
	 * tries again.
	 */
	async getIndex(filePath: string, agent: DataviewAgentContext): Promise<VaultIndex> {
		this.requireEnabled();
		const sshRemoteId = agent.sshRemoteId ?? null;
		const root = await this.resolveRoot(filePath, { agentCwd: agent.agentCwd, sshRemoteId });
		return this.openRoot(root, sshRemoteId);
	}

	/** {@link getIndex}, answering with the root's whole entry (its query runner too). */
	private async getEntry(filePath: string, agent: DataviewAgentContext): Promise<IndexEntry> {
		this.requireEnabled();
		const sshRemoteId = agent.sshRemoteId ?? null;
		const root = await this.resolveRoot(filePath, { agentCwd: agent.agentCwd, sshRemoteId });
		return this.openRootEntry(root, sshRemoteId);
	}

	/**
	 * Run one `dataview` block with `this` bound to the note at `filePath` (`dataview:query`). Query
	 * problems come back as an error result (DV-9); a bad request, an unknown agent, an unresolvable SSH
	 * remote, or a root that cannot be opened throws.
	 */
	async query(request: DataviewQueryRequest): Promise<DataviewQueryResponse<DataviewResult>> {
		this.requireEnabled();
		const source = requireString(request?.source, 'source');
		return this.runForNote(request, ({ runner }, thisPath) => runner.dql(source, thisPath));
	}

	/** Evaluate one inline `` `= expr` `` against the note at `filePath` (`dataview:queryInline`). */
	async queryInline(
		request: DataviewInlineQueryRequest
	): Promise<DataviewQueryResponse<DataviewInlineResult>> {
		this.requireEnabled();
		const expression = requireString(request?.expression, 'expression');
		return this.runForNote(request, ({ runner }, thisPath) =>
			runner.inlineQuery(expression, thisPath)
		);
	}

	/**
	 * Run the `dataview` blocks of the note at `filePath` (`maestro-cli dataview query`): the one at
	 * position `block` among them, or every one. The note is read through the vault's own file system, so
	 * an SSH note is read on its remote. A `dataviewjs` fence is listed without a result. A `block` past
	 * the last fence answers with no blocks and the real `blockCount`.
	 */
	async queryFile(
		request: DataviewFileQueryRequest
	): Promise<DataviewQueryResponse<DataviewFileQueryResult>> {
		this.requireEnabled();
		const wanted = request?.block;
		if (wanted !== undefined && (!Number.isInteger(wanted) || wanted < 1)) {
			throw new Error('Dataview: block must be a whole number from 1');
		}
		return this.runForNote(
			request,
			async ({ index, runner }, thisPath): Promise<DataviewFileQueryResult> => {
				const fences = extractDataviewBlocks(await index.fs.readText(thisPath));
				const blocks: DataviewFileBlock[] = [];
				let position = 0;
				for (const fence of fences) {
					const block = fence.language === 'dataview' ? ++position : null;
					if (wanted !== undefined && block !== wanted) continue;
					blocks.push({
						...fence,
						block,
						...(block === null ? {} : { result: await runner.dql(fence.source, thisPath) }),
					});
				}
				return { kind: 'blocks', blockCount: position, blocks };
			}
		);
	}

	/**
	 * The index a DataviewJS run of the note at `filePath` reads (`dataview:jsSnapshot`, D4): every page's
	 * cached raw parse plus the file, folder, and star lists, as JSON text the renderer passes to the guest
	 * untouched (`SandboxSnapshotPayload`), with `path` the note `dv.current()` binds to. Refused unless
	 * DataviewJS is on and the note's vault root is trusted (D3), and for a note outside its root.
	 */
	async jsSnapshot(
		request: DataviewJsSnapshotRequest
	): Promise<DataviewQueryResponse<SandboxSnapshotPayload>> {
		this.requireJsEnabled();
		const { index, filePath, thisPath } = await this.openNote(request);
		this.requireTrustedRoot(index.root, index.fs.sshRemoteId);
		if (thisPath === null) throw new Error(outsideRootMessage(filePath, index.root));
		const payload = await index.jsSnapshotPayload();
		return {
			root: index.root,
			sshRemoteId: index.fs.sshRemoteId,
			revision: payload.revision,
			path: thisPath,
			result: payload,
		};
	}

	/**
	 * Read one text file inside the vault root of the note at `filePath`, for a DataviewJS script
	 * (`dataview:readInRoot`; `dv.io.load`, `dv.io.csv`, `dv.view`). The guest and the renderer checked the
	 * path already; main checks again and never trusts them: the path must stay inside the root once `..` is
	 * collapsed, be one the index holds (no dot folder such as `.obsidian/`, whose plugin settings can hold
	 * API tokens, and no `node_modules`), and still be inside the root once symlinks resolve
	 * (`VaultFs.readTextInRoot`). Refused unless DataviewJS is on and the root trusted. `text` is null when
	 * no such file exists.
	 */
	async readInRoot(request: DataviewReadInRootRequest): Promise<DataviewReadInRootResponse> {
		this.requireJsEnabled();
		const requested = requireString(request?.path, 'path');
		const relPath = normalizeRootRelativePath(requested);
		if (relPath === null || relPath === '') {
			throw new Error(`Dataview: ${JSON.stringify(requested)} is not a path inside the vault root`);
		}
		if (!isIndexedVaultPath(relPath)) {
			throw new Error(`Dataview: DataviewJS cannot read ${relPath}`);
		}
		const { index } = await this.openNote(request);
		this.requireTrustedRoot(index.root, index.fs.sshRemoteId);
		return {
			root: index.root,
			sshRemoteId: index.fs.sshRemoteId,
			path: relPath,
			text: await index.fs.readTextInRoot(relPath, DATAVIEW_JS_MAX_READ_BYTES),
		};
	}

	/**
	 * The vault root of the note at `filePath` (`dataview:jsRoot`), spelled as `jsSnapshot` will answer it, so
	 * a `dataviewjs` block can decide its run policy and name the vault it asks about. Resolves the root
	 * without opening its index. Refused unless DataviewJS is on.
	 */
	async jsRoot(request: DataviewJsRootRequest): Promise<DataviewJsRoot> {
		this.requireJsEnabled();
		const filePath = requireAbsolutePath(request?.filePath, 'filePath');
		const agent = this.resolveAgent(requireString(request?.agentId, 'agentId'));
		const sshRemoteId = agent.sshRemoteId ?? null;
		const root = await this.resolveRoot(filePath, { agentCwd: agent.agentCwd, sshRemoteId });
		return { root: normalizeVaultRoot(root, sshRemoteId), sshRemoteId };
	}

	/**
	 * A block's "Run once" (`dataview:jsRunOnce`, D3): let DataviewJS read the note's vault for the rest of
	 * this app session without adding it to `dataviewJsTrustedRoots`. The grant lives in memory only and is
	 * revoked by `untrustRoot` and by `disposeAll` (the Encore Feature turning off). Which blocks run is the
	 * renderer's choice; this only lets main answer them. Refused unless DataviewJS is on.
	 */
	async grantJsRunOnce(request: DataviewJsRootRequest): Promise<DataviewJsRoot> {
		const target = await this.jsRoot(request);
		this.runOnceGrants.add(rootKey(target.root, target.sshRemoteId));
		return target;
	}

	/** The trusted vault roots, cleaned (`maestro-cli dataview trusted`, the Dataview settings list). */
	trustedRootList(): string[] {
		this.requireEnabled();
		return cleanTrustedRoots(this.trustedRoots());
	}

	/**
	 * Add a vault root to `dataviewJsTrustedRoots` (`dataview:trust`, `maestro-cli dataview trust`, "Always
	 * trust this vault"). The root must be an absolute path; it is stored normalized. Writes only when the
	 * root was not on the list.
	 */
	trustRoot(request: DataviewTrustRequest): DataviewTrustResponse {
		this.requireEnabled();
		const root = requireTrustableRoot(request?.root);
		const before = cleanTrustedRoots(this.trustedRoots());
		const roots = withTrustedRoot(before, root);
		const changed = roots.length !== before.length;
		if (changed) this.writeTrustedRoots(roots);
		return { root, trusted: true, changed, roots };
	}

	/**
	 * Take a vault root off `dataviewJsTrustedRoots` (`dataview:untrust`, `maestro-cli dataview untrust`, the
	 * settings list's remove control), and revoke its "Run once" grants on every host. Writes only when the
	 * root was on the list.
	 */
	untrustRoot(request: DataviewTrustRequest): DataviewTrustResponse {
		this.requireEnabled();
		const root = requireTrustableRoot(request?.root);
		for (const key of [...this.runOnceGrants]) {
			if (normalizeTrustedRoot(key.slice(key.indexOf('\0') + 1)) === root) {
				this.runOnceGrants.delete(key);
			}
		}
		const stored = this.trustedRoots();
		const before = cleanTrustedRoots(stored);
		const roots = withoutTrustedRoot(stored, root);
		const changed = roots.length !== before.length;
		if (changed) this.writeTrustedRoots(roots);
		return { root, trusted: false, changed, roots };
	}

	/** Subscribe to trust list edits made through this service. Returns the unsubscribe function. */
	onTrustedRootsChange(listener: DataviewTrustedRootsListener): () => void {
		this.trustListeners.add(listener);
		return () => {
			this.trustListeners.delete(listener);
		};
	}

	/**
	 * Whether DataviewJS may run at all: the `dataview` Encore Feature and the DataviewJS setting both on.
	 * Never throws; the guest host reads it before it serves or attaches a guest.
	 */
	jsServing(): boolean {
		try {
			return this.isEnabled() && this.isJsEnabled();
		} catch {
			return false;
		}
	}

	/**
	 * The open roots `dataview:status` reports: the named root (none when it is not open), or every open
	 * root. Never opens anything.
	 */
	indexStatus(request: DataviewStatusRequest = {}): DataviewIndexStatus[] {
		this.requireEnabled();
		if (request.root === undefined) return this.statuses();
		const root = requireString(request.root, 'root');
		const status = this.status(root, this.remoteIdFor(request.agentId));
		return status ? [status] : [];
	}

	/** Rebuild one root from scratch (`dataview:rebuild`). */
	async rebuildIndex(request: DataviewRebuildRequest): Promise<DataviewIndexStatus> {
		this.requireEnabled();
		const root = requireAbsolutePath(request?.root, 'root');
		return this.rebuild(root, this.remoteIdFor(request.agentId));
	}

	/** The state of an open root, or null when it is not open. */
	status(root: string, sshRemoteId: string | null = null): DataviewIndexStatus | null {
		const entry = this.entries.get(rootKey(normalizeVaultRoot(root, sshRemoteId), sshRemoteId));
		return entry ? statusOf(entry.index) : null;
	}

	/** The state of every open root, most recently queried last. */
	statuses(): DataviewIndexStatus[] {
		return Array.from(this.entries.values(), (entry) => statusOf(entry.index));
	}

	/**
	 * Drop a root's disk cache and index it again from scratch. Works whether or not the root is open, and
	 * leaves it open. Resolves with the new status once the full scan has finished.
	 */
	async rebuild(root: string, sshRemoteId: string | null = null): Promise<DataviewIndexStatus> {
		this.requireEnabled();
		const normalized = normalizeVaultRoot(root, sshRemoteId);
		const key = rootKey(normalized, sshRemoteId);
		const entry = this.entries.get(key);
		if (entry) {
			this.detach(entry);
			this.trackClosing(key, () => this.disposeEntry(entry).then(() => this.dropCache(key)));
		} else {
			this.trackClosing(key, () => this.dropCache(key));
		}
		await this.closing.get(key);
		return statusOf(await this.openRoot(normalized, sshRemoteId));
	}

	/** Subscribe to every open index's changes. Returns the unsubscribe function. */
	onChange(listener: DataviewChangeListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Dispose every open index: stop every watcher, poller, and idle timer, and flush pending cache
	 * writes. The service stays usable; the next query opens its root again.
	 */
	async disposeAll(): Promise<void> {
		this.runOnceGrants.clear();
		for (const entry of [...this.entries.values()]) this.close(entry);
		await Promise.all(this.closing.values());
	}

	/** Refuse while the `dataview` Encore Feature is off (D3). */
	private requireEnabled(): void {
		if (!this.isEnabled()) throw new Error(encoreDisabledMessage('dataview'));
	}

	/** Refuse unless the Encore Feature and the DataviewJS setting are both on (D3). */
	private requireJsEnabled(): void {
		this.requireEnabled();
		if (!this.isJsEnabled()) throw new Error(DATAVIEW_JS_DISABLED_MESSAGE);
	}

	/**
	 * Refuse a root that is neither in `dataviewJsTrustedRoots` (D3, DV-12; read live on every request) nor
	 * granted by a "Run once" on its host this session.
	 */
	private requireTrustedRoot(root: string, sshRemoteId: string | null): void {
		if (this.runOnceGrants.has(rootKey(root, sshRemoteId))) return;
		if (!isTrustedDataviewRoot(root, this.trustedRoots())) {
			throw new Error(dataviewJsUntrustedMessage(root));
		}
	}

	private writeTrustedRoots(roots: string[]): void {
		this.setTrustedRoots(roots);
		for (const listener of [...this.trustListeners]) {
			try {
				listener(roots);
			} catch (error) {
				void captureException(error, { operation: 'dataview:trustedRootsListener' });
			}
		}
	}

	/**
	 * Open the index of the note a request names, and find the note in it. `thisPath` is the note's
	 * vault-relative path, or null when the agent's cwd roots the note but the note sits outside it.
	 */
	private async openNote(request: { filePath: string; agentId: string }): Promise<{
		entry: IndexEntry;
		index: VaultIndex;
		filePath: string;
		thisPath: string | null;
	}> {
		const filePath = requireAbsolutePath(request?.filePath, 'filePath');
		const agent = this.resolveAgent(requireString(request?.agentId, 'agentId'));
		const entry = await this.getEntry(filePath, agent);
		const { index } = entry;
		const pathApi = index.fs.sshRemoteId ? path.posix : path;
		return { entry, index, filePath, thisPath: toVaultRelativePath(index.root, filePath, pathApi) };
	}

	/** Open the note's index and run `run` with the note's vault-relative path bound as `this`. */
	private async runForNote<R>(
		request: { filePath: string; agentId: string },
		run: (entry: IndexEntry, thisPath: string) => Promise<R>
	): Promise<DataviewQueryResponse<R | DataviewErrorResult>> {
		const { entry, index, filePath, thisPath } = await this.openNote(request);
		const sshRemoteId = index.fs.sshRemoteId;
		// Read before running: a change that lands mid-query then carries a newer revision, and the
		// consumer re-runs instead of keeping a result that might predate it.
		const revision = index.revision;
		if (thisPath === null) {
			// The agent's cwd roots the note, but the note sits outside it: `this` has no page.
			return {
				root: index.root,
				sshRemoteId,
				revision,
				path: filePath,
				result: { kind: 'error', message: outsideRootMessage(filePath, index.root) },
			};
		}
		return {
			root: index.root,
			sshRemoteId,
			revision,
			path: thisPath,
			result: await run(entry, thisPath),
		};
	}

	/** The SSH remote of the agent that names a root; a local root without one. */
	private remoteIdFor(agentId: string | undefined): string | null {
		if (agentId === undefined) return null;
		return this.resolveAgent(requireString(agentId, 'agentId')).sshRemoteId ?? null;
	}

	private async openRoot(root: string, sshRemoteId: string | null): Promise<VaultIndex> {
		return (await this.openRootEntry(root, sshRemoteId)).index;
	}

	private async openRootEntry(root: string, sshRemoteId: string | null): Promise<IndexEntry> {
		const normalized = normalizeVaultRoot(root, sshRemoteId);
		const key = rootKey(normalized, sshRemoteId);
		let entry = this.entries.get(key);
		if (entry) {
			// Re-insert, so the map's order stays least recently queried first.
			this.entries.delete(key);
		} else {
			entry = this.createEntry(key, normalized, sshRemoteId);
		}
		this.entries.set(key, entry);
		this.armIdleTimer(entry);
		this.evictOverCap();
		await entry.ready;
		return entry;
	}

	private createEntry(key: string, root: string, sshRemoteId: string | null): IndexEntry {
		const index = new VaultIndex(this.createVaultFs(root, sshRemoteId), {
			cacheDir: this.cacheDir() ?? undefined,
			watch: this.watch,
		});
		const unsubscribe = index.onChange((change) =>
			this.emit({ root, sshRemoteId, revision: change.revision, changedPaths: change.changedPaths })
		);
		const entry: IndexEntry = {
			key,
			index,
			runner: new DataviewQueryRunner(index, this.queryRunnerOptions),
			ready: Promise.resolve(),
			idleTimer: null,
			unsubscribe,
		};
		// Wait for the root's previous index to finish closing: its last cache write lands first, and
		// its final revision is the floor this one counts on from.
		const previous = this.closing.get(key) ?? Promise.resolve();
		entry.ready = previous
			.then(() => {
				index.revision = Math.max(index.revision, this.revisionFloors.get(key) ?? 0);
				return index.open();
			})
			.catch((error: unknown) => {
				// Forget the failed index, so the next query tries again.
				if (this.entries.get(key) === entry) this.close(entry);
				throw error;
			});
		return entry;
	}

	private armIdleTimer(entry: IndexEntry): void {
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		entry.idleTimer = setTimeout(() => {
			if (this.entries.get(entry.key) !== entry) return;
			logger.debug(`Dataview closed the idle index of ${entry.index.root}`, LOG_CONTEXT);
			this.close(entry);
		}, DATAVIEW_INDEX_IDLE_MS);
		entry.idleTimer.unref?.();
	}

	private evictOverCap(): void {
		while (this.entries.size > DATAVIEW_MAX_OPEN_ROOTS) {
			const oldest = this.entries.values().next().value as IndexEntry;
			logger.debug(
				`Dataview closed the index of ${oldest.index.root}: more than ${DATAVIEW_MAX_OPEN_ROOTS} roots open`,
				LOG_CONTEXT
			);
			this.close(oldest);
		}
	}

	/** Take an entry out of service now and dispose it in the background. */
	private close(entry: IndexEntry): void {
		this.detach(entry);
		this.trackClosing(entry.key, () => this.disposeEntry(entry));
	}

	/** Stop routing queries and events to an entry. Synchronous, so the next query opens a new one. */
	private detach(entry: IndexEntry): void {
		if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		entry.idleTimer = null;
		entry.unsubscribe();
	}

	/** Run `work` after anything already closing this root, and record it as the root's closing step. */
	private trackClosing(key: string, work: () => Promise<void>): void {
		const step = (this.closing.get(key) ?? Promise.resolve()).then(work).catch((error: unknown) => {
			logger.warn(`Dataview could not close an index cleanly: ${String(error)}`, LOG_CONTEXT);
			void captureException(error, { operation: 'dataview:closeIndex' });
		});
		const done = step.finally(() => {
			if (this.closing.get(key) === done) this.closing.delete(key);
		});
		this.closing.set(key, done);
	}

	private async disposeEntry(entry: IndexEntry): Promise<void> {
		// An index still opening finishes first (or fails), so dispose sees its final state.
		await entry.ready.catch(() => undefined);
		await entry.index.dispose();
		await entry.runner.dispose();
		const floor = this.revisionFloors.get(entry.key) ?? 0;
		this.revisionFloors.set(entry.key, Math.max(floor, entry.index.revision));
	}

	private async dropCache(key: string): Promise<void> {
		const cacheDir = this.cacheDir();
		if (!cacheDir) return;
		const separator = key.indexOf('\0');
		const sshRemoteId = key.slice(0, separator) || null;
		await deleteVaultCache(dataviewCachePath(cacheDir, key.slice(separator + 1), sshRemoteId));
	}

	private emit(event: DataviewChangeEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (error) {
				logger.warn(`Dataview change listener failed: ${String(error)}`, LOG_CONTEXT);
			}
		}
	}
}

/** Why a note outside its vault root has no page to bind `this` to. */
function outsideRootMessage(filePath: string, root: string): string {
	return `Dataview: ${filePath} is outside the vault root ${root}`;
}

/** A request field that must be a non-empty string. Requests cross IPC and the WS bridge unchecked. */
function requireString(value: unknown, name: string): string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new Error(`Dataview: ${name} must be a non-empty string`);
	}
	return value;
}

/** A request path that must be absolute: main has no meaningful cwd to resolve a relative one against. */
function requireAbsolutePath(value: unknown, name: string): string {
	const text = requireString(value, name);
	if (!isAbsolutePath(text)) throw new Error(`Dataview: ${name} must be an absolute path`);
	return text;
}

/** A root for the trust list: an absolute path, returned as the list stores it (`normalizeTrustedRoot()`). */
function requireTrustableRoot(value: unknown): string {
	const text = requireString(value, 'root');
	if (!isTrustableDataviewRoot(text)) throw new Error('Dataview: root must be an absolute path');
	return normalizeTrustedRoot(text);
}

function statusOf(index: VaultIndex): DataviewIndexStatus {
	return {
		root: index.root,
		sshRemoteId: index.fs.sshRemoteId,
		pageCount: index.pages.size,
		revision: index.revision,
		lastScanDurationMs: index.lastScan?.durationMs ?? null,
		lastScanAt: index.lastScan?.finishedAt ?? null,
		cacheHit: index.cacheHit,
		watchMode: index.watchMode,
	};
}

let service: DataviewService | null = null;

/** The singleton, created on first use. */
export function getDataviewService(): DataviewService {
	service ??= new DataviewService();
	return service;
}

/**
 * Dispose every open index on app quit. Never creates the service. Quit force-exits shortly after
 * cleanup, so a cache write cut off here is lost; the next open reconciles the root by `mtime` and `size`.
 */
export function shutdownDataviewService(): Promise<void> {
	return service?.disposeAll() ?? Promise.resolve();
}

/**
 * The Encore lifecycle hooks for the `dataview.index` background service (D3). Indexes open on demand, so
 * `reconcile` has nothing to start; `stopAll` disposes every index, watcher, poller, and idle timer when
 * the flag turns off. Never creates the service.
 */
export function createDataviewSupervisorHooks(
	getService: () => Pick<DataviewService, 'disposeAll'> | null = () => service
): FirstPartySupervisorHooks {
	return {
		reconcile: () => {},
		stopAll: () => {
			void getService()
				?.disposeAll()
				.catch((err) => void captureException(err, { operation: 'dataview:stopAll' }));
		},
	};
}

/** Test seam. */
export function setDataviewServiceForTests(next: DataviewService | null): void {
	service = next;
}
