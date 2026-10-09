/**
 * Codex Usage Snapshot Store
 *
 * Caches ChatGPT/Codex quota snapshots per canonical CODEX_HOME account. This
 * mirrors the Claude plan usage store shape without coupling Codex quota
 * data to Claude's `CLAUDE_CONFIG_DIR` semantics - including the two-clock
 * rule: expired at 24h (no longer returned as live), kept on disk until
 * `SNAPSHOT_RETENTION_MS` so the dashboard can still draw the account's last
 * known bars instead of dropping the row.
 */

import os from 'os';
import path from 'path';
import Store from 'electron-store';

import type { CodexResetCreditCounts } from '../../shared/codexResetCredits';
import { partitionSnapshotsByAge, SNAPSHOT_RETENTION_MS } from './usageSnapshotRetention';

export { SNAPSHOT_RETENTION_MS } from './usageSnapshotRetention';

export interface CodexUsageWindow {
	percent: number;
	resetsAt: string;
	/**
	 * Length of the window the percentage is measured over, in seconds, when the
	 * quota endpoint declares it. This is what files a window as a session or a
	 * weekly bucket - the slot it arrived in does not, because plans order the
	 * two differently. Undefined on responses that omit `limit_window_seconds`.
	 */
	windowSeconds?: number;
}

export interface CodexAdditionalLimit {
	name: string;
	percent: number;
	resetsAt?: string;
	/** Length of this sublimit's window, in seconds, when the endpoint declares it. */
	windowSeconds?: number;
}

export type CodexUsageAuthState = 'authenticated' | 'missing_auth' | 'unauthenticated' | 'error';

export interface CodexUsageSnapshot {
	sampledAt: string;
	codexHomeKey: string;
	authState: CodexUsageAuthState;
	label?: string;
	email?: string;
	planType?: string;
	session?: CodexUsageWindow;
	weekly?: CodexUsageWindow;
	additionalLimits?: CodexAdditionalLimit[];
	/**
	 * Reset-credit inventory, which the usage payload carries for free. The
	 * per-credit list lives behind `fetchCodexResetCredits()`; this is only the
	 * count, so the dashboard can render "2 resets available" without a second
	 * request per account per refresh.
	 */
	resetCredits?: CodexResetCreditCounts;
	error?: string;
}

export const CODEX_USAGE_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

interface CodexUsageStoreData {
	snapshots: Record<string, CodexUsageSnapshot>;
}

const STORE_NAME = 'codex-usage-snapshots';
const STORE_DEFAULTS: CodexUsageStoreData = { snapshots: {} };

let _store: Store<CodexUsageStoreData> | null = null;

function getStore(): Store<CodexUsageStoreData> {
	if (_store === null) {
		_store = new Store<CodexUsageStoreData>({
			name: STORE_NAME,
			defaults: STORE_DEFAULTS,
		});
	}
	return _store;
}

function readPartitioned(now: number) {
	const store = getStore();
	const current = store.get('snapshots', {});
	const partitioned = partitionSnapshotsByAge(
		current,
		now,
		CODEX_USAGE_SNAPSHOT_TTL_MS,
		SNAPSHOT_RETENTION_MS
	);
	if (partitioned.prunedAny) {
		store.set('snapshots', partitioned.retained);
	}
	return partitioned;
}

export function setCodexUsageSnapshot(snapshot: CodexUsageSnapshot): void {
	const store = getStore();
	const { retained } = readPartitioned(Date.now());
	store.set('snapshots', { ...retained, [snapshot.codexHomeKey]: snapshot });
}

/** Decision-grade map: unexpired snapshots only. */
export function getAllCodexUsageSnapshots(): Record<string, CodexUsageSnapshot> {
	return readPartitioned(Date.now()).live;
}

/**
 * Display-grade map: everything still within retention, expired included, so a
 * Codex account with no agents on it keeps its dashboard row.
 */
export function getRetainedCodexUsageSnapshots(): Record<string, CodexUsageSnapshot> {
	return readPartitioned(Date.now()).retained;
}

export function clearCodexUsageSnapshots(): void {
	getStore().set('snapshots', {});
}

export function resolveCodexHomeKey(env: NodeJS.ProcessEnv): string {
	const raw =
		typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.length > 0
			? env.CODEX_HOME
			: path.join(os.homedir(), '.codex');
	return path.resolve(raw);
}

export function __resetForTests(): void {
	_store = null;
}
