/**
 * GitHub Client Wrapper — #444
 *
 * Thin wrapper over `gh` CLI calls for reading and writing GitHub Projects v2.
 * Used by DispatchEngine, pm-tools, pm-audit, and the stale sweeper as the
 * sole interface to GitHub — local work-graph SQLite is gone.
 *
 * Design:
 *   - All reads go through a TTL cache (default 30 s) keyed by query params.
 *   - Own writes (setItemFieldValue, addItemComment) flush the relevant cache
 *     entries immediately so the next read is fresh.
 *   - Rate-limit guard: if remaining < 100 calls, all reads return from cache
 *     (even stale).  Writes always proceed.
 *   - Uses the same `gh` credential that the rest of the codebase already
 *     relies on (DeliveryPlannerGithubSync, pm-reverse-sync, etc.).
 */

import { execFileNoThrow } from '../utils/execFile';
import { logger } from '../utils/logger';
import {
	LEGACY_HUMPFTECH_OWNER,
	LEGACY_HUMPFTECH_PROJECT_NUMBER,
} from '../../shared/legacy-humpftech-fallback';

/**
 * Legacy fallback project coordinates (#447): used by GithubClient when no
 * per-project mapping has been resolved via discoverGithubProject().
 *
 * This is a defensive fallback for the HumpfTech/Maestro fork environment;
 * auto-discovery should normally provide values from `projectGithubMap`.
 * Active code should always inject coordinates via GithubClientOptions.projectOwner /
 * projectNumber rather than relying on these defaults.
 *
 * TODO: remove once auto-discovery is universal (#447).
 */
const LEGACY_FALLBACK_PROJECT_OWNER = LEGACY_HUMPFTECH_OWNER;
const LEGACY_FALLBACK_PROJECT_NUMBER = LEGACY_HUMPFTECH_PROJECT_NUMBER;

const LOG_CONTEXT = '[GithubClient]';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GithubProjectItem {
	id: string;
	/** Issue / PR number extracted from content.url */
	issueNumber?: number;
	title?: string;
	/** Field values keyed by field name */
	fields: Record<string, string>;
}

export interface GithubProjectItemFilters {
	/** Only return items whose "AI Assigned Slot" matches this pattern. */
	assignedSlotMatches?: string;
	/** Only return items where "AI Status" is one of these values. */
	statusIn?: string[];
}

export interface GithubRateLimit {
	remaining: number;
	limit: number;
	resetAt: string;
}

// ---------------------------------------------------------------------------
// Internal cache types
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
	data: T;
	fetchedAt: number;
}

// ---------------------------------------------------------------------------
// GithubClient
// ---------------------------------------------------------------------------

export class GithubClient {
	private readonly ttlMs: number;
	private readonly rateLimitLow: number;
	private readonly itemListCache = new Map<string, CacheEntry<GithubProjectItem[]>>();
	private rateLimitRemaining = Infinity;
	private rateLimitCheckedAt = 0;
	// How often to re-check the rate limit (10 min)
	private readonly rateLimitCheckIntervalMs = 10 * 60 * 1000;
	/** Per-project GitHub project owner (#447). */
	private readonly projectOwner: string;
	/** Per-project GitHub project number (#447). */
	private readonly projectNumber: number;

	constructor(
		opts: {
			ttlMs?: number;
			rateLimitLow?: number;
			projectOwner?: string;
			projectNumber?: number;
		} = {}
	) {
		this.ttlMs = opts.ttlMs ?? 30_000;
		this.rateLimitLow = opts.rateLimitLow ?? 100;
		this.projectOwner = opts.projectOwner ?? LEGACY_FALLBACK_PROJECT_OWNER;
		this.projectNumber = opts.projectNumber ?? LEGACY_FALLBACK_PROJECT_NUMBER;
	}

	// -------------------------------------------------------------------------
	// listProjectItems
	// -------------------------------------------------------------------------

	/**
	 * Return project items, optionally filtered.  Cached for `ttlMs`.
	 */
	async listProjectItems(filters?: GithubProjectItemFilters): Promise<GithubProjectItem[]> {
		const cacheKey = JSON.stringify(filters ?? {});
		const now = Date.now();

		const cached = this.itemListCache.get(cacheKey);
		const isStale = !cached || now - cached.fetchedAt > this.ttlMs;

		// If rate-limited and we have a cached copy (even stale), return it.
		if (!isStale || (await this.isRateLimited(now))) {
			if (cached) {
				return cached.data;
			}
		}

		const raw = await this.fetchAllProjectItems();
		let items = raw;

		// Apply filters in-process (avoids N+1 gh calls)
		if (filters?.statusIn && filters.statusIn.length > 0) {
			const statusSet = new Set(filters.statusIn.map((s) => s.toLowerCase()));
			items = items.filter((item) => {
				const status = (item.fields['AI Status'] ?? '').toLowerCase();
				return statusSet.has(status);
			});
		}
		if (filters?.assignedSlotMatches !== undefined) {
			const pattern = filters.assignedSlotMatches;
			items = items.filter((item) => {
				const slot = item.fields['AI Assigned Slot'] ?? '';
				return pattern === '' ? slot === '' : slot.includes(pattern);
			});
		}

		// Cache the unfiltered result; filtered views are sub-queries
		this.itemListCache.set(cacheKey, { data: items, fetchedAt: now });
		// Also cache the unfiltered root result for re-use
		const rootKey = JSON.stringify({});
		if (cacheKey !== rootKey) {
			const rootCached = this.itemListCache.get(rootKey);
			if (!rootCached || now - rootCached.fetchedAt > this.ttlMs) {
				this.itemListCache.set(rootKey, { data: raw, fetchedAt: now });
			}
		}

		return items;
	}

	// -------------------------------------------------------------------------
	// setItemFieldValue
	// -------------------------------------------------------------------------

	/**
	 * Write a single project-item field value, then flush the read cache so the
	 * next read reflects the write.
	 */
	async setItemFieldValue(
		projectId: string,
		itemId: string,
		fieldName: string,
		value: string
	): Promise<void> {
		// Read the field list to resolve field ID + option ID (for single-select)
		const fields = await this.readProjectFields();
		const field = fields.find((f) => f.name === fieldName);
		if (!field) {
			throw new Error(`GitHub project field "${fieldName}" was not found`);
		}

		const args = [
			'project',
			'item-edit',
			'--project-id',
			projectId,
			'--id',
			itemId,
			'--field-id',
			field.id,
		];

		const option = field.options?.find((o) => o.name === value);
		if (option) {
			await this.runGh([...args, '--single-select-option-id', option.id]);
		} else {
			await this.runGh([...args, '--text', value]);
		}

		// Flush all cached item lists after a write
		this.itemListCache.clear();

		logger.debug(
			`setItemFieldValue itemId=${itemId} field="${fieldName}" value="${value}"`,
			LOG_CONTEXT
		);
	}

	// -------------------------------------------------------------------------
	// addItemComment
	// -------------------------------------------------------------------------

	/**
	 * Post a comment on a GitHub issue.
	 */
	async addItemComment(issueNumber: number, repo: string, body: string): Promise<void> {
		await this.runGh(['issue', 'comment', String(issueNumber), '-R', repo, '--body', body]);
	}

	// -------------------------------------------------------------------------
	// readProjectId
	// -------------------------------------------------------------------------

	/**
	 * Return the node ID for the project, cached for the lifetime of this
	 * client instance (project ID doesn't change).
	 */
	private _cachedProjectId: string | undefined;

	async readProjectId(): Promise<string> {
		if (this._cachedProjectId) return this._cachedProjectId;

		const result = await this.runGh([
			'project',
			'view',
			String(this.projectNumber),
			'--owner',
			this.projectOwner,
			'--format',
			'json',
		]);

		const parsed = this.parseJson<{ id?: string }>(result.stdout, 'project view');
		const id = parsed.id;
		if (!id) throw new Error('GitHub project view returned no id');
		this._cachedProjectId = id;
		return id;
	}

	// -------------------------------------------------------------------------
	// Internal helpers
	// -------------------------------------------------------------------------

	private async fetchAllProjectItems(): Promise<GithubProjectItem[]> {
		const result = await this.runGh([
			'project',
			'item-list',
			String(this.projectNumber),
			'--owner',
			this.projectOwner,
			'--format',
			'json',
			'--limit',
			'500',
		]);

		type RawItem = {
			id: string;
			content?: { url?: string; number?: number; title?: string };
			fieldValues?: Record<string, { name?: string; text?: string; date?: string } | undefined>;
			[key: string]: unknown;
		};

		const parsed = this.parseJson<{ items?: RawItem[] } | RawItem[]>(
			result.stdout,
			'project item-list'
		);
		const rawItems: RawItem[] = Array.isArray(parsed) ? parsed : (parsed.items ?? []);

		return rawItems.map((raw): GithubProjectItem => {
			// Extract field values: try fieldValues map first, fall back to top-level keys.
			const fields: Record<string, string> = {};
			if (raw.fieldValues && typeof raw.fieldValues === 'object') {
				for (const [key, val] of Object.entries(raw.fieldValues)) {
					if (!val) continue;
					const str = val.name ?? val.text ?? val.date;
					if (str) fields[key] = str;
				}
			}

			const issueNumber =
				raw.content?.number ?? (raw.content?.url ? extractIssueNumber(raw.content.url) : undefined);

			return {
				id: raw.id,
				issueNumber,
				title: raw.content?.title,
				fields,
			};
		});
	}

	/** Cache for project fields — short TTL (5 min). */
	private _fieldsCache: CacheEntry<ProjectField[]> | undefined;
	private readonly fieldsTtlMs = 5 * 60 * 1000;

	async readProjectFields(): Promise<ProjectField[]> {
		const now = Date.now();
		if (this._fieldsCache && now - this._fieldsCache.fetchedAt < this.fieldsTtlMs) {
			return this._fieldsCache.data;
		}

		const result = await this.runGh([
			'project',
			'field-list',
			String(this.projectNumber),
			'--owner',
			this.projectOwner,
			'--format',
			'json',
		]);

		type RawFields = { fields?: ProjectField[] } | ProjectField[];
		const parsed = this.parseJson<RawFields>(result.stdout, 'project field-list');
		const fields: ProjectField[] = Array.isArray(parsed) ? parsed : (parsed.fields ?? []);
		this._fieldsCache = { data: fields, fetchedAt: now };
		return fields;
	}

	private async isRateLimited(now: number): Promise<boolean> {
		if (now - this.rateLimitCheckedAt < this.rateLimitCheckIntervalMs) {
			return this.rateLimitRemaining < this.rateLimitLow;
		}

		try {
			const result = await this.runGh(['api', 'rate_limit']);
			type RateLimitResponse = {
				rate?: { remaining?: number; limit?: number; reset?: number };
			};
			const parsed = this.parseJson<RateLimitResponse>(result.stdout, 'rate_limit');
			this.rateLimitRemaining = parsed.rate?.remaining ?? Infinity;
			this.rateLimitCheckedAt = now;
		} catch {
			// If we can't check, assume we're not rate-limited.
			this.rateLimitRemaining = Infinity;
		}

		return this.rateLimitRemaining < this.rateLimitLow;
	}

	private async runGh(args: string[]): Promise<{ stdout: string; stderr: string }> {
		const result = await execFileNoThrow('gh', args);
		if (result.exitCode !== 0) {
			throw new Error(`gh ${args[0]} ${args[1] ?? ''} failed: ${result.stderr.trim()}`);
		}
		return { stdout: result.stdout, stderr: result.stderr };
	}

	private parseJson<T>(text: string, context: string): T {
		try {
			return JSON.parse(text) as T;
		} catch {
			throw new Error(`${context}: invalid JSON response from gh CLI`);
		}
	}
}

// ---------------------------------------------------------------------------
// ProjectField type (shared internally)
// ---------------------------------------------------------------------------

export interface ProjectField {
	id: string;
	name: string;
	dataType?: string;
	options?: Array<{ id: string; name: string }>;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function extractIssueNumber(url: string): number | undefined {
	const match = /\/issues\/(\d+)$/.exec(url);
	return match ? Number(match[1]) : undefined;
}

// ---------------------------------------------------------------------------
// Singleton (used by main-process modules that don't own a class instance)
// ---------------------------------------------------------------------------

let _defaultClient: GithubClient | undefined;

export function getGithubClient(): GithubClient {
	if (!_defaultClient) {
		_defaultClient = new GithubClient();
	}
	return _defaultClient;
}
