/**
 * Remembered Quota Accounts
 *
 * Durable, provider-keyed list of the plan accounts Maestro has actually used
 * on this machine (canonical `CLAUDE_CONFIG_DIR` / `CODEX_HOME` paths).
 *
 * Why this exists: the Usage Dashboard derived its account list from live
 * agents, on-disk discovery, and unexpired snapshots. When an account hits its
 * limit the user moves every agent off it, and the row then depends entirely on
 * the other two sources. Discovery only finds real directories named
 * `~/.claude-*` / `~/.codex-*` (it skips symlinks, dirs outside $HOME, and
 * names like `-local` / `-old`), and the snapshot expires 24h after the last
 * sample - so the account the user most wants to watch, the one they are
 * waiting on a reset for, is exactly the one that disappears.
 *
 * A remembered key is not a guess: it is written when a sampler actually
 * targeted that account for a session. Entries are dropped only when their
 * directory is gone from disk (`pruneMissingQuotaAccounts`), so deleting an
 * account dir still removes the row. The cached usage snapshots follow the same
 * rule through `dropSnapshotsForMissingAccounts`.
 *
 * The `Store` instance is created lazily on first call so tests can
 * `vi.mock('electron-store')` before the module is touched.
 */

import * as fs from 'fs';
import * as path from 'path';
import Store from 'electron-store';

/** One remembered account. `accountKey` is the canonical (resolved) dir path. */
export interface RememberedQuotaAccount {
	accountKey: string;
	/** First time any sampler targeted this account. */
	firstSeenAt: number;
	/** Most recent time any sampler targeted it. */
	lastSeenAt: number;
}

interface QuotaAccountsData {
	/** providerId -> accountKey -> record. */
	accounts: Record<string, Record<string, RememberedQuotaAccount>>;
}

const STORE_NAME = 'quota-accounts';
const STORE_DEFAULTS: QuotaAccountsData = { accounts: {} };

let _store: Store<QuotaAccountsData> | null = null;

function getStore(): Store<QuotaAccountsData> {
	if (_store === null) {
		_store = new Store<QuotaAccountsData>({
			name: STORE_NAME,
			defaults: STORE_DEFAULTS,
		});
	}
	return _store;
}

function readAll(): Record<string, Record<string, RememberedQuotaAccount>> {
	const raw = getStore().get('accounts', {});
	return raw && typeof raw === 'object' ? raw : {};
}

/**
 * Record every key in `accountKeys` as an account this provider has used.
 * Existing entries keep their `firstSeenAt` and refresh `lastSeenAt`. Empty or
 * non-string keys are ignored, so a caller can pass a raw map's keys.
 */
export function rememberQuotaAccounts(providerId: string, accountKeys: Iterable<string>): void {
	const keys = Array.from(accountKeys).filter((key) => typeof key === 'string' && key.length > 0);
	if (keys.length === 0) return;

	const now = Date.now();
	const all = readAll();
	const forProvider = { ...(all[providerId] ?? {}) };
	for (const accountKey of keys) {
		const existing = forProvider[accountKey];
		forProvider[accountKey] = {
			accountKey,
			firstSeenAt: existing?.firstSeenAt ?? now,
			lastSeenAt: now,
		};
	}
	getStore().set('accounts', { ...all, [providerId]: forProvider });
}

/** Every remembered account for a provider, oldest-known first. */
export function getRememberedQuotaAccounts(providerId: string): RememberedQuotaAccount[] {
	return Object.values(readAll()[providerId] ?? {}).sort((a, b) => a.firstSeenAt - b.firstSeenAt);
}

/** Just the canonical keys, in the same order as `getRememberedQuotaAccounts`. */
export function getRememberedQuotaAccountKeys(providerId: string): string[] {
	return getRememberedQuotaAccounts(providerId).map((entry) => entry.accountKey);
}

/** Drop specific remembered accounts (no-op for keys that aren't remembered). */
export function forgetQuotaAccounts(providerId: string, accountKeys: Iterable<string>): void {
	const keys = new Set(Array.from(accountKeys));
	if (keys.size === 0) return;

	const all = readAll();
	const forProvider = all[providerId];
	if (!forProvider) return;

	const next: Record<string, RememberedQuotaAccount> = {};
	let removedAny = false;
	for (const [key, entry] of Object.entries(forProvider)) {
		if (keys.has(key)) {
			removedAny = true;
			continue;
		}
		next[key] = entry;
	}
	if (!removedAny) return;
	getStore().set('accounts', { ...all, [providerId]: next });
}

/**
 * The account keys (canonical dir paths) whose directory is definitely gone.
 * Only a definite "not there" (ENOENT / ENOTDIR) counts: an unreadable or
 * temporarily unmounted dir is treated as present rather than silently losing
 * the account the user is waiting on. A key that is not an absolute path is
 * not a local directory, so it is never reported missing.
 *
 * One rule for every surface that drops an account on deletion: the remembered
 * account list below, and the cached usage snapshots the dashboard draws
 * (`dropSnapshotsForMissingAccounts`).
 */
export async function findMissingAccountDirs(accountKeys: Iterable<string>): Promise<Set<string>> {
	const missing = new Set<string>();
	await Promise.all(
		Array.from(new Set(accountKeys)).map(async (key) => {
			if (!path.isAbsolute(key)) return;
			try {
				await fs.promises.access(key, fs.constants.F_OK);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code === 'ENOENT' || code === 'ENOTDIR') missing.add(key);
			}
		})
	);
	return missing;
}

/**
 * Forget remembered accounts whose directory no longer exists, and return the
 * keys that survived (see `findMissingAccountDirs` for what counts as gone).
 */
export async function pruneMissingQuotaAccounts(providerId: string): Promise<string[]> {
	const keys = getRememberedQuotaAccountKeys(providerId);
	if (keys.length === 0) return [];

	const missing = await findMissingAccountDirs(keys);
	if (missing.size > 0) {
		forgetQuotaAccounts(providerId, missing);
	}
	// Preserve the store's ordering.
	return keys.filter((key) => !missing.has(key));
}

/**
 * Remove snapshots whose account dir is gone, from both the returned map and
 * the backing store (`forget`). Snapshots are retained for weeks past their TTL
 * so an idle account keeps its dashboard row, which also kept a DELETED
 * account's row on the panel for those weeks: the account list forgot it, but
 * every snapshot key is a row of its own.
 */
export async function dropSnapshotsForMissingAccounts<T>(
	snapshots: Record<string, T>,
	forget: (keys: Iterable<string>) => void
): Promise<Record<string, T>> {
	const missing = await findMissingAccountDirs(Object.keys(snapshots));
	if (missing.size === 0) return snapshots;
	forget(missing);
	const kept: Record<string, T> = {};
	for (const [key, snapshot] of Object.entries(snapshots)) {
		if (!missing.has(key)) kept[key] = snapshot;
	}
	return kept;
}

/** Drop every remembered account for every provider. Test/reset helper. */
export function clearRememberedQuotaAccounts(): void {
	getStore().set('accounts', {});
}

export function __resetForTests(): void {
	_store = null;
}
