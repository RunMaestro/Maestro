/**
 * Codex Usage Snapshot Store
 *
 * Caches ChatGPT/Codex quota snapshots per canonical CODEX_HOME account. This
 * mirrors the Claude plan usage store shape without coupling Codex quota
 * data to Claude's `CLAUDE_CONFIG_DIR` semantics.
 */

import os from 'os';
import path from 'path';
import Store from 'electron-store';
import { createUsageSnapshotEnvelope } from './usageSnapshotEnvelope';

export interface CodexUsageWindow {
	percent: number;
	resetsAt: string;
}

export interface CodexAdditionalLimit {
	name: string;
	percent: number;
	resetsAt?: string;
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
	error?: string;
}

export const CODEX_USAGE_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_STORE_VERSION = 1;

interface CodexUsageStoreData {
	version?: number;
	snapshots: Record<string, CodexUsageSnapshot>;
}

const STORE_NAME = 'codex-usage-snapshots';
const STORE_DEFAULTS: CodexUsageStoreData = { version: SNAPSHOT_STORE_VERSION, snapshots: {} };

const snapshotEnvelope = createUsageSnapshotEnvelope<CodexUsageSnapshot>({
	version: SNAPSHOT_STORE_VERSION,
	ttlMs: CODEX_USAGE_SNAPSHOT_TTL_MS,
	getKey: (snapshot) => snapshot.codexHomeKey,
});

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

export function setCodexUsageSnapshot(snapshot: CodexUsageSnapshot): void {
	snapshotEnvelope.set(getStore(), snapshot);
}

export function getAllCodexUsageSnapshots(): Record<string, CodexUsageSnapshot> {
	return snapshotEnvelope.getAll(getStore());
}

export function clearCodexUsageSnapshots(): void {
	snapshotEnvelope.clear(getStore());
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
