/**
 * Device pairing: how a phone earns the right to hold this desktop's microphone.
 *
 * The security model, stated before the code because the code only makes sense
 * against it:
 *
 *   - **Knowing the code is not enough.** A pairing code is a short string that
 *     is shown on a screen, photographed, and typed. Anything that short is
 *     guessable given enough attempts and shoulder-surfable given one glance, so
 *     it is treated as a POINTER to a request, not as an authorisation. Pairing
 *     completes only when a human clicks Approve on the desktop, looking at the
 *     name and platform of the thing asking.
 *   - **The pairing window is short.** A code is valid for
 *     {@link DEFAULT_PAIRING_TTL_MS} and is consumed by the first claim. A code
 *     left on screen while its owner goes to lunch is a code that has already
 *     expired.
 *   - **The long-lived token is never stored in plain text.** What is persisted
 *     is a salted SHA-256 of it, so the device file is not a credential. A stolen
 *     `devices.json` lets an attacker enumerate device NAMES, which is the
 *     smallest disclosure this design could arrive at while still being able to
 *     authenticate a returning device without a server.
 *   - **Revocation is immediate.** `revoke()` marks the device and fires
 *     {@link PairingService.onRevoke}, which the signaling service turns into a
 *     torn-down peer connection and a closed voice session. A revocation that
 *     only took effect at the next connect would be useless in the one situation
 *     anybody ever uses it: a device that is connected right now.
 *
 * Free of Electron: the file path and the clock arrive as options, so the whole
 * lifecycle is testable without an app object or a real sleep.
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

import type { DeviceCandidateType } from '../../../shared/acappella/device-protocol';
import { atomicWriteJson, createKeyedWriteQueue } from '../../utils/atomic-json-store';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = 'ACappella';

/**
 * How long a pairing code lives. Two minutes is long enough to walk to the phone
 * and short enough that a code left on a screen is not a standing invitation.
 */
export const DEFAULT_PAIRING_TTL_MS = 120_000;

/**
 * How long an approved request can go unredeemed.
 *
 * The token exists from the moment of approval, so this is the window in which
 * an approved-but-uncollected credential is sitting in memory. Short.
 */
export const DEFAULT_APPROVAL_TTL_MS = 60_000;

/** Characters a pairing code is drawn from: no 0/O, no 1/I/L, no vowels. */
const CODE_ALPHABET = '23456789BCDFGHJKMNPQRSTVWXYZ';

/** Length of a pairing code. Six is what fits on a phone keypad without hating it. */
const CODE_LENGTH = 6;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** A device as it is persisted. The hash never leaves the main process. */
export interface PairedDeviceRecord {
	id: string;
	name: string;
	platform: string;
	appVersion?: string;
	createdAt: number;
	lastConnectedAt: number | null;
	/** How the last connection actually reached us. Displayed in the device list. */
	lastCandidateType: DeviceCandidateType;
	revokedAt: number | null;
	/** Salted SHA-256 of the device token, hex. */
	tokenHash: string;
	tokenSalt: string;
}

/** A device as anything outside main sees it. No credential material at all. */
export type PairedDeviceView = Omit<PairedDeviceRecord, 'tokenHash' | 'tokenSalt'>;

/** The code on screen, plus what a device needs to confirm it is the right desktop. */
export interface PairingOffer {
	code: string;
	expiresAt: number;
	/**
	 * Short digest of this desktop's server token, shown on both ends.
	 *
	 * It is what turns "I scanned a QR code" into "I scanned THIS Mac's QR code":
	 * a device that renders the fingerprint it derived from the connection lets
	 * the user compare four characters and notice a man in the middle.
	 */
	fingerprint: string;
}

/** A device asking to pair, waiting for a human on the desktop. */
export interface PairingRequest {
	requestId: string;
	name: string;
	platform: string;
	appVersion?: string;
	requestedAt: number;
	expiresAt: number;
	/** Where the request came from, so an approval is not made blind. */
	remoteAddress?: string;
}

export type PairingClaimResult =
	| { status: 'pending'; requestId: string; expiresAt: number }
	| { status: 'rejected'; reason: 'unknown-code' | 'expired' | 'already-used' | 'busy' };

export type PairingRedeemResult =
	| { status: 'pending' }
	| { status: 'approved'; deviceId: string; token: string }
	| { status: 'denied' }
	| { status: 'expired' };

export interface PairingServiceOptions {
	/** Where `devices.json` lives. */
	filePath: string;
	/**
	 * The desktop's server token, hashed into the pairing fingerprint. Never
	 * stored and never transmitted; only its digest is.
	 */
	hostSecret?: string;
	/** Injectable clock. Tests drive expiry without sleeping. */
	now?: () => number;
	pairingTtlMs?: number;
	approvalTtlMs?: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class PairingService {
	private readonly options: Required<Omit<PairingServiceOptions, 'hostSecret'>> &
		Pick<PairingServiceOptions, 'hostSecret'>;
	private readonly writes = createKeyedWriteQueue();

	private devices = new Map<string, PairedDeviceRecord>();
	private loaded = false;

	/** The one open pairing window. A second `startPairing` replaces it. */
	private offer: (PairingOffer & { claimed: boolean }) | null = null;

	/** Claims waiting for, or just given, a decision. */
	private requests = new Map<
		string,
		{
			request: PairingRequest;
			decision: 'pending' | 'approved' | 'denied';
			/** Present only between approval and redemption, then dropped. */
			token?: string;
			deviceId?: string;
		}
	>();

	private readonly requestListeners = new Set<(request: PairingRequest | null) => void>();
	private readonly revokeListeners = new Set<(deviceId: string, reason: string) => void>();
	private readonly changeListeners = new Set<() => void>();

	constructor(options: PairingServiceOptions) {
		this.options = {
			filePath: options.filePath,
			hostSecret: options.hostSecret,
			now: options.now ?? (() => Date.now()),
			pairingTtlMs: options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS,
			approvalTtlMs: options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS,
		};
	}

	// -- Subscriptions -------------------------------------------------------

	/** A device is asking to pair, or the pending request went away (`null`). */
	onPairingRequest(listener: (request: PairingRequest | null) => void): () => void {
		this.requestListeners.add(listener);
		return () => this.requestListeners.delete(listener);
	}

	/**
	 * A device lost its pairing. The signaling service turns this into an
	 * immediate teardown, which is the entire reason revocation is an event
	 * rather than a flag somebody remembers to check.
	 */
	onRevoke(listener: (deviceId: string, reason: string) => void): () => void {
		this.revokeListeners.add(listener);
		return () => this.revokeListeners.delete(listener);
	}

	/** The device list changed in any way. Repaints the settings panel. */
	onChange(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	// -- Pairing window ------------------------------------------------------

	/**
	 * Open a pairing window and return the code to put on screen.
	 *
	 * Replaces any open window: two live codes would mean a user cannot tell
	 * which QR the phone in their hand actually scanned.
	 */
	startPairing(): PairingOffer {
		const now = this.options.now();
		this.offer = {
			code: generatePairingCode(),
			expiresAt: now + this.options.pairingTtlMs,
			fingerprint: this.fingerprint(),
			claimed: false,
		};
		this.clearPendingRequest();
		return this.currentOffer() as PairingOffer;
	}

	/** The open window, or null when there is none (or it has expired). */
	currentOffer(): PairingOffer | null {
		if (!this.offer) return null;
		if (this.offer.expiresAt <= this.options.now()) {
			this.offer = null;
			this.clearPendingRequest();
			return null;
		}
		const { code, expiresAt, fingerprint } = this.offer;
		return { code, expiresAt, fingerprint };
	}

	/** Close the window without pairing anything. */
	cancelPairing(): void {
		this.offer = null;
		this.clearPendingRequest();
	}

	/**
	 * A device presented a code. Creates a request for a human to approve.
	 *
	 * Deliberately does NOT hand back anything usable. The code buys exactly one
	 * thing: the right to appear in a dialog on the desktop.
	 */
	claim(input: {
		code: string;
		name: string;
		platform: string;
		appVersion?: string;
		remoteAddress?: string;
	}): PairingClaimResult {
		const offer = this.currentOffer();
		if (!offer) return { status: 'rejected', reason: 'expired' };
		if (!constantTimeEquals(input.code.trim().toUpperCase(), offer.code)) {
			return { status: 'rejected', reason: 'unknown-code' };
		}
		if (this.offer?.claimed) return { status: 'rejected', reason: 'already-used' };
		if (this.pendingRequest()) return { status: 'rejected', reason: 'busy' };

		// One-time use: the code is spent the moment it is presented, whether or
		// not the human approves. A denied request must not leave a live code
		// behind for whoever was watching over a shoulder.
		if (this.offer) this.offer.claimed = true;

		const now = this.options.now();
		const request: PairingRequest = {
			requestId: randomBytes(9).toString('base64url'),
			name: input.name.trim() || 'Unnamed device',
			platform: input.platform.trim() || 'unknown',
			appVersion: input.appVersion,
			requestedAt: now,
			expiresAt: now + this.options.pairingTtlMs,
			remoteAddress: input.remoteAddress,
		};
		this.requests.set(request.requestId, { request, decision: 'pending' });
		this.emitRequest(request);
		return { status: 'pending', requestId: request.requestId, expiresAt: request.expiresAt };
	}

	/** The request a human is being asked about, or null. */
	pendingRequest(): PairingRequest | null {
		const now = this.options.now();
		for (const entry of this.requests.values()) {
			if (entry.decision !== 'pending') continue;
			if (entry.request.expiresAt <= now) continue;
			return entry.request;
		}
		return null;
	}

	/**
	 * The affirmative action. Mints the device token, persists its hash, and
	 * leaves the plain token in memory for exactly one redemption.
	 */
	async approve(requestId: string, nameOverride?: string): Promise<PairedDeviceView | null> {
		const entry = this.requests.get(requestId);
		if (!entry || entry.decision !== 'pending') return null;
		if (entry.request.expiresAt <= this.options.now()) return null;

		await this.load();
		const now = this.options.now();
		const token = randomBytes(32).toString('base64url');
		const tokenSalt = randomBytes(16).toString('hex');
		const record: PairedDeviceRecord = {
			id: randomBytes(12).toString('hex'),
			name: (nameOverride ?? entry.request.name).trim() || 'Unnamed device',
			platform: entry.request.platform,
			appVersion: entry.request.appVersion,
			createdAt: now,
			lastConnectedAt: null,
			lastCandidateType: 'unknown',
			revokedAt: null,
			tokenHash: hashToken(token, tokenSalt),
			tokenSalt,
		};
		this.devices.set(record.id, record);
		entry.decision = 'approved';
		entry.token = token;
		entry.deviceId = record.id;
		entry.request.expiresAt = now + this.options.approvalTtlMs;

		// The window closes with the approval: it has done its job, and a code
		// that outlived the pairing it authorised would pair a second device.
		this.offer = null;
		this.emitRequest(null);
		await this.persist();
		logger.info(`Paired device '${record.name}' (${record.platform})`, LOG_CONTEXT);
		return toView(record);
	}

	/** The other affirmative action. The code is already spent either way. */
	deny(requestId: string): void {
		const entry = this.requests.get(requestId);
		if (!entry || entry.decision !== 'pending') return;
		entry.decision = 'denied';
		this.offer = null;
		this.emitRequest(null);
	}

	/**
	 * The device collects its credential. Exactly once: the token is deleted from
	 * memory as it is handed over, so a replayed redemption gets nothing.
	 */
	redeem(requestId: string): PairingRedeemResult {
		const entry = this.requests.get(requestId);
		if (!entry) return { status: 'expired' };
		if (entry.decision === 'denied') {
			this.requests.delete(requestId);
			return { status: 'denied' };
		}
		if (entry.request.expiresAt <= this.options.now()) {
			this.requests.delete(requestId);
			return { status: 'expired' };
		}
		if (entry.decision === 'pending') return { status: 'pending' };

		const { token, deviceId } = entry;
		this.requests.delete(requestId);
		if (!token || !deviceId) return { status: 'expired' };
		return { status: 'approved', deviceId, token };
	}

	// -- Authentication ------------------------------------------------------

	/**
	 * Check a returning device's credential.
	 *
	 * Returns null for unknown, revoked, and wrong-token alike. The caller gets no
	 * more detail than that on the wire: distinguishing "no such device" from
	 * "wrong token" hands an attacker an enumeration oracle for free.
	 */
	async authenticate(deviceId: string, token: string): Promise<PairedDeviceView | null> {
		await this.load();
		const record = this.devices.get(deviceId);
		if (!record || record.revokedAt !== null) return null;
		if (!constantTimeEquals(hashToken(token, record.tokenSalt), record.tokenHash)) return null;
		return toView(record);
	}

	// -- Device list ---------------------------------------------------------

	/** Every device, revoked ones included, newest first. */
	async list(): Promise<PairedDeviceView[]> {
		await this.load();
		return [...this.devices.values()].sort((a, b) => b.createdAt - a.createdAt).map(toView);
	}

	/** Synchronous read of what is already loaded. For hot paths that cannot await. */
	listLoaded(): PairedDeviceView[] {
		return [...this.devices.values()].sort((a, b) => b.createdAt - a.createdAt).map(toView);
	}

	async rename(deviceId: string, name: string): Promise<boolean> {
		await this.load();
		const record = this.devices.get(deviceId);
		if (!record) return false;
		record.name = name.trim() || record.name;
		await this.persist();
		return true;
	}

	/**
	 * End a pairing, now.
	 *
	 * The listeners fire BEFORE the write completes on purpose: tearing down a
	 * live connection is the urgent half and it must not wait on a disk flush.
	 */
	async revoke(
		deviceId: string,
		reason = 'This device was revoked on the desktop.'
	): Promise<boolean> {
		await this.load();
		const record = this.devices.get(deviceId);
		if (!record || record.revokedAt !== null) return false;
		record.revokedAt = this.options.now();
		this.emitRevoke(deviceId, reason);
		await this.persist();
		logger.info(`Revoked device '${record.name}'`, LOG_CONTEXT);
		return true;
	}

	/** Revoke every device. The panic button. */
	async revokeAll(reason = 'All devices were revoked on the desktop.'): Promise<number> {
		await this.load();
		let count = 0;
		for (const record of this.devices.values()) {
			if (record.revokedAt !== null) continue;
			record.revokedAt = this.options.now();
			this.emitRevoke(record.id, reason);
			count += 1;
		}
		if (count > 0) await this.persist();
		return count;
	}

	/** Forget a revoked device entirely, so the list stops showing it. */
	async forget(deviceId: string): Promise<boolean> {
		await this.load();
		if (!this.devices.delete(deviceId)) return false;
		await this.persist();
		return true;
	}

	/** Record a successful connection and how it got here. */
	async noteConnected(deviceId: string, candidateType: DeviceCandidateType): Promise<void> {
		await this.load();
		const record = this.devices.get(deviceId);
		if (!record) return;
		record.lastConnectedAt = this.options.now();
		record.lastCandidateType = candidateType;
		await this.persist();
	}

	// -- Storage -------------------------------------------------------------

	/** Read `devices.json` once. A missing or corrupt file is an empty list. */
	async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const raw = await fs.readFile(this.options.filePath, 'utf-8');
			const parsed = JSON.parse(raw) as { devices?: PairedDeviceRecord[] };
			for (const record of parsed.devices ?? []) {
				if (!record || typeof record.id !== 'string' || typeof record.tokenHash !== 'string') {
					continue;
				}
				this.devices.set(record.id, {
					...record,
					lastConnectedAt: record.lastConnectedAt ?? null,
					lastCandidateType: record.lastCandidateType ?? 'unknown',
					revokedAt: record.revokedAt ?? null,
				});
			}
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			// A file that has never existed is the first run, not a failure. Anything
			// else is worth a line in the log, but never worth refusing to run: a
			// device list that cannot be read is a user who cannot pair, which is a
			// worse outcome than a user who has to pair again.
			if (code !== 'ENOENT') {
				logger.warn(`Could not read paired devices: ${(error as Error).message}`, LOG_CONTEXT);
			}
		}
	}

	private async persist(): Promise<void> {
		const devices = [...this.devices.values()];
		this.emitChange();
		await this.writes.enqueue(this.options.filePath, async () => {
			await fs.mkdir(path.dirname(this.options.filePath), { recursive: true });
			await atomicWriteJson(this.options.filePath, { version: 1, devices });
		});
	}

	// -- Internals -----------------------------------------------------------

	/**
	 * The short digest a user compares between the two screens.
	 *
	 * Public because the Bonjour advert carries it too: a device that found this
	 * desktop by discovery has to be able to show the same four-plus-four
	 * characters the pairing sheet shows, or the check is not a check.
	 */
	fingerprint(): string {
		const secret = this.options.hostSecret ?? '';
		const digest = createHash('sha256').update(`acappella-pairing:${secret}`).digest('hex');
		return `${digest.slice(0, 4)}-${digest.slice(4, 8)}`.toUpperCase();
	}

	private clearPendingRequest(): void {
		for (const [id, entry] of this.requests) {
			if (entry.decision === 'pending') this.requests.delete(id);
		}
		this.emitRequest(null);
	}

	private emitRequest(request: PairingRequest | null): void {
		for (const listener of this.requestListeners) listener(request);
	}

	private emitRevoke(deviceId: string, reason: string): void {
		for (const listener of this.revokeListeners) listener(deviceId, reason);
	}

	private emitChange(): void {
		for (const listener of this.changeListeners) listener();
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toView(record: PairedDeviceRecord): PairedDeviceView {
	const { tokenHash: _hash, tokenSalt: _salt, ...view } = record;
	return view;
}

/** Salted SHA-256, hex. The salt is per device so two devices never collide. */
export function hashToken(token: string, salt: string): string {
	return createHash('sha256').update(`${salt}:${token}`).digest('hex');
}

/**
 * Compare without leaking length or position through timing.
 *
 * `timingSafeEqual` throws on a length mismatch, so both sides are hashed to a
 * fixed width first - which also makes the comparison safe for the pairing code,
 * where the lengths genuinely differ between a good guess and a bad one.
 */
export function constantTimeEquals(a: string, b: string): boolean {
	const left = createHash('sha256').update(a).digest();
	const right = createHash('sha256').update(b).digest();
	return timingSafeEqual(left, right);
}

/** A six-character code from an alphabet with no lookalike glyphs. */
export function generatePairingCode(): string {
	const bytes = randomBytes(CODE_LENGTH);
	let code = '';
	for (let index = 0; index < CODE_LENGTH; index += 1) {
		code += CODE_ALPHABET[bytes[index] % CODE_ALPHABET.length];
	}
	return code;
}
