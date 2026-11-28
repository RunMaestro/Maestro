/**
 * Prompt Links, persisted as one JSON file in userData (`prompt-links.json`).
 *
 * Deliberately NOT a key in `maestro-settings`: `settings:getAll` hands the
 * whole settings store to any web-desktop bridge caller, and a browser that can
 * read the links can read every stored prompt. This file is reachable only
 * through the `promptLinks:*` IPC channels (refused over the bridge) and the
 * CLI-only `prompt_link_command` WebSocket message.
 *
 * The token itself is never stored, only its SHA-256. The URL is handed back
 * once, at creation; a copy of this file (a backup, a synced folder) holds no
 * working link. A 256-bit random token needs no slow hash: there is nothing to
 * brute-force.
 *
 * Firing is two-phase so a link cannot run twice and is not burned by a
 * delivery that never happened:
 *
 *   reserve(token)  - synchronous check + in-flight mark. A second delivery of
 *                     the same URL (double click, macOS sending `open-url`
 *                     twice) sees the mark and is refused.
 *   commit()        - the prompt was delivered (or MAY have been): count the use.
 *   release()       - nothing was delivered: drop the mark, the use is kept.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../utils/atomic-json-store';
import { logger } from '../utils/logger';
import { buildPromptLinkUrl } from '../../shared/deep-link-urls';
import {
	PROMPT_LINK_TOKEN_BYTES,
	promptLinkStatus,
	resolvePromptLinkId,
	validatePromptLinkInput,
	type PromptLinkCreateInput,
	type PromptLinkCreated,
	type PromptLinkPublic,
	type PromptLinkRefusal,
} from '../../shared/promptLinks';

const LOG_CONTEXT = 'PromptLinks';

export const PROMPT_LINKS_FILE = 'prompt-links.json';

interface PromptLinkRecord extends PromptLinkPublic {
	tokenHash: string;
}

interface PromptLinksFile {
	version: 1;
	links: PromptLinkRecord[];
}

export type PromptLinkReservation =
	| { ok: true; link: PromptLinkPublic; commit: () => void; release: () => void }
	| { ok: false; reason: PromptLinkRefusal; link?: PromptLinkPublic };

export function hashPromptLinkToken(token: string): string {
	return createHash('sha256').update(token, 'utf8').digest('hex');
}

function toPublic(r: PromptLinkRecord): PromptLinkPublic {
	const { tokenHash: _tokenHash, ...rest } = r;
	return { ...rest };
}

/** A record read from disk, or null when it is not one this version can trust. */
function readRecord(raw: unknown): PromptLinkRecord | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	if (
		typeof r.id !== 'string' ||
		typeof r.tokenHash !== 'string' ||
		typeof r.agentId !== 'string' ||
		typeof r.prompt !== 'string' ||
		typeof r.createdAt !== 'number' ||
		typeof r.useCount !== 'number' ||
		!(r.maxUses === null || typeof r.maxUses === 'number')
	) {
		return null;
	}
	return {
		id: r.id,
		tokenHash: r.tokenHash,
		agentId: r.agentId,
		prompt: r.prompt,
		createdAt: r.createdAt,
		useCount: r.useCount,
		maxUses: r.maxUses as number | null,
		open: r.open === 'foreground' ? 'foreground' : 'background',
		...(typeof r.label === 'string' ? { label: r.label } : {}),
		...(typeof r.expiresAt === 'number' ? { expiresAt: r.expiresAt } : {}),
		...(typeof r.lastUsedAt === 'number' ? { lastUsedAt: r.lastUsedAt } : {}),
		...(typeof r.revokedAt === 'number' ? { revokedAt: r.revokedAt } : {}),
	};
}

export class PromptLinkStore {
	private links: PromptLinkRecord[] = [];
	private loaded = false;
	private writeChain: Promise<void> = Promise.resolve();
	/** Ids of links whose prompt is being delivered right now. */
	private readonly inFlight = new Set<string>();

	constructor(private readonly filePath: string) {}

	/** Read the file once. Missing reads as empty; an unreadable file is logged and kept. */
	load(): void {
		if (this.loaded) return;
		this.loaded = true;
		if (!existsSync(this.filePath)) return;
		try {
			const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<PromptLinksFile>;
			const list = Array.isArray(raw.links) ? raw.links : [];
			this.links = list.map(readRecord).filter((r): r is PromptLinkRecord => r !== null);
		} catch (err) {
			// Not overwritten until the next mutation, so a hand-repair is still possible.
			logger.error(
				`Could not read ${this.filePath}; starting with no prompt links`,
				LOG_CONTEXT,
				err
			);
		}
	}

	private persist(): Promise<void> {
		const snapshot: PromptLinksFile = { version: 1, links: this.links.map((l) => ({ ...l })) };
		this.writeChain = this.writeChain
			.then(() => atomicWriteJson(this.filePath, snapshot))
			.catch((err) => {
				logger.error(`Could not write ${this.filePath}`, LOG_CONTEXT, err);
			});
		return this.writeChain;
	}

	/** Every link, newest first. */
	list(): PromptLinkPublic[] {
		this.load();
		return [...this.links].sort((a, b) => b.createdAt - a.createdAt).map(toPublic);
	}

	/**
	 * Create a link and return its URL. The URL is the only place the token
	 * exists after this call returns.
	 */
	async create(input: PromptLinkCreateInput, now: number = Date.now()): Promise<PromptLinkCreated> {
		this.load();
		const problem = validatePromptLinkInput(input, now);
		if (problem) throw new Error(problem);
		const token = randomBytes(PROMPT_LINK_TOKEN_BYTES).toString('base64url');
		const label = input.label?.trim();
		const record: PromptLinkRecord = {
			id: randomUUID(),
			tokenHash: hashPromptLinkToken(token),
			agentId: input.agentId,
			prompt: input.prompt,
			createdAt: now,
			useCount: 0,
			maxUses: input.maxUses === undefined ? 1 : input.maxUses,
			open: input.open ?? 'background',
			...(label ? { label } : {}),
			...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
		};
		this.links.push(record);
		await this.persist();
		return { link: toPublic(record), url: buildPromptLinkUrl(token) };
	}

	/**
	 * Revoke by id or unique id prefix. Revoking an already-revoked link is a
	 * no-op that still returns it, so a retried revoke does not read as a failure.
	 */
	async revoke(idOrPrefix: string, now: number = Date.now()): Promise<PromptLinkPublic> {
		this.load();
		const found = resolvePromptLinkId(this.links.map(toPublic), idOrPrefix);
		if ('error' in found) throw new Error(found.error);
		const record = this.links.find((l) => l.id === found.link.id);
		if (!record) throw new Error(`No prompt link matches "${idOrPrefix}".`);
		if (record.revokedAt === undefined) {
			record.revokedAt = now;
			await this.persist();
		}
		return toPublic(record);
	}

	/**
	 * Check a token and mark its link in flight. Synchronous on purpose: two
	 * deliveries of one URL arriving back to back must see each other.
	 */
	reserve(token: string, now: number = Date.now()): PromptLinkReservation {
		this.load();
		const hash = hashPromptLinkToken(token);
		const record = this.links.find((l) => l.tokenHash === hash);
		if (!record) return { ok: false, reason: 'not-found' };
		const link = toPublic(record);
		const status = promptLinkStatus(record, now);
		if (status !== 'active') return { ok: false, reason: status, link };
		if (this.inFlight.has(record.id)) return { ok: false, reason: 'in-flight', link };

		this.inFlight.add(record.id);
		let settled = false;
		return {
			ok: true,
			link,
			commit: () => {
				if (settled) return;
				settled = true;
				this.inFlight.delete(record.id);
				record.useCount += 1;
				record.lastUsedAt = Date.now();
				void this.persist();
			},
			release: () => {
				if (settled) return;
				settled = true;
				this.inFlight.delete(record.id);
			},
		};
	}

	/** Test seam. */
	resetForTests(): void {
		this.links = [];
		this.loaded = true;
		this.inFlight.clear();
	}

	/** Test seam: wait for queued writes. */
	flushForTests(): Promise<void> {
		return this.writeChain;
	}
}

let singleton: PromptLinkStore | null = null;

/** The app-wide store, created on first use under Electron's userData. */
export function getPromptLinkStore(): PromptLinkStore {
	if (!singleton) {
		// Lazy require so the module stays importable (and testable) without Electron.
		const { app } = require('electron') as typeof import('electron');
		singleton = new PromptLinkStore(path.join(app.getPath('userData'), PROMPT_LINKS_FILE));
	}
	return singleton;
}

/** Test seam: substitute a store backed by a scratch path. */
export function setPromptLinkStoreForTests(store: PromptLinkStore | null): void {
	singleton = store;
}
