/**
 * Provider Auth Snapshot Store
 *
 * Singleton wrapper around an electron-store namespace that caches the login
 * state of each credential identity, keyed by `CredentialIdentity.key`. The
 * probe layer (`main/agents/auth/auth-probe.ts`) writes here, the reactive
 * `auth_expired` path marks entries logged out here, and the UI reads here. One
 * record per identity is the whole point: fifteen agents on one Anthropic
 * account share one snapshot, so they surface one badge instead of fifteen.
 *
 * Unlike `claudeUsageStore.ts` - whose shape this otherwise mirrors - snapshots
 * do NOT expire. A quota reading goes stale and becomes wrong; a login state
 * goes stale and stays useful, since "logged out 40 minutes ago" is still the
 * best thing we know. {@link PROBE_STALE_MS} governs when to RE-PROBE, not when
 * to forget, and dropping a record only ever loses information the next probe
 * would have to spend a spawn to rediscover.
 *
 * The `Store` instance is created lazily on first method call so tests can
 * `vi.mock('electron-store')` before the module is touched.
 */

import Store from 'electron-store';

import type {
	CredentialIdentity,
	ProviderAuthSnapshot,
	ProviderAuthSource,
	ProviderAuthStatus,
} from '../../shared/providerAuth';

// Re-export so consumers can grab the types from either module.
export type {
	ProviderAuthSnapshot,
	ProviderAuthSource,
	ProviderAuthStatus,
} from '../../shared/providerAuth';

/**
 * How long a snapshot is treated as fresh enough to skip re-probing. Lives here
 * rather than at each call site so the startup pass, a manual refresh, and any
 * future scheduler all share one cadence.
 */
export const PROBE_STALE_MS = 15 * 60 * 1000;

/**
 * Cap on `detail`. It is a one-line explanation for a badge, so anything longer
 * is a pasted stack trace or a command line that got in by accident.
 */
const MAX_DETAIL_LENGTH = 300;

/**
 * Secret shapes that must never reach disk or the renderer, even though the
 * contract says producers already stripped them. Order matters only in that the
 * catch-all runs last: an unbroken 40+ character run of token characters is an
 * opaque blob, never an email, an org name, or a plan tier.
 */
const SECRET_PATTERNS: RegExp[] = [
	/\bBearer\s+\S+/gi,
	/\bsk-[A-Za-z0-9_-]{8,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{8,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{8,}/g,
	/[A-Za-z0-9_-]{40,}/g,
];

interface ProviderAuthStoreData {
	snapshots: Record<string, ProviderAuthSnapshot>;
}

const STORE_NAME = 'provider-auth-snapshots';
const STORE_DEFAULTS: ProviderAuthStoreData = { snapshots: {} };

let _store: Store<ProviderAuthStoreData> | null = null;

/**
 * Lazily create (or return) the backing electron-store instance. Tests that
 * `vi.mock('electron-store')` before importing this module rely on this lazy
 * init - constructing eagerly at module-load would capture the real Store class
 * before the mock is installed.
 */
function getStore(): Store<ProviderAuthStoreData> {
	if (_store === null) {
		_store = new Store<ProviderAuthStoreData>({
			name: STORE_NAME,
			defaults: STORE_DEFAULTS,
		});
	}
	return _store;
}

/**
 * Last line of defense on `detail` before it is persisted or pushed to the
 * renderer: replace anything token-shaped and cap the length. Producers are
 * still responsible for not putting a secret here in the first place - this
 * exists because a snapshot is written from parsed CLI output, and one provider
 * echoing a token in an error string should not turn into a secret on disk.
 */
function scrubDetail(detail: string | undefined): string | undefined {
	if (typeof detail !== 'string') {
		return undefined;
	}
	let scrubbed = detail;
	for (const pattern of SECRET_PATTERNS) {
		scrubbed = scrubbed.replace(pattern, '[redacted]');
	}
	scrubbed = scrubbed.trim();
	if (scrubbed.length > MAX_DETAIL_LENGTH) {
		scrubbed = `${scrubbed.slice(0, MAX_DETAIL_LENGTH)}...`;
	}
	return scrubbed === '' ? undefined : scrubbed;
}

/** Apply {@link scrubDetail} without mutating the caller's object. */
function sanitize(snapshot: ProviderAuthSnapshot): ProviderAuthSnapshot {
	const detail = scrubDetail(snapshot.detail);
	const next: ProviderAuthSnapshot = { ...snapshot };
	if (detail === undefined) {
		delete next.detail;
	} else {
		next.detail = detail;
	}
	return next;
}

/**
 * One snapshot write, as handed to a {@link onSnapshotChange} listener.
 * `snapshot` is null when the record was cleared.
 */
export interface ProviderAuthChange {
	key: string;
	snapshot: ProviderAuthSnapshot | null;
}

type ProviderAuthChangeListener = (change: ProviderAuthChange) => void;

const changeListeners = new Set<ProviderAuthChangeListener>();

/**
 * Subscribe to snapshot writes. Returns an unsubscribe function.
 *
 * This lives on the store rather than at each writer so no write path can
 * forget to announce itself: the startup pass, a manual re-probe, and the
 * reactive `auth_expired` marker all go through `setSnapshot`, so registering
 * the renderer broadcaster once here covers all three (and whatever writes next).
 *
 * Listeners MUST NOT throw - they run inline on the write path.
 */
export function onSnapshotChange(listener: ProviderAuthChangeListener): () => void {
	changeListeners.add(listener);
	return () => {
		changeListeners.delete(listener);
	};
}

function emitChange(change: ProviderAuthChange): void {
	for (const listener of changeListeners) {
		listener(change);
	}
}

/** Read one snapshot by identity key. Returns null when nothing is stored. */
export function getSnapshot(key: string): ProviderAuthSnapshot | null {
	return getStore().get('snapshots', {})[key] ?? null;
}

/** Every stored snapshot, keyed by `CredentialIdentity.key`. */
export function getAllSnapshots(): Record<string, ProviderAuthSnapshot> {
	return { ...getStore().get('snapshots', {}) };
}

/**
 * Write a snapshot. The explicit `key` argument wins over
 * `snapshot.identity.key` so a caller that already deduped on a key cannot
 * accidentally file the result under a second one.
 */
export function setSnapshot(key: string, snapshot: ProviderAuthSnapshot): void {
	const store = getStore();
	const next = { ...store.get('snapshots', {}) };
	const sanitized = sanitize(snapshot);
	next[key] = sanitized;
	store.set('snapshots', next);
	emitChange({ key, snapshot: sanitized });
}

/**
 * The two statuses a failure may be recorded as without running a probe.
 *
 * `logged-out` means an interactive login can fix it; `unsupported` means no
 * login flow exists for this credential (a revoked API key, a gateway operator's
 * token, a provider with no probe). Keeping the second one out of `logged-out`
 * is what stops the UI from offering a login button that cannot work.
 */
export type AuthFailureStatus = Extract<ProviderAuthStatus, 'logged-out' | 'unsupported'>;

/**
 * Record an auth failure against an identity, preserving the identity already on
 * record.
 *
 * `identity` is optional because the usual caller is the reactive `auth_expired`
 * path, which is reacting to a key it just resolved. It is needed only when
 * nothing is stored yet - a real case, since an agent can hit an auth failure
 * before the startup pass ever probed it (an unsupported provider, a probe that
 * timed out, a fresh install). Without it there is no identity to file the
 * record under, so the call is a no-op and returns null rather than persisting a
 * half-record the UI cannot render.
 *
 * Returns the stored snapshot so the caller can broadcast it.
 */
export function markAuthFailure(
	key: string,
	status: AuthFailureStatus,
	detail: string | undefined,
	source: ProviderAuthSource,
	identity?: CredentialIdentity
): ProviderAuthSnapshot | null {
	const existing = getSnapshot(key);
	const resolvedIdentity = existing?.identity ?? identity;
	if (!resolvedIdentity) {
		return null;
	}
	const snapshot: ProviderAuthSnapshot = {
		identity: resolvedIdentity,
		status,
		checkedAt: Date.now(),
		source,
	};
	// Keep the account label from the last successful probe: knowing WHICH
	// account fell out is the difference between an actionable badge and a
	// mystery for anyone running more than one login.
	if (existing?.accountLabel) {
		snapshot.accountLabel = existing.accountLabel;
	}
	if (detail !== undefined) {
		snapshot.detail = detail;
	}
	setSnapshot(key, snapshot);
	return getSnapshot(key);
}

/** {@link markAuthFailure} with the `logged-out` status. */
export function markLoggedOut(
	key: string,
	detail: string | undefined,
	source: ProviderAuthSource,
	identity?: CredentialIdentity
): ProviderAuthSnapshot | null {
	return markAuthFailure(key, 'logged-out', detail, source, identity);
}

/** Drop one snapshot. A missing key is a no-op. */
export function clearSnapshot(key: string): void {
	const store = getStore();
	const current = store.get('snapshots', {});
	if (!(key in current)) {
		return;
	}
	const next = { ...current };
	delete next[key];
	store.set('snapshots', next);
	emitChange({ key, snapshot: null });
}

/**
 * True when a snapshot is recent enough that re-probing would just burn a
 * spawn. A missing or unparseable `checkedAt` reads as stale so a corrupted
 * record self-heals on the next pass.
 */
export function isSnapshotFresh(
	snapshot: ProviderAuthSnapshot | null | undefined,
	now: number = Date.now()
): boolean {
	if (!snapshot || typeof snapshot.checkedAt !== 'number' || Number.isNaN(snapshot.checkedAt)) {
		return false;
	}
	return now - snapshot.checkedAt < PROBE_STALE_MS;
}

/**
 * Test-only hook: reset the cached singleton so the next call constructs a
 * fresh `Store`, and drop every change listener so one test's broadcaster
 * cannot fire on another test's writes. Not part of the module's public API.
 */
export function __resetForTests(): void {
	_store = null;
	changeListeners.clear();
}
