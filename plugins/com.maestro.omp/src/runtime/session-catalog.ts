import type { OmpSessionState } from './types';

export const OMP_SESSION_CATALOG_STORAGE_KEY = 'omp.session-catalog.v1';
export const MAX_OMP_SESSION_CATALOG_ENTRIES = 100;
const MAX_CATALOG_SERIALIZED_BYTES = 128 * 1024;
const MAX_SESSION_ID_LENGTH = 4096;
const MAX_SESSION_FILE_LENGTH = 4096;
const MAX_SESSION_TITLE_LENGTH = 4096;

interface OmpCatalogStorage {
	get(key: string): Promise<unknown>;
	set(key: string, value: string): Promise<void>;
}

interface PrivateCatalogEntry {
	readonly id: string;
	readonly sessionFile: string;
	readonly title: string;
	readonly updatedAt: number;
}

export interface OmpCatalogSession {
	readonly id: string;
	readonly title: string;
	readonly updatedAt: number;
}

interface PersistedCatalog {
	readonly version: 1;
	readonly entries: readonly PrivateCatalogEntry[];
}

/**
 * Bounded plugin-private mapping between the opaque UI identifier and OMP's
 * session-file selector. Only `entries()` crosses the panel boundary.
 */
export class OmpSessionCatalog {
	private entriesById = new Map<string, PrivateCatalogEntry>();

	constructor(
		private readonly storage: OmpCatalogStorage | undefined,
		private readonly now: () => number = Date.now
	) {}

	async load(): Promise<void> {
		if (!this.storage) return;
		try {
			const raw = await this.storage.get(OMP_SESSION_CATALOG_STORAGE_KEY);
			if (raw === undefined || raw === null) return;
			if (typeof raw !== 'string' || utf8ByteLength(raw) > MAX_CATALOG_SERIALIZED_BYTES) return;
			const parsed = parsePersistedCatalog(raw);
			if (!parsed) return;
			this.entriesById = new Map(parsed.entries.map((entry) => [entry.id, entry]));
		} catch {
			// A revoked/unavailable storage grant is deliberately non-fatal: the
			// live OMP state remains usable, but no stale path is ever invented.
		}
	}

	entries(): readonly OmpCatalogSession[] {
		return Object.freeze(
			[...this.entriesById.values()]
				.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
				.map((entry) =>
					Object.freeze({ id: entry.id, title: entry.title, updatedAt: entry.updatedAt })
				)
		);
	}

	sessionPath(sessionId: string): string | undefined {
		return this.entriesById.get(sessionId)?.sessionFile;
	}

	/** Records only an OMP state which contains an actual file selector. */
	async sync(
		state: Pick<OmpSessionState, 'sessionId' | 'sessionFile' | 'sessionName'>
	): Promise<void> {
		if (!isBoundedNonEmptyString(state.sessionId, MAX_SESSION_ID_LENGTH)) return;
		if (!isBoundedNonEmptyString(state.sessionFile, MAX_SESSION_FILE_LENGTH)) return;
		const title = boundedTitle(state.sessionName, state.sessionId);
		const existing = this.entriesById.get(state.sessionId);
		const changed =
			!existing || existing.sessionFile !== state.sessionFile || existing.title !== title;
		if (!changed) return;
		const timestamp = this.now();
		const next: PrivateCatalogEntry = Object.freeze({
			id: state.sessionId,
			sessionFile: state.sessionFile,
			title,
			updatedAt: validTimestamp(timestamp) ? timestamp : 0,
		});
		this.entriesById.set(next.id, next);
		this.trim();
		await this.persist();
	}

	private trim(): void {
		if (this.entriesById.size <= MAX_OMP_SESSION_CATALOG_ENTRIES) return;
		const retained = [...this.entriesById.values()]
			.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
			.slice(0, MAX_OMP_SESSION_CATALOG_ENTRIES);
		this.entriesById = new Map(retained.map((entry) => [entry.id, entry]));
	}

	private async persist(): Promise<void> {
		if (!this.storage) return;
		const value = JSON.stringify({
			version: 1,
			entries: [...this.entriesById.values()],
		} satisfies PersistedCatalog);
		if (utf8ByteLength(value) > MAX_CATALOG_SERIALIZED_BYTES) return;
		try {
			await this.storage.set(OMP_SESSION_CATALOG_STORAGE_KEY, value);
		} catch {
			// Storage failure cannot make a current runtime session unusable.
		}
	}
}

function parsePersistedCatalog(raw: string): PersistedCatalog | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) return undefined;
		if (value.entries.length > MAX_OMP_SESSION_CATALOG_ENTRIES) return undefined;
		const seen = new Set<string>();
		const entries: PrivateCatalogEntry[] = [];
		for (const candidate of value.entries) {
			if (!isRecord(candidate)) return undefined;
			const { id, sessionFile, title, updatedAt } = candidate;
			if (
				!isBoundedNonEmptyString(id, MAX_SESSION_ID_LENGTH) ||
				!isBoundedNonEmptyString(sessionFile, MAX_SESSION_FILE_LENGTH) ||
				!isBoundedString(title, MAX_SESSION_TITLE_LENGTH) ||
				!validTimestamp(updatedAt) ||
				seen.has(id)
			)
				return undefined;
			seen.add(id);
			entries.push(Object.freeze({ id, sessionFile, title, updatedAt }));
		}
		return Object.freeze({ version: 1, entries: Object.freeze(entries) });
	} catch {
		return undefined;
	}
}

function boundedTitle(value: string | undefined, fallback: string): string {
	return isBoundedNonEmptyString(value, MAX_SESSION_TITLE_LENGTH) ? value : fallback;
}

function isBoundedNonEmptyString(value: unknown, maximum: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function isBoundedString(value: unknown, maximum: number): value is string {
	return typeof value === 'string' && value.length <= maximum;
}

function validTimestamp(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}
