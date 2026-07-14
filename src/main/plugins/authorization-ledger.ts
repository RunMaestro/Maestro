/**
 * Plugin authorization ledger (main process) — the security gate.
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
 *    an OLD sealed ledger (a rollback) is rejected — its epoch is stale.
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

import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { PermissionGrant, PluginCapability } from '../../shared/plugins/permissions';
import type { SignatureStatus } from '../../shared/plugins/signing';

/** Schema version of the sealed ledger payload. */
export const LEDGER_VERSION = 1 as const;

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

/** A removed/revoked plugin — blocks silent re-enable of a restored folder. */
export interface Tombstone {
	pluginId: string;
	removedAtEpoch: number;
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
}

/** The freshness anchor stored in the OS credential vault. */
export interface Anchor {
	installSecret: string;
	epoch: number;
}

/** Seals/unseals bytes via an OS-key-backed primitive (safeStorage). */
export interface SealProvider {
	available(): boolean;
	seal(plaintext: string): Buffer;
	unseal(blob: Buffer): string;
}

export interface SafeStorageLike {
	isEncryptionAvailable(): boolean;
	encryptString(s: string): Buffer;
	decryptString(b: Buffer): string;
}

/** Named credential-store slot for the anchor, OUTSIDE the data-dir file tree. */
export interface AnchorStore {
	available(): boolean;
	read(): Anchor | null;
	write(anchor: Anchor): void;
	clear(): void;
}

export interface AuthorizationStoreDeps {
	seal: SealProvider;
	anchor: AnchorStore;
	/** Absolute path of the sealed ledger file. */
	ledgerPath: string;
	/** Auditable warning sink for fail-closed session-only degradation. */
	warn?: (message: string) => void;
	now?: () => number;
	newSecret?: () => string;
}

/** Why the persisted ledger was not trusted this session (for UI / audit). */
export type LedgerTrustState =
	| 'persistent' // sealed + anchored + fresh: trusted, persists across restarts
	| 'session-only' // seal/anchor unavailable: in-memory grants, re-consent next launch
	| 're-consent'; // tamper / rollback / anchor mismatch: persisted state dropped

function emptyLedger(installSecret: string): AuthorizationLedger {
	return { version: LEDGER_VERSION, epoch: 0, installSecret, entries: {}, tombstones: [] };
}

function isLedger(value: unknown): value is AuthorizationLedger {
	if (typeof value !== 'object' || value === null) return false;
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
		value.version === LEDGER_VERSION &&
		typeof value.epoch === 'number' &&
		Number.isInteger(value.epoch) &&
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
	/** Caps to hand the broker — empty unless `authorized`. */
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
	private readonly seal: SealProvider;
	private readonly anchor: AnchorStore;
	private readonly ledgerPath: string;
	private readonly warn: (message: string) => void;
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
		this.warn = deps.warn ?? (() => {});
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
		const sealAvailable = this.seal.available();
		const anchorAvailable = this.anchor.available();
		if (!sealAvailable || !anchorAvailable) {
			this.ledger = emptyLedger(this.newSecret());
			this.storageMode = 'session-only';
			const unavailable = [
				...(!sealAvailable ? ['safeStorage'] : []),
				...(!anchorAvailable ? ['freshness anchor'] : []),
			].join(' and ');
			this.warnSessionOnly(`${unavailable} unavailable`);
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
			const blob = fs.readFileSync(this.ledgerPath);
			parsed = JSON.parse(this.seal.unseal(blob));
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

		this.ledger = parsed;
		this.storageMode = 'persistent';
	}

	/** Seal + write the ledger and bump/write the anchor. No-op in session-only
	 * mode (nothing is ever written to disk or the credential store then). */
	private persist(): void {
		if (this.storageMode === 'session-only') return;
		try {
			// Anchor first: a locked/unavailable credential store throws here, before
			// we commit a ledger file the anchor can't vouch for.
			this.anchor.write({ installSecret: this.ledger.installSecret, epoch: this.ledger.epoch });
			const dir = path.dirname(this.ledgerPath);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			const tmp = `${this.ledgerPath}.tmp`;
			fs.writeFileSync(tmp, this.seal.seal(JSON.stringify(this.ledger)));
			fs.renameSync(tmp, this.ledgerPath);
			this.droppedPriorState = false;
		} catch (error) {
			// Seal / anchor / disk failure (locked keyring, read-only disk, …). Fail
			// safe: degrade to session-only so this run's grants live only in memory
			// and nothing is left half-persisted. Any partial write is caught next
			// launch by the epoch check → re-consent.
			this.storageMode = 'session-only';
			this.warnSessionOnly(`persistence failed (${this.errorReason(error)})`);
		}
	}

	private warnSessionOnly(reason: string): void {
		this.warn(`[PluginAuthorization] session-only: ${reason}; ledger path "${this.ledgerPath}"`);
	}

	private errorReason(error: unknown): string {
		return error instanceof Error && error.message ? error.message : 'unknown error';
	}

	/** Advance the monotonic epoch for any authoritative mutation. */
	private bump(): void {
		this.ledger.epoch += 1;
	}

	/**
	 * Mint an authorization for one plugin: enable it with EXACTLY the approved
	 * capability set, bound to the plugin's identity (content digest + signature/
	 * trust). The ONLY path that creates trust; callers (the consent IPC handler)
	 * MUST already have verified sender-frame + nonce + user-activation.
	 */
	mint(pluginId: string, caps: PermissionGrant[], identity: AuthIdentity): void {
		this.ensureLoaded();
		this.bump();
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
		this.ensureLoaded();
		if (!this.ledger.entries[pluginId]) return;
		this.bump();
		delete this.ledger.entries[pluginId];
		this.ledger.tombstones = this.ledger.tombstones.filter((t) => t.pluginId !== pluginId);
		this.ledger.tombstones.push({ pluginId, removedAtEpoch: this.ledger.epoch });
		this.persist();
	}

	/** Uninstall: an AUTHORITATIVE user removal. Always records a tombstone at a
	 * fresh epoch (deduped) and drops any grant, even when the plugin was never
	 * enabled — so a later restored folder is recognized as removed-by-user and a
	 * rolled-back ledger that still enables it fails the epoch check. */
	uninstall(pluginId: string): void {
		this.ensureLoaded();
		const hadEntry = !!this.ledger.entries[pluginId];
		const alreadyTombstoned = this.ledger.tombstones.some((t) => t.pluginId === pluginId);
		if (!hadEntry && alreadyTombstoned) return; // already authoritatively removed
		this.bump();
		delete this.ledger.entries[pluginId];
		this.ledger.tombstones = this.ledger.tombstones.filter((t) => t.pluginId !== pluginId);
		this.ledger.tombstones.push({ pluginId, removedAtEpoch: this.ledger.epoch });
		this.persist();
	}

	/** The granted capabilities for a plugin — the broker's live source of truth.
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
	 * ledger — no I/O.
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

/** Production `SealProvider` over Electron `safeStorage`. */
export function safeStorageSeal(safeStorage: SafeStorageLike): SealProvider {
	return {
		available: () => {
			try {
				return safeStorage.isEncryptionAvailable();
			} catch {
				return false;
			}
		},
		seal: (plaintext) => safeStorage.encryptString(plaintext),
		unseal: (blob) => safeStorage.decryptString(blob),
	};
}

/**
 * Production `AnchorStore` over a named OS credential entry. `entryFactory`
 * lazily constructs the keyring entry so a missing/unavailable native module
 * degrades to `available() === false` (→ session-only) instead of throwing.
 */
export interface KeyringEntry {
	getPassword(): string | null;
	setPassword(password: string): void;
	deletePassword(): boolean;
}

export function keyringAnchor(entryFactory: () => KeyringEntry | null): AnchorStore {
	let entry: KeyringEntry | null | undefined;
	const get = (): KeyringEntry | null => {
		if (entry === undefined) {
			try {
				entry = entryFactory();
			} catch {
				entry = null;
			}
		}
		return entry;
	};
	return {
		available: () => get() !== null,
		read: () => {
			const e = get();
			if (!e) return null;
			try {
				const raw = e.getPassword();
				if (!raw) return null;
				const parsed: unknown = JSON.parse(raw);
				if (
					typeof parsed !== 'object' ||
					parsed === null ||
					!('installSecret' in parsed) ||
					!('epoch' in parsed) ||
					typeof parsed.installSecret !== 'string' ||
					typeof parsed.epoch !== 'number'
				) {
					return null;
				}
				return { installSecret: parsed.installSecret, epoch: parsed.epoch };
			} catch {
				return null;
			}
		},
		write: (anchor) => {
			const e = get();
			if (!e) return;
			e.setPassword(JSON.stringify(anchor));
		},
		clear: () => {
			const e = get();
			if (!e) return;
			try {
				e.deletePassword();
			} catch {
				/* best-effort */
			}
		},
	};
}

/** A no-op anchor — `available() === false`, so the store runs session-only. */
export function noAnchor(): AnchorStore {
	return {
		available: () => false,
		read: () => null,
		write: () => {},
		clear: () => {},
	};
}

export interface KeyringModule {
	Entry: new (service: string, account: string) => KeyringEntry;
}

/** Lazily adapt `@napi-rs/keyring` without making app startup depend on it. */
export function createKeyringAnchor(
	service: string,
	account: string,
	loadModule: () => KeyringModule | null = () => {
		try {
			const mod = require('@napi-rs/keyring') as Partial<KeyringModule>;
			return typeof mod.Entry === 'function' ? (mod as KeyringModule) : null;
		} catch {
			return null;
		}
	}
): AnchorStore {
	return keyringAnchor(() => {
		const mod = loadModule();
		if (!mod) return null;
		return new mod.Entry(service, account);
	});
}
export function createAuthorizationStore(opts: {
	safeStorage: SafeStorageLike;
	ledgerPath: string;
	anchor?: AnchorStore;
	warn?: (message: string) => void;
}): AuthorizationStore {
	return new AuthorizationStore({
		seal: safeStorageSeal(opts.safeStorage),
		anchor: opts.anchor ?? noAnchor(),
		ledgerPath: opts.ledgerPath,
		warn: opts.warn,
	});
}
