/**
 * Plugin authorization ledger (main process) - the security gate.
 *
 * Replaces the old plain-JSON enable-state + grants files with ONE sealed,
 * profile-wide ledger plus a freshness anchor held OUTSIDE the rollable file
 * tree (the OS credential store). This is what upholds the contract: a plugin,
 * however installed, can never enable or grant itself by modifying files.
 *
 * Layers:
 *  - SEAL (confidentiality + integrity at rest): the ledger JSON is sealed with
 *    Electron `safeStorage`. A file-writer without the OS key cannot read it or
 *    produce a blob we accept.
 *  - FRESHNESS ANCHOR (anti-rollback): a monotonic `epoch` + per-install secret
 *    live in a NAMED OS credential entry. Every mint/revoke/uninstall bumps the
 *    epoch and writes it into both the ledger and the anchor. On load we require
 *    `ledger.epoch === anchor.epoch` and matching install secret, so restoring
 *    an OLD sealed ledger (a rollback) is rejected - its epoch is stale.
 *  - TOMBSTONES: uninstall/revoke records `{ pluginId, removedAtEpoch }`, so a
 *    re-appearing plugin folder is a fresh install (disabled, re-consent), never
 *    a silent re-enable.
 *  - FAIL-SAFE = SESSION-ONLY: if the seal or the anchor is unavailable (e.g. a
 *    keyring-less headless Linux), grants are NOT persisted as trusted. They live
 *    in memory for the session and are re-consented next launch. There is NO mode
 *    in which authorization persists silently without the anchor. Uniform on
 *    every OS.
 *
 * The store is dependency-injected (seal / anchor / paths / clock) so the
 * rollback, tombstone, tamper, and session-only paths are unit-testable with
 * fakes; production wiring (`createAuthorizationStore`) binds `safeStorage` and
 * the keyring.
 */

import { PluginAuthorityError, assertPluginAuthority, pluginJson } from './plugin-authority';
import {
	PLUGIN_RECORD_KEY_PATTERN,
	isPluginEndpointScope,
	isStoredPluginEndpointScope,
	parsePluginEndpointScopes,
	type PluginRecordValue,
} from '../../shared/plugins/primitives';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes, createHmac, createHash, timingSafeEqual } from 'crypto';
import { canonicalJson } from '../../shared/canonicalJson';
import { yieldToEventLoop } from '../utils/concurrency';
import type { PluginEventReceiptRow } from './plugin-cue-events';
import { assertSerializedJsonIsSafe } from '../../shared/jsonUtils';
import { isAllowlistScoped, isValidAllowlistMember } from '../../shared/plugins/permissions';
import type { PermissionGrant, PluginCapability } from '../../shared/plugins/permissions';
import type { SignatureStatus } from '../../shared/plugins/signing';
import { PLUGIN_ID_PATTERN } from '../../shared/plugins/plugin-manifest';
import {
	createKeyringAnchor,
	keyringAnchor,
	noAnchor,
	createKeyringEntry,
} from '../utils/keyring-anchor';
import type { Anchor, AnchorStore, KeyringEntry, KeyringModule } from '../utils/keyring-anchor';
import { safeStorageSeal } from '../utils/safe-storage-seal';
import type { SafeStorageLike, SealProvider } from '../utils/safe-storage-seal';

const AUTHORIZATION_LEDGER_LIMITS = {
	plaintextBytes: 20 * 1024 * 1024,
	ciphertextBytes: 24 * 1024 * 1024,
};

/** Schema version of the sealed ledger payload. */
export const LEDGER_VERSION = 3 as const;

/** The identity a grant is bound to: the file digest PLUS the signature/trust
 * identity. Trust status drives policy (the transcripts+egress conflict is only
 * enforced for untrusted plugins) and the signer is part of what the user
 * approved, so a post-consent signer/trust change must force re-consent even
 * when files are unchanged (the content digest excludes signature.json). */
export interface AuthIdentity {
	contentHash: string;
	signatureStatus: SignatureStatus;
	signerKey: string | null;
}

/** One plugin's persisted authorization. */
export interface LedgerEntry {
	/** User toggled it on (an explicit consent gesture minted this). */
	enabled: boolean;
	/** The exact capability set the user approved (subset of the manifest's). */
	caps: PermissionGrant[];
	/** Identity (content digest + signature/trust) bound at consent time. Any
	 * change → the verifier disables the plugin → re-consent. */
	identity: AuthIdentity;
	/** When this entry was last minted (audit). */
	mintedAt: number;
}

/** A removed/revoked plugin - blocks silent re-enable of a restored folder. */
export interface Tombstone {
	pluginId: string;
	removedAtEpoch: number;
}

interface OpaquePluginState {
	identity: AuthIdentity;
	records: Record<string, PluginRecordValue>;
	secrets: Record<
		string,
		{ key: string; endpoint: string; ref: string; removal?: 'pending' | 'removed' }
	>;
}
/** The full sealed ledger. */
export interface AuthorizationLedger {
	version: typeof LEDGER_VERSION;
	/** Monotonic; mirrored in the anchor. A regression means a rollback. */
	epoch: number;
	/** Binds the ledger to this install's anchor; mismatch → re-consent. */
	installSecret: string;
	entries: Record<string, LedgerEntry>;
	tombstones: Tombstone[];
	/** Inert prior-schema fields preserved for explicit disabled import, never authorization. */
	legacy?: { schemaVersion: number; fields: Record<string, unknown> };
	opaque?: Record<string, OpaquePluginState>;
	opaqueArchive?: { pluginId: string; state: OpaquePluginState }[];
}

// The seal primitive lives in `utils/safe-storage-seal.ts` so every sealed
// store shares one copy. Re-exported so this module's importers are unchanged.
export { safeStorageSeal };
export type { SafeStorageLike, SealProvider };

// The freshness anchor and its keyring binding live in `utils/keyring-anchor.ts`
// for the same reason. Re-exported so this module's importers are unchanged.
export { createKeyringAnchor, keyringAnchor, noAnchor, createKeyringEntry };
export type { Anchor, AnchorStore, KeyringEntry, KeyringModule };

export interface AuthorizationStoreDeps {
	seal: SealProvider;
	anchor: AnchorStore;
	/** Absolute path of the sealed ledger file. */
	ledgerPath: string;
	now?: () => number;
	newSecret?: () => string;
}

/** Why the persisted ledger was not trusted this session (for UI / audit). */
export type LedgerTrustState =
	| 'persistent' // sealed + anchored + fresh: trusted, persists across restarts
	| 'session-only' // seal/anchor unavailable: in-memory grants, re-consent next launch
	| 're-consent'; // tamper / rollback / anchor mismatch: persisted state dropped

function emptyLedger(installSecret: string): AuthorizationLedger {
	return {
		version: LEDGER_VERSION,
		epoch: 0,
		installSecret,
		entries: {},
		tombstones: [],
	};
}

type LoadedLedger = Omit<AuthorizationLedger, 'version'> & { version: 1 | 2 | 3; mail?: unknown };

function isLedger(value: unknown): value is LoadedLedger {
	if (typeof value !== 'object' || value === null) return false;
	const allowed = [
		'version',
		'epoch',
		'installSecret',
		'entries',
		'tombstones',
		'mail',
		'opaque',
		'opaqueArchive',
		'legacy',
	];
	if (Object.keys(value).some((key) => !allowed.includes(key))) return false;
	if (
		!('version' in value) ||
		!('epoch' in value) ||
		!('installSecret' in value) ||
		!('entries' in value) ||
		!('tombstones' in value)
	) {
		return false;
	}
	return (
		[1, 2, 3].includes(value.version as number) &&
		typeof value.epoch === 'number' &&
		Number.isSafeInteger(value.epoch) &&
		value.epoch >= 0 &&
		typeof value.installSecret === 'string' &&
		typeof value.entries === 'object' &&
		value.entries !== null &&
		!Array.isArray(value.entries) &&
		Array.isArray(value.tombstones)
	);
}

/** Why a plugin's verification resolved the way it did (for the UI / audit). */
export type VerifyReason = 'ok' | 'not-authorized' | 'identity-changed' | 'removed';

/** Result of verifying a discovered plugin against its consented authorization. */
export interface VerifyResult {
	authorized: boolean;
	reason: VerifyReason;
	/** Caps to hand the broker - empty unless `authorized`. */
	caps: PermissionGrant[];
}

export function shouldDisablePluginForVerifyResult(result: VerifyResult): boolean {
	return !result.authorized;
}

/**
 * The authorization gate. Holds the verified in-memory view of the ledger plus,
 * in session-only mode, the ephemeral grants minted this run.
 */

export class AuthorizationStore {
	private readonly authorizationListeners = new Set<(pluginId: string) => void>();
	onPluginAuthorizationChange(listener: (pluginId: string) => void): () => void {
		this.authorizationListeners.add(listener);
		return () => {
			this.authorizationListeners.delete(listener);
		};
	}
	private notifyAuthorizationChange(pluginId: string): void {
		for (const listener of this.authorizationListeners) listener(pluginId);
	}

	private readonly seal: SealProvider;
	private readonly anchor: AnchorStore;
	private readonly ledgerPath: string;
	private readonly now: () => number;
	private readonly newSecret: () => string;

	/** The trusted view. In persistent mode this mirrors disk; in session-only
	 * mode it starts empty and accumulates this run's grants (never written). */
	private ledger: AuthorizationLedger;
	private storageMode: 'persistent' | 'session-only';
	private droppedPriorState = false;
	private loaded = false;

	constructor(deps: AuthorizationStoreDeps) {
		this.seal = deps.seal;
		this.anchor = deps.anchor;
		this.ledgerPath = deps.ledgerPath;
		this.now = deps.now ?? (() => Date.now());
		this.newSecret = deps.newSecret ?? (() => randomBytes(32).toString('base64url'));
		this.ledger = emptyLedger('');
		this.storageMode = 'session-only';
	}

	/**
	 * Reporting state for the Plugins UI / audit log:
	 *  - `session-only`  storage unavailable → grants live in memory, re-consent next launch
	 *  - `re-consent`    persistent storage, but prior persisted state was dropped at load
	 *                    (tamper / rollback / anchor mismatch) so plugins need re-approval
	 *  - `persistent`    sealed + anchored + fresh; grants persist across restarts
	 */
	trustState(): LedgerTrustState {
		this.ensureLoaded();
		if (this.storageMode === 'session-only') return 'session-only';
		return this.droppedPriorState ? 're-consent' : 'persistent';
	}

	/** True ONLY when authorization cannot persist at all (no seal / no anchor). This
	 * is storage mode, NOT the transient re-consent signal: a re-consent load still
	 * persists once the user re-approves, so it reports false here. */
	isSessionOnly(): boolean {
		this.ensureLoaded();
		return this.storageMode === 'session-only';
	}

	/** True when the prior persisted ledger was dropped at load (tamper / rollback /
	 * anchor mismatch); the UI should prompt re-approval. Cleared once a fresh
	 * authoritative write re-establishes the ledger. */
	priorStateDropped(): boolean {
		this.ensureLoaded();
		return this.droppedPriorState;
	}

	/**
	 * Load + verify the persisted ledger once. Any failure (no seal, no anchor,
	 * tamper, rollback, anchor mismatch) fails safe: the in-memory ledger starts
	 * empty and nothing persisted is trusted until the user re-consents.
	 */
	private ensureLoaded(): void {
		if (this.loaded) return;
		this.loaded = true;

		// No seal or no anchor → session-only. We cannot verify freshness, so we
		// refuse to silently honor anything on disk.
		if (!this.seal.available() || !this.anchor.available()) {
			this.ledger = emptyLedger(this.newSecret());
			this.storageMode = 'session-only';
			return;
		}

		const anchor = this.anchor.read();
		if (!anchor) {
			this.ledger = emptyLedger(this.newSecret());
			this.storageMode = 'persistent';
			if (fs.existsSync(this.ledgerPath)) {
				// Existing sealed bytes without the keyring freshness anchor are
				// untrustworthy. Do not persist here: persisting would clear
				// droppedPriorState and silently bless a replacement anchor before the
				// user re-consents. The next mint writes a fresh authoritative ledger.
				this.droppedPriorState = true;
				return;
			}
			this.persist(); // clean first run: establish anchor at epoch 0
			return;
		}

		let parsed: unknown = null;
		try {
			// Bound the opened file, including a concurrent growth, before decrypting.
			const fd = fs.openSync(this.ledgerPath, 'r');
			let blob: Buffer;
			try {
				const size = fs.fstatSync(fd).size;
				if (
					!Number.isSafeInteger(size) ||
					size < 1 ||
					size > AUTHORIZATION_LEDGER_LIMITS.ciphertextBytes
				)
					throw new Error();
				blob = Buffer.alloc(size);
				let offset = 0;
				while (offset < size) {
					const count = fs.readSync(fd, blob, offset, size - offset, null);
					if (!count) throw new Error();
					offset += count;
				}
				if (fs.readSync(fd, Buffer.alloc(1), 0, 1, null)) throw new Error();
			} finally {
				fs.closeSync(fd);
			}
			const plaintext = this.seal.unseal(blob);
			if (
				plaintext.length > AUTHORIZATION_LEDGER_LIMITS.plaintextBytes ||
				Buffer.byteLength(plaintext) > AUTHORIZATION_LEDGER_LIMITS.plaintextBytes
			)
				throw new Error();
			parsed = JSON.parse(plaintext);
			if (isLedger(parsed) && parsed.opaque !== undefined) this.validateOpaqueState(parsed.opaque);
			if (isLedger(parsed) && parsed.opaqueArchive !== undefined) {
				if (!Array.isArray(parsed.opaqueArchive))
					throw new PluginAuthorityError('PLUGIN_INTEGRITY');
				for (const item of parsed.opaqueArchive) {
					if (!item || typeof item.pluginId !== 'string')
						throw new PluginAuthorityError('PLUGIN_INTEGRITY');
					this.validateOpaqueState(Object.fromEntries([[item.pluginId, item.state]]));
				}
			}
		} catch {
			parsed = null; // missing, unsealable (tampered/foreign), or unparseable
		}

		if (
			!isLedger(parsed) ||
			parsed.installSecret !== anchor.installSecret || // anchor reset / foreign ledger
			parsed.epoch !== anchor.epoch // ROLLBACK: restored an old sealed ledger
		) {
			// Drop the untrusted persisted state; keep the anchor authoritative.
			// Re-mint the ledger empty at the anchor's epoch so future writes are
			// consistent, but the user must re-consent for any plugin.
			this.ledger = emptyLedger(anchor.installSecret);
			this.ledger.epoch = anchor.epoch;
			this.storageMode = 'persistent';
			this.droppedPriorState = true;
			return;
		}

		this.ledger = {
			version: LEDGER_VERSION,
			epoch: parsed.epoch,
			installSecret: parsed.installSecret,
			entries: parsed.entries,
			tombstones: parsed.tombstones,
			...(parsed.opaque ? { opaque: parsed.opaque } : {}),
			...(parsed.opaqueArchive
				? {
						opaqueArchive: parsed.opaqueArchive.flatMap((item) => {
							const state = this.cleanupOnlyOpaqueState(item.state);
							return state ? [{ pluginId: item.pluginId, state }] : [];
						}),
					}
				: {}),
			...(parsed.version < 3
				? {
						legacy: {
							schemaVersion: parsed.version,
							fields: {
								entries: JSON.parse(canonicalJson(parsed.entries)),
								tombstones: JSON.parse(canonicalJson(parsed.tombstones)),
								...(Object.prototype.hasOwnProperty.call(parsed, 'mail')
									? { mail: parsed.mail }
									: {}),
							},
						},
					}
				: parsed.legacy
					? { legacy: parsed.legacy }
					: {}),
		};
		this.storageMode = 'persistent';
		// Loading never rewrites prior state. A fresh authoritative user action persists schema3.
	}

	/** Seal + write the ledger and bump/write the anchor. No-op in session-only
	 * mode (nothing is ever written to disk or the credential store then). */
	private persist(): void {
		if (this.storageMode === 'session-only') return;
		try {
			if (!this.seal.available() || !this.anchor.available()) throw new Error();
			const plaintext = JSON.stringify(this.ledger);
			assertSerializedJsonIsSafe(plaintext, 'authorization ledger');
			if (Buffer.byteLength(plaintext) > AUTHORIZATION_LEDGER_LIMITS.plaintextBytes)
				throw new Error();
			const blob = this.seal.seal(plaintext);
			if (!blob.length || blob.length > AUTHORIZATION_LEDGER_LIMITS.ciphertextBytes)
				throw new Error();
			// Anchor first: a locked/unavailable credential store throws here, before
			// we commit a ledger file the anchor can't vouch for.
			this.anchor.write({ installSecret: this.ledger.installSecret, epoch: this.ledger.epoch });
			const confirmed = this.anchor.read();
			if (
				confirmed?.installSecret !== this.ledger.installSecret ||
				confirmed.epoch !== this.ledger.epoch
			)
				throw new Error();
			const dir = path.dirname(this.ledgerPath);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			const tmp = `${this.ledgerPath}.tmp`;
			fs.writeFileSync(tmp, blob, { mode: 0o600 });
			fs.renameSync(tmp, this.ledgerPath);
			this.droppedPriorState = false;
		} catch {
			// Seal / anchor / disk failure (locked keyring, read-only disk, …). Fail
			// safe: degrade to session-only so this run's grants live only in memory
			// and nothing is left half-persisted. Any partial write is caught next
			// launch by the epoch check → re-consent.
			this.storageMode = 'session-only';
		}
	}

	/** Pure schema check for generic sealed state; never interpret plugin values. */
	private validateOpaqueState(value: unknown): void {
		if (
			!value ||
			typeof value !== 'object' ||
			Array.isArray(value) ||
			Object.keys(value).length > 1024
		)
			throw new PluginAuthorityError('PLUGIN_INTEGRITY');
		for (const [id, item] of Object.entries(value)) {
			if (!PLUGIN_ID_PATTERN.test(id) || !item || typeof item !== 'object')
				throw new PluginAuthorityError('PLUGIN_INTEGRITY');
			const state = item as OpaquePluginState;
			if (
				!state.identity ||
				!/^[0-9a-f]{64}$/.test(state.identity.contentHash) ||
				!['unsigned', 'invalid', 'untrusted', 'trusted'].includes(state.identity.signatureStatus) ||
				(state.identity.signerKey !== null && typeof state.identity.signerKey !== 'string') ||
				!state.records ||
				typeof state.records !== 'object' ||
				Array.isArray(state.records) ||
				!state.secrets ||
				typeof state.secrets !== 'object' ||
				Array.isArray(state.secrets) ||
				Object.keys(state.records).length > 64 ||
				Object.keys(state.secrets).length > 64
			)
				throw new PluginAuthorityError('PLUGIN_INTEGRITY');
			for (const [key, record] of Object.entries(state.records)) {
				if (
					!PLUGIN_RECORD_KEY_PATTERN.test(key) ||
					!Number.isSafeInteger(record.revision) ||
					record.revision < 1
				)
					throw new PluginAuthorityError('PLUGIN_INTEGRITY');
				pluginJson(record.value, 64 * 1024);
			}
			for (const [ref, secret] of Object.entries(state.secrets)) {
				if (
					!/^[0-9a-f]{64}$/.test(ref) ||
					secret.ref !== ref ||
					!PLUGIN_RECORD_KEY_PATTERN.test(secret.key) ||
					!isStoredPluginEndpointScope(secret.endpoint) ||
					(secret.removal !== undefined && !['pending', 'removed'].includes(secret.removal))
				)
					throw new PluginAuthorityError('PLUGIN_INTEGRITY');
			}
		}
	}

	/** Generic storage NEVER inherits the ledger's session-only authorization fallback. */
	private assertPersistentInstallation(): void {
		this.ensureLoaded();
		if (
			this.storageMode !== 'persistent' ||
			this.droppedPriorState ||
			!this.seal.available() ||
			!this.anchor.available()
		)
			throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
		const anchor = this.anchor.read();
		if (anchor?.installSecret !== this.ledger.installSecret || anchor.epoch !== this.ledger.epoch)
			throw new PluginAuthorityError('PLUGIN_INTEGRITY');
	}
	assertPluginPersistent(pluginId: string, identity: AuthIdentity): void {
		this.assertPersistentInstallation();
		const entry = this.ledger.entries[pluginId];
		if (!entry?.enabled || canonicalJson(entry.identity) !== canonicalJson(identity))
			throw new PluginAuthorityError('PLUGIN_DENIED');
	}
	private pluginState(pluginId: string, identity: AuthIdentity): OpaquePluginState | undefined {
		this.assertPluginPersistent(pluginId, identity);
		const state = this.ledger.opaque?.[pluginId];
		if (state && canonicalJson(state.identity) !== canonicalJson(identity))
			throw new PluginAuthorityError('PLUGIN_DENIED');
		return state;
	}
	/** Bound admission of new state, never retirement of existing authority.
	 * Archives are cleanup-only: pluginState never rehydrates them, even on same-identity mint. */
	private assertOpaqueStateCapacity(pluginId: string): void {
		if (
			!this.ledger.opaque?.[pluginId] &&
			Object.keys(this.ledger.opaque ?? {}).length + (this.ledger.opaqueArchive?.length ?? 0) >=
				1024
		)
			throw new PluginAuthorityError('PLUGIN_LIMIT');
	}
	readPluginRecord(
		pluginId: string,
		identity: AuthIdentity,
		key: string
	): PluginRecordValue | null {
		if (!PLUGIN_RECORD_KEY_PATTERN.test(key)) throw new PluginAuthorityError('PLUGIN_INVALID');
		const records = this.pluginState(pluginId, identity)?.records;
		const value =
			records && Object.prototype.hasOwnProperty.call(records, key) ? records[key] : undefined;
		return value ? { revision: value.revision, value: pluginJson(value.value, 64 * 1024) } : null;
	}
	/** Host-confirmation only. No RPC may pass its own assertion to this method. */
	commitPluginRecord(
		pluginId: string,
		identity: AuthIdentity,
		key: string,
		expectedRevision: number,
		value: unknown,
		assertConfirmed: () => void
	): number {
		const snapshot = pluginJson(value, 64 * 1024);
		if (
			!PLUGIN_RECORD_KEY_PATTERN.test(key) ||
			!Number.isSafeInteger(expectedRevision) ||
			expectedRevision < 0 ||
			expectedRevision >= Number.MAX_SAFE_INTEGER
		)
			throw new PluginAuthorityError('PLUGIN_INVALID');
		assertPluginAuthority(assertConfirmed);
		const state = this.pluginState(pluginId, identity);
		if (
			(state && Object.prototype.hasOwnProperty.call(state.records, key)
				? state.records[key].revision
				: 0) !== expectedRevision
		)
			throw new PluginAuthorityError('PLUGIN_CONFLICT');
		if (
			!(state && Object.prototype.hasOwnProperty.call(state.records, key)) &&
			Object.keys(state?.records ?? {}).length >= 64
		)
			throw new PluginAuthorityError('PLUGIN_LIMIT');
		const epoch = this.ledger.epoch;
		assertPluginAuthority(assertConfirmed);
		this.assertPluginPersistent(pluginId, identity);
		if (epoch !== this.ledger.epoch) throw new PluginAuthorityError('PLUGIN_CONFLICT');
		this.notifyAuthorizationChange(pluginId);
		if (epoch !== this.ledger.epoch) throw new PluginAuthorityError('PLUGIN_CONFLICT');
		this.assertOpaqueStateCapacity(pluginId);
		const next: OpaquePluginState = state ?? {
			identity: { ...identity },
			records: {},
			secrets: {},
		};
		this.ledger.opaque ??= {};
		next.records = { ...next.records, [key]: { revision: expectedRevision + 1, value: snapshot } };
		this.ledger.opaque[pluginId] = next;
		this.bump();
		this.persist();
		this.assertPluginPersistent(pluginId, identity);
		return expectedRevision + 1;
	}
	/** Host keyring namespace; an installation secret is never returned. */
	pluginSecretSlot(pluginId: string, identity: AuthIdentity, ref: string): string {
		this.assertPluginPersistent(pluginId, identity);
		if (!/^[0-9a-f]{64}$/.test(ref)) throw new PluginAuthorityError('PLUGIN_INVALID');
		return this.secretSlot(pluginId, identity, ref);
	}
	private secretSlot(pluginId: string, identity: AuthIdentity, ref: string): string {
		return createHmac('sha256', this.ledger.installSecret)
			.update(canonicalJson(['plugin-secret-v1', pluginId, identity, ref]))
			.digest('hex');
	}
	/** Reserve cleanup provenance durably before any native write; never consumable yet. */
	registerPluginSecret(
		pluginId: string,
		identity: AuthIdentity,
		key: string,
		endpoint: string,
		ref: string,
		assertConfirmed: () => void
	): void {
		if (
			!PLUGIN_RECORD_KEY_PATTERN.test(key) ||
			!isPluginEndpointScope(endpoint) ||
			!/^[0-9a-f]{64}$/.test(ref)
		)
			throw new PluginAuthorityError('PLUGIN_INVALID');
		assertPluginAuthority(assertConfirmed);
		this.pluginState(pluginId, identity);
		this.assertOpaqueStateCapacity(pluginId);
		const state = this.pluginState(pluginId, identity) ?? {
			identity: { ...identity },
			records: {},
			secrets: {},
		};
		if (Object.keys(state.secrets).length >= 64 || state.secrets[ref])
			throw new PluginAuthorityError('PLUGIN_LIMIT');
		const epoch = this.ledger.epoch;
		assertPluginAuthority(assertConfirmed);
		this.assertPluginPersistent(pluginId, identity);
		if (epoch !== this.ledger.epoch) throw new PluginAuthorityError('PLUGIN_CONFLICT');
		this.ledger.opaque ??= {};
		state.secrets = { ...state.secrets, [ref]: { key, endpoint, ref, removal: 'pending' } };
		this.ledger.opaque[pluginId] = state;
		this.bump();
		this.persist();
		this.assertPluginPersistent(pluginId, identity);
	}
	assertPluginSecret(
		pluginId: string,
		identity: AuthIdentity,
		ref: string,
		endpoint: string
	): void {
		const secret = this.pluginState(pluginId, identity)?.secrets[ref];
		if (
			!isPluginEndpointScope(endpoint) ||
			!secret ||
			secret.removal ||
			secret.endpoint !== endpoint
		)
			throw new PluginAuthorityError('PLUGIN_DENIED');
	}
	/** Generic freshness fence: opaque authority revisions, never domain values. */
	pluginRecordRevision(pluginId: string, identity: AuthIdentity): string {
		const records = this.pluginState(pluginId, identity)?.records ?? {};
		return createHash('sha256')
			.update(
				canonicalJson(
					Object.fromEntries(Object.entries(records).map(([key, value]) => [key, value.revision]))
				)
			)
			.digest('hex');
	}
	/** Exact authenticated durable source metadata. Not a producer-supplied proof. */
	pluginEventProof(
		pluginId: string,
		identity: AuthIdentity,
		source: unknown,
		metadata: unknown,
		purpose: 'event' | 'receipt' = 'event'
	): string {
		this.assertPluginPersistent(pluginId, identity);
		return this.computePluginEventProof(pluginId, identity, source, metadata, purpose);
	}
	private computePluginEventProof(
		pluginId: string,
		identity: AuthIdentity,
		source: unknown,
		metadata: unknown,
		purpose: 'event' | 'receipt'
	): string {
		if (purpose === 'receipt' && (identity.signatureStatus !== 'trusted' || !identity.signerKey))
			throw new PluginAuthorityError('PLUGIN_DENIED');
		return createHmac('sha256', this.ledger.installSecret)
			.update(
				canonicalJson(
					purpose === 'receipt'
						? [
								'plugin-receipt-v2',
								pluginId,
								identity.signerKey,
								pluginJson(source),
								pluginJson(metadata),
							]
						: ['plugin-event-v1', identity, pluginJson(source), pluginJson(metadata)]
				)
			)
			.digest('hex');
	}

	/** Verify old receipt evidence, never historical authority. No grant/epoch mutation.
	 * The caller still needs current authorized identity and exact historical tuple/key
	 * matching before returning a duplicate. An unknown identity is never guessed.
	 */
	authenticateHistoricalPluginReceipt(
		_pluginId: string,
		identity: AuthIdentity,
		id: string,
		row: { receiptId: string; payloadHash: string; proof: string }
	): boolean {
		this.assertPersistentInstallation();
		return this.authenticateHistoricalReceipt(identity, id, row);
	}
	private authenticateHistoricalReceipt(
		identity: AuthIdentity,
		id: string,
		row: PluginEventReceiptRow
	): boolean {
		if (
			identity.signatureStatus !== 'trusted' ||
			!identity.signerKey ||
			!/^[0-9a-f]{64}$/.test(identity.contentHash) ||
			![id, row.receiptId, row.payloadHash, row.proof].every((value) =>
				/^[0-9a-f]{64}$/.test(value)
			)
		)
			return false;
		const expected = createHmac('sha256', this.ledger.installSecret)
			.update(
				canonicalJson([
					'plugin-event-v1',
					identity,
					{ id, receiptId: row.receiptId },
					{ payloadHash: row.payloadHash },
				])
			)
			.digest('hex');
		return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(row.proof, 'hex'));
	}

	/** Bounded evidence verification. No authority snapshot escapes this operation.
	 * Yield between small batches; read the native anchor once per batch, not per row.
	 * An epoch change at any yield invalidates the whole retained-history result. */
	async authenticatePluginReceiptRows(
		pluginId: string,
		current: AuthIdentity,
		rows: {
			id: string;
			row: PluginEventReceiptRow;
			identity?: AuthIdentity;
			purpose: 'event' | 'receipt';
		}[]
	): Promise<boolean[]> {
		if (rows.length > 4096) throw new PluginAuthorityError('PLUGIN_LIMIT');
		this.assertPluginPersistent(pluginId, current);
		const epoch = this.ledger.epoch;
		const verified: boolean[] = [];
		for (let offset = 0; offset < rows.length; offset += 16) {
			await yieldToEventLoop();
			this.assertPluginPersistent(pluginId, current);
			if (this.ledger.epoch !== epoch) throw new PluginAuthorityError('PLUGIN_CONFLICT');
			for (const item of rows.slice(offset, offset + 16)) {
				if (item.purpose === 'event') {
					verified.push(
						this.authenticateHistoricalReceipt(item.identity ?? current, item.id, item.row)
					);
				} else {
					const expected = this.computePluginEventProof(
						pluginId,
						current,
						{ id: item.id, receiptId: item.row.receiptId },
						{ payloadHash: item.row.payloadHash },
						'receipt'
					);
					verified.push(
						/^[0-9a-f]{64}$/.test(item.row.proof) &&
							timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(item.row.proof, 'hex'))
					);
				}
			}
		}
		this.assertPluginPersistent(pluginId, current);
		if (this.ledger.epoch !== epoch) throw new PluginAuthorityError('PLUGIN_CONFLICT');
		return verified;
	}

	/** Host-owned generic scope editor: no new capability, no wildcard, sealed CAS. */
	extendPluginEndpoint(
		pluginId: string,
		identity: AuthIdentity,
		endpoint: string,
		secret: boolean,
		check: () => void
	): void {
		if (!isPluginEndpointScope(endpoint)) throw new PluginAuthorityError('PLUGIN_INVALID');
		assertPluginAuthority(check);
		this.assertPluginPersistent(pluginId, identity);
		const entry = this.ledger.entries[pluginId],
			epoch = this.ledger.epoch;
		const caps: PluginCapability[] = secret ? ['net:tls', 'secrets:use'] : ['net:tls'];
		const next = entry.caps.map((grant) => ({ ...grant }));
		for (const cap of caps) {
			const grant = next.find((g) => g.capability === cap);
			const members = parsePluginEndpointScopes(grant?.scope);
			if (!grant || members === null) throw new PluginAuthorityError('PLUGIN_DENIED');
			const scopes = [...new Set([...members, endpoint])];
			if (scopes.length > 16) throw new PluginAuthorityError('PLUGIN_LIMIT');
			grant.scope = scopes.join(',');
		}
		assertPluginAuthority(check);
		this.assertPluginPersistent(pluginId, identity);
		if (epoch !== this.ledger.epoch) throw new PluginAuthorityError('PLUGIN_CONFLICT');
		this.notifyAuthorizationChange(pluginId);
		entry.caps = next;
		this.bump();
		this.persist();
		this.assertPluginPersistent(pluginId, identity);
	}
	pluginSecretRemoval(
		pluginId: string,
		identity: AuthIdentity,
		ref: string
	): { endpoint: string; removal?: 'pending' | 'removed' } {
		const secret = this.pluginState(pluginId, identity)?.secrets[ref];
		if (!secret) throw new PluginAuthorityError('PLUGIN_DENIED');
		return { endpoint: secret.endpoint, removal: secret.removal };
	}
	/** Host-only setup completion/removal; active requires a pending reservation. */
	setPluginSecretState(
		pluginId: string,
		identity: AuthIdentity,
		ref: string,
		next: 'active' | 'pending' | 'removed',
		check: () => void
	): void {
		assertPluginAuthority(check);
		const state = this.pluginState(pluginId, identity);
		const secret = state?.secrets[ref];
		if (
			!secret ||
			!['active', 'pending', 'removed'].includes(next) ||
			(next === 'active' && secret.removal !== 'pending')
		)
			throw new PluginAuthorityError('PLUGIN_DENIED');
		const epoch = this.ledger.epoch;
		assertPluginAuthority(check);
		this.assertPluginPersistent(pluginId, identity);
		if (epoch !== this.ledger.epoch) throw new PluginAuthorityError('PLUGIN_CONFLICT');
		state!.secrets = {
			...state!.secrets,
			[ref]: { ...secret, removal: next === 'active' ? undefined : next },
		};
		this.bump();
		this.persist();
		this.assertPluginPersistent(pluginId, identity);
	}

	/** Trusted uninstall only; never legacy namespaces or another plugin's native entries. */
	purgePluginPrivateState(pluginId: string, deleteSlot: (slot: string) => void): void {
		this.ensureLoaded();
		if (
			!this.ledger.opaque?.[pluginId] &&
			!(this.ledger.opaqueArchive ?? []).some((item) => item.pluginId === pluginId)
		)
			return;
		this.assertPersistentInstallation();
		const states = [
			...(this.ledger.opaque?.[pluginId] ? [this.ledger.opaque[pluginId]] : []),
			...(this.ledger.opaqueArchive ?? [])
				.filter((item) => item.pluginId === pluginId)
				.map((item) => item.state),
		];
		const epoch = this.ledger.epoch;
		for (const state of states)
			for (const ref of Object.keys(state.secrets)) {
				deleteSlot(this.secretSlot(pluginId, state.identity, ref));
				this.assertPersistentInstallation();
				if (this.ledger.epoch !== epoch) throw new PluginAuthorityError('PLUGIN_CONFLICT');
			}
		if (this.ledger.opaque) delete this.ledger.opaque[pluginId];
		if (this.ledger.opaqueArchive)
			this.ledger.opaqueArchive = this.ledger.opaqueArchive.filter(
				(item) => item.pluginId !== pluginId
			);
		this.bump();
		this.persist();
		this.assertPersistentInstallation();
	}

	/** Retired values confer no authority. Preserve only native cleanup provenance. */
	private cleanupOnlyOpaqueState(state: OpaquePluginState): OpaquePluginState | undefined {
		const secrets = Object.fromEntries(
			Object.entries(state.secrets)
				.filter(([, secret]) => secret.removal !== 'removed')
				.map(([ref, secret]) => [ref, { ...secret }])
		);
		return Object.keys(secrets).length
			? { identity: { ...state.identity }, records: {}, secrets }
			: undefined;
	}

	private retirePluginOpaqueState(pluginId: string): void {
		const state = this.ledger.opaque?.[pluginId];
		if (!state) return;
		// Retirement only reduces admitted state; cleanup capacity cannot block revocation.
		const cleanup = this.cleanupOnlyOpaqueState(state);
		if (cleanup) {
			this.ledger.opaqueArchive ??= [];
			this.ledger.opaqueArchive.push({ pluginId, state: cleanup });
		}
		delete this.ledger.opaque![pluginId];
	}

	/** Advance the monotonic epoch for any authoritative mutation. */
	private bump(): void {
		if (!Number.isSafeInteger(this.ledger.epoch) || this.ledger.epoch >= Number.MAX_SAFE_INTEGER)
			throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
		this.ledger.epoch += 1;
	}

	/**
	 * Mint an authorization for one plugin: enable it with EXACTLY the approved
	 * capability set, bound to the plugin's identity (content digest + signature/
	 * trust). The ONLY path that creates trust; callers (the consent IPC handler)
	 * MUST already have verified sender-frame + nonce + user-activation.
	 */
	mint(pluginId: string, caps: PermissionGrant[], identity: AuthIdentity): void {
		this.notifyAuthorizationChange(pluginId);
		this.ensureLoaded();
		this.bump();
		const previousOpaque = this.ledger.opaque?.[pluginId];
		if (previousOpaque && canonicalJson(previousOpaque.identity) !== canonicalJson(identity))
			this.retirePluginOpaqueState(pluginId);
		this.ledger.entries[pluginId] = {
			enabled: true,
			caps: caps.map((c) => ({ ...c })),
			identity: { ...identity },
			mintedAt: this.now(),
		};
		// A fresh mint clears any prior tombstone for this id.
		this.ledger.tombstones = this.ledger.tombstones.filter((t) => t.pluginId !== pluginId);
		this.persist();
	}

	/** Revoke a plugin's authorization (disable + drop grants) with a tombstone.
	 * No-op when the plugin holds no grant (nothing to revoke). */
	revoke(pluginId: string): void {
		this.notifyAuthorizationChange(pluginId);
		this.ensureLoaded();
		if (!this.ledger.entries[pluginId]) return;
		this.bump();
		this.retirePluginOpaqueState(pluginId);
		delete this.ledger.entries[pluginId];
		this.ledger.tombstones = this.ledger.tombstones.filter((t) => t.pluginId !== pluginId);
		this.ledger.tombstones.push({ pluginId, removedAtEpoch: this.ledger.epoch });
		this.persist();
	}

	/** Uninstall: an AUTHORITATIVE user removal. Always records a tombstone at a
	 * fresh epoch (deduped) and drops any grant, even when the plugin was never
	 * enabled - so a later restored folder is recognized as removed-by-user and a
	 * rolled-back ledger that still enables it fails the epoch check. */
	uninstall(pluginId: string): void {
		this.notifyAuthorizationChange(pluginId);
		this.ensureLoaded();
		const hadEntry = !!this.ledger.entries[pluginId];
		const alreadyTombstoned = this.ledger.tombstones.some((t) => t.pluginId === pluginId);
		if (!hadEntry && alreadyTombstoned) return; // already authoritatively removed
		this.bump();
		this.retirePluginOpaqueState(pluginId);
		delete this.ledger.entries[pluginId];
		this.ledger.tombstones = this.ledger.tombstones.filter((t) => t.pluginId !== pluginId);
		this.ledger.tombstones.push({ pluginId, removedAtEpoch: this.ledger.epoch });
		this.persist();
	}

	/**
	 * Host-managed allowlist edit: replace the member scope of an ALREADY-CONSENTED
	 * allowlist-scoped grant (agents:dispatch / process:spawn) with a new set the
	 * USER chose in Settings. The user is a DIFFERENT principal from the plugin;
	 * the plugin can never reach this. It mutates ONLY the scope of a capability
	 * the user already granted: it never adds a capability, never touches the
	 * unattended flag, and never changes identity (the plugin's files are
	 * unchanged, so a later verify() still matches). Authoritative like any mint:
	 * bumps the epoch and persists (sealed + anchored, or the session-only fallback).
	 *
	 * `members` are exact tokens (agent ids / host-blessed binary names); an empty
	 * set clears the scope to deny-all, a valid lockdown short of a full revoke.
	 * Returns false when the capability is not allowlist-scoped, when the plugin
	 * holds no grant for it (nothing to widen: the user must first consent to the
	 * capability through the host-owned consent window), or when any member is not
	 * a valid allowlist token.
	 */
	setAllowlistScope(
		pluginId: string,
		capability: PluginCapability,
		members: readonly string[]
	): boolean {
		this.ensureLoaded();
		if (!isAllowlistScoped(capability)) return false;
		this.notifyAuthorizationChange(pluginId);
		const entry = this.ledger.entries[pluginId];
		if (!entry || !entry.enabled) return false;
		const idx = entry.caps.findIndex((c) => c.capability === capability);
		if (idx === -1) return false;
		// Defense-in-depth: this is the authoritative sealed-ledger mutation, so it
		// self-guards rather than trusting the caller. Refuse the whole edit if any
		// member is invalid (empty, or a character that could split or smuggle
		// through the comma-joined scope) - fail loud, never silently narrow.
		if (!members.every(isValidAllowlistMember)) return false;
		const scope = members.length > 0 ? [...members].join(',') : undefined;
		this.bump();
		entry.caps = entry.caps.map((c, i) => (i === idx ? { ...c, scope } : { ...c }));
		entry.mintedAt = this.now();
		this.persist();
		return true;
	}

	/** The granted capabilities for a plugin - the broker's live source of truth.
	 * Empty unless the plugin is currently enabled in the verified ledger. */
	readGrants(pluginId: string): PermissionGrant[] {
		this.ensureLoaded();
		const entry = this.ledger.entries[pluginId];
		if (!entry || !entry.enabled) return [];
		return entry.caps.map((c) => ({ ...c }));
	}

	/** Whether a plugin is currently authorized-enabled. */
	isEnabled(pluginId: string): boolean {
		this.ensureLoaded();
		return this.ledger.entries[pluginId]?.enabled === true;
	}

	/** The identity (content digest + signature/trust) bound at consent time, or
	 * undefined if not authorized. The verifier recomputes the plugin's CURRENT
	 * identity and compares: any difference (code OR signer/trust change) → the
	 * plugin is disabled and must be re-consented. */
	entryIdentity(pluginId: string): AuthIdentity | undefined {
		this.ensureLoaded();
		const entry = this.ledger.entries[pluginId];
		return entry ? { ...entry.identity } : undefined;
	}

	/** Whether a plugin id currently carries a tombstone (removed, not re-consented). */
	isTombstoned(pluginId: string): boolean {
		this.ensureLoaded();
		return this.ledger.tombstones.some((t) => t.pluginId === pluginId);
	}

	/** Ids of all currently-authorized plugins (enabled in the verified ledger). */
	authorizedIds(): string[] {
		this.ensureLoaded();
		return Object.keys(this.ledger.entries).filter((id) => this.ledger.entries[id].enabled);
	}

	/**
	 * Verify a discovered plugin against its consented authorization. The caller
	 * (plugin-manager.refresh) passes the plugin's CURRENT identity and the
	 * manifest's requested capabilities; this returns the caps to honor, or a
	 * reason the plugin must be disabled / re-consented. Pure given the loaded
	 * ledger - no I/O.
	 */
	verify(
		pluginId: string,
		current: AuthIdentity,
		manifestRequested: readonly PluginCapability[]
	): VerifyResult {
		this.ensureLoaded();
		if (this.isTombstoned(pluginId)) return { authorized: false, reason: 'removed', caps: [] };
		const entry = this.ledger.entries[pluginId];
		if (!entry || !entry.enabled) {
			return { authorized: false, reason: 'not-authorized', caps: [] };
		}
		const id = entry.identity;
		if (
			id.contentHash !== current.contentHash ||
			id.signatureStatus !== current.signatureStatus ||
			id.signerKey !== current.signerKey
		) {
			return { authorized: false, reason: 'identity-changed', caps: [] };
		}
		// Defense in depth: never hand the broker a cap the CURRENT manifest no longer
		// requests. (A plugin.json change also moves contentHash → identity-changed
		// above, but this keeps grants ⊆ the manifest regardless.)
		const requested = new Set(manifestRequested);
		const kept = entry.caps.filter((c) => requested.has(c.capability));
		if (kept.length !== entry.caps.length) {
			return { authorized: false, reason: 'identity-changed', caps: [] };
		}
		return { authorized: true, reason: 'ok', caps: kept.map((c) => ({ ...c })) };
	}
}

export function createAuthorizationStore(opts: {
	safeStorage: SafeStorageLike;
	ledgerPath: string;
	anchor?: AnchorStore;
}): AuthorizationStore {
	return new AuthorizationStore({
		seal: safeStorageSeal(opts.safeStorage),
		anchor: opts.anchor ?? noAnchor(),
		ledgerPath: opts.ledgerPath,
	});
}
