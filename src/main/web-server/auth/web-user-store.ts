/**
 * Web Login accounts and their browser sessions, persisted as one JSON file
 * in userData (`web-users.json`).
 *
 * Deliberately NOT a key in `maestro-settings`: `settings:getAll` hands the
 * whole settings store to any bridge caller, so a hash stored there would be
 * readable by every logged-in browser. Its own file is reachable only through
 * the `webLogin:*` IPC channels, which the bridge refuses.
 *
 * Sessions are persisted beside the accounts so a phone stays signed in across
 * a Maestro restart. A session id is 256 random bits and carries no more
 * authority than the URL token already stored in plain text in the same
 * directory.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../../utils/atomic-json-store';
import { logger } from '../../utils/logger';
import {
	normalizeWebDisplayName,
	normalizeWebUsername,
	validateWebPassword,
	validateWebUsername,
	type WebActingUser,
	type WebUserPublic,
} from '../../../shared/webLogin';
import { hashPassword, verifyPassword } from './password';

const LOG_CONTEXT = 'WebLogin';

export const WEB_USERS_FILE = 'web-users.json';

/** Sessions live this long past their last use. */
export const WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface WebUserRecord extends WebUserPublic {
	passwordHash: string;
}

interface WebSessionRecord {
	id: string;
	userId: string;
	createdAt: number;
	/** Sliding: bumped on every successful resolve. */
	expiresAt: number;
}

interface WebUsersFile {
	version: 1;
	users: WebUserRecord[];
	sessions: WebSessionRecord[];
}

const EMPTY: WebUsersFile = { version: 1, users: [], sessions: [] };

export type WebLoginResult =
	| { ok: true; user: WebActingUser; sessionId: string }
	| { ok: false; reason: 'invalid' | 'disabled' | 'no-users' };

function toPublic(u: WebUserRecord): WebUserPublic {
	return {
		id: u.id,
		username: u.username,
		displayName: u.displayName,
		createdAt: u.createdAt,
		...(u.lastLoginAt !== undefined ? { lastLoginAt: u.lastLoginAt } : {}),
		...(u.disabled ? { disabled: true } : {}),
	};
}

function toActing(u: WebUserRecord): WebActingUser {
	return { id: u.id, username: u.username, displayName: u.displayName };
}

export class WebUserStore {
	private data: WebUsersFile = { ...EMPTY, users: [], sessions: [] };
	private loaded = false;
	private writeChain: Promise<void> = Promise.resolve();
	private readonly listeners = new Set<() => void>();

	constructor(private readonly filePath: string) {}

	/** Read the file once. Missing or unreadable reads as empty; a corrupt file is kept aside. */
	load(): void {
		if (this.loaded) return;
		this.loaded = true;
		if (!existsSync(this.filePath)) return;
		try {
			const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<WebUsersFile>;
			this.data = {
				version: 1,
				users: Array.isArray(raw.users) ? raw.users : [],
				sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
			};
			this.pruneExpired();
		} catch (err) {
			logger.error(`Could not read ${this.filePath}; starting with no accounts`, LOG_CONTEXT, err);
		}
	}

	/** Called after every mutation. Used to close sockets of revoked sessions. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private persist(): Promise<void> {
		const snapshot: WebUsersFile = {
			version: 1,
			users: this.data.users.map((u) => ({ ...u })),
			sessions: this.data.sessions.map((s) => ({ ...s })),
		};
		this.writeChain = this.writeChain
			.then(() => atomicWriteJson(this.filePath, snapshot))
			.catch((err) => {
				logger.error(`Could not write ${this.filePath}`, LOG_CONTEXT, err);
			});
		for (const l of this.listeners) l();
		return this.writeChain;
	}

	/** Await any in-flight write (tests, shutdown). */
	flush(): Promise<void> {
		return this.writeChain;
	}

	private pruneExpired(): void {
		const now = Date.now();
		this.data.sessions = this.data.sessions.filter((s) => s.expiresAt > now);
	}

	// ---- accounts ----

	hasUsers(): boolean {
		this.load();
		return this.data.users.length > 0;
	}

	listUsers(): WebUserPublic[] {
		this.load();
		return this.data.users.map(toPublic);
	}

	getUser(id: string): WebUserPublic | undefined {
		this.load();
		const u = this.data.users.find((x) => x.id === id);
		return u ? toPublic(u) : undefined;
	}

	private findByUsername(username: string): WebUserRecord | undefined {
		const norm = normalizeWebUsername(username);
		return this.data.users.find((u) => u.username === norm);
	}

	/** Throws with a user-facing message on a bad username, password, or duplicate. */
	async createUser(input: {
		username: string;
		password: string;
		displayName?: string;
	}): Promise<WebUserPublic> {
		this.load();
		const usernameError = validateWebUsername(input.username);
		if (usernameError) throw new Error(usernameError);
		const passwordError = validateWebPassword(input.password);
		if (passwordError) throw new Error(passwordError);
		const username = normalizeWebUsername(input.username);
		if (this.findByUsername(username))
			throw new Error(`An account named "${username}" already exists.`);
		const record: WebUserRecord = {
			id: randomUUID(),
			username,
			displayName: normalizeWebDisplayName(input.displayName, username),
			createdAt: Date.now(),
			passwordHash: await hashPassword(input.password),
		};
		this.data.users.push(record);
		await this.persist();
		return toPublic(record);
	}

	async setPassword(id: string, password: string): Promise<void> {
		this.load();
		const passwordError = validateWebPassword(password);
		if (passwordError) throw new Error(passwordError);
		const u = this.data.users.find((x) => x.id === id);
		if (!u) throw new Error('No such account.');
		u.passwordHash = await hashPassword(password);
		// A reset ends every browser session for the account.
		this.data.sessions = this.data.sessions.filter((s) => s.userId !== id);
		await this.persist();
	}

	async setDisplayName(id: string, displayName: string): Promise<WebUserPublic> {
		this.load();
		const u = this.data.users.find((x) => x.id === id);
		if (!u) throw new Error('No such account.');
		u.displayName = normalizeWebDisplayName(displayName, u.username);
		await this.persist();
		return toPublic(u);
	}

	async setDisabled(id: string, disabled: boolean): Promise<WebUserPublic> {
		this.load();
		const u = this.data.users.find((x) => x.id === id);
		if (!u) throw new Error('No such account.');
		if (disabled) {
			u.disabled = true;
			this.data.sessions = this.data.sessions.filter((s) => s.userId !== id);
		} else {
			delete u.disabled;
		}
		await this.persist();
		return toPublic(u);
	}

	async deleteUser(id: string): Promise<void> {
		this.load();
		const before = this.data.users.length;
		this.data.users = this.data.users.filter((u) => u.id !== id);
		if (this.data.users.length === before) throw new Error('No such account.');
		this.data.sessions = this.data.sessions.filter((s) => s.userId !== id);
		await this.persist();
	}

	// ---- sessions ----

	/**
	 * Verify credentials and issue a session. The password is always hashed
	 * even for an unknown username so the response time does not say whether
	 * the account exists.
	 */
	async login(username: string, password: string): Promise<WebLoginResult> {
		this.load();
		if (this.data.users.length === 0) return { ok: false, reason: 'no-users' };
		const u = this.findByUsername(username);
		const hash = u?.passwordHash ?? DUMMY_HASH;
		const matches = await verifyPassword(typeof password === 'string' ? password : '', hash);
		if (!u || !matches) return { ok: false, reason: 'invalid' };
		if (u.disabled) return { ok: false, reason: 'disabled' };
		const now = Date.now();
		const session: WebSessionRecord = {
			id: randomBytes(32).toString('base64url'),
			userId: u.id,
			createdAt: now,
			expiresAt: now + WEB_SESSION_TTL_MS,
		};
		u.lastLoginAt = now;
		this.pruneExpired();
		this.data.sessions.push(session);
		await this.persist();
		return { ok: true, user: toActing(u), sessionId: session.id };
	}

	/**
	 * The account behind a session id, or `undefined` when the session is
	 * unknown, expired, or its account is gone or disabled. Slides the expiry
	 * forward without waiting on the write.
	 */
	resolveSession(sessionId: string | undefined): WebActingUser | undefined {
		if (!sessionId) return undefined;
		this.load();
		const now = Date.now();
		const s = this.data.sessions.find((x) => x.id === sessionId);
		if (!s || s.expiresAt <= now) return undefined;
		const u = this.data.users.find((x) => x.id === s.userId);
		if (!u || u.disabled) return undefined;
		const slid = now + WEB_SESSION_TTL_MS;
		// Persist the slide at most once a day per session; the file is not
		// worth rewriting on every request.
		if (slid - s.expiresAt > 24 * 60 * 60 * 1000) {
			s.expiresAt = slid;
			void this.persist();
		}
		return toActing(u);
	}

	async logout(sessionId: string | undefined): Promise<void> {
		if (!sessionId) return;
		this.load();
		const before = this.data.sessions.length;
		this.data.sessions = this.data.sessions.filter((s) => s.id !== sessionId);
		if (this.data.sessions.length !== before) await this.persist();
	}

	/** Test seam. */
	resetForTests(): void {
		this.data = { version: 1, users: [], sessions: [] };
		this.loaded = true;
	}
}

// Hashed once at module load so an unknown-username login costs the same as a
// wrong-password one. A fixed salt is fine: this hash never protects anything.
const DUMMY_HASH =
	'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
	'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

let singleton: WebUserStore | null = null;

/** The app-wide store, created on first use under Electron's userData. */
export function getWebUserStore(): WebUserStore {
	if (!singleton) {
		// Lazy require so the module stays importable (and testable) without Electron.

		const { app } = require('electron') as typeof import('electron');
		singleton = new WebUserStore(path.join(app.getPath('userData'), WEB_USERS_FILE));
	}
	return singleton;
}

/** Test seam: substitute a store backed by a scratch path. */
export function setWebUserStoreForTests(store: WebUserStore | null): void {
	singleton = store;
}
