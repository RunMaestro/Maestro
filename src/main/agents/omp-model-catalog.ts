/**
 * Oh My Pi model -> context-window catalog.
 *
 * Oh My Pi is multi-provider and multi-model, so a single per-agent context
 * window is wrong: the real window depends on the model a turn actually ran on
 * (e.g. `claude-opus-4-8` is 1M, `claude-haiku-4-5` is 200k). The `omp` CLI
 * exposes the authoritative mapping via `omp models --json`, which lists every
 * model with its `contextWindow`.
 *
 * The parser reports the per-turn model on the usage event, and `StdoutHandler`
 * resolves it against this cache to stamp the real window on `UsageStats`. Keep
 * the lookup SYNCHRONOUS (the usage path is hot and per-turn) - the cache is
 * primed off-path from the detector's `omp models --json` call and, eagerly,
 * when an omp process is spawned.
 *
 * Scope / identity: the catalog is fetched with a specific `omp` binary and
 * environment, and the available models (and, via custom providers, even a
 * model's window) can differ per install/config. Every catalog is therefore
 * keyed by an identity ({@link computeOmpCatalogKey}) combining the resolved
 * binary path with a hash of the session's env overrides, and lookups must pass
 * the SAME identity (carried on the managed process). This prevents one local
 * configuration from being served another's window as authoritative. Remote
 * (SSH) omp agents are not cataloged here; callers gate lookups to local
 * processes and fall back to the configured/default window otherwise.
 */

import { createHash } from 'crypto';
import { execFileNoThrow } from '../utils/execFile';
import { parseJsonWithBom } from '../../shared/jsonUtils';
import { logger } from '../utils/logger';

const LOG_CONTEXT = 'OmpModelCatalog';

/** One entry from `omp models --json` (only the fields we need). */
export interface OmpCatalogEntry {
	id?: string;
	selector?: string;
	contextWindow?: number;
}

/**
 * A resolved model-window map for one identity. A value of `null` marks an
 * AMBIGUOUS key: two catalog entries claimed the same normalized key with
 * different windows (e.g. two providers exposing a bare `gpt-5` at different
 * sizes), so it must NOT resolve authoritatively - only an unambiguous full
 * selector/id wins, everything else falls back.
 */
interface CatalogState {
	windows: Map<string, number | null>;
	primedAt: number;
}

/** identity -> resolved windows. */
const catalogs = new Map<string, CatalogState>();
/** identity -> in-flight prime, so concurrent spawns share one fetch. */
const primingPromises = new Map<string, Promise<void>>();
/** Re-fetch at most this often; the catalog is effectively static per install. */
const PRIME_TTL_MS = 5 * 60 * 1000;

function normalizeKey(model: string): string {
	return model.trim().toLowerCase();
}

/** The bare model id after the last provider prefix (`anthropic/opus` -> `opus`). */
function bareId(model: string): string {
	const slash = model.lastIndexOf('/');
	return slash >= 0 ? model.slice(slash + 1) : model;
}

/**
 * Build the identity key for a catalog: the resolved omp binary plus a hash of
 * the session's env overrides. Two sessions that run the same binary with the
 * same overrides share a catalog; a different custom path or overridden
 * provider/config gets its own, so a cached window is never reused across
 * configurations. Only the overrides are hashed (not the whole process env,
 * which is constant within an app instance), and hashing avoids holding secret
 * values in a map key.
 */
export function computeOmpCatalogKey(
	binaryPath: string,
	envOverrides?: Record<string, string>
): string {
	const entries = Object.entries(envOverrides ?? {}).sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0
	);
	const envHash = createHash('sha1').update(JSON.stringify(entries)).digest('hex');
	return `${binaryPath}\u0000${envHash}`;
}

/** Record one key -> window, marking it ambiguous (`null`) on a conflicting window. */
function assignWindow(windows: Map<string, number | null>, key: string, cw: number): void {
	if (!windows.has(key)) {
		windows.set(key, cw);
		return;
	}
	const existing = windows.get(key);
	// Already ambiguous, or a different entry claims a different window: keep it
	// ambiguous so it can't resolve to the wrong provider's window.
	if (existing !== null && existing !== cw) {
		windows.set(key, null);
	}
}

/**
 * Populate the catalog for `catalogKey` from already-parsed `omp models --json`
 * entries. Each model is keyed by its provider-qualified selector, its id, and
 * the bare id (each normalized) so a lookup succeeds whether the stream reports
 * `claude-opus-4-8` or `anthropic/claude-opus-4-8`. Conflicting windows on a
 * shared key are marked ambiguous (see {@link CatalogState}).
 */
export function setOmpModelCatalog(entries: readonly OmpCatalogEntry[], catalogKey: string): void {
	// `omp models --json` is a full snapshot, so replace this identity's map
	// rather than merging (avoids stale models and sticky ambiguity across primes).
	const windows = new Map<string, number | null>();
	for (const entry of entries) {
		const cw = entry.contextWindow;
		if (typeof cw !== 'number' || cw <= 0) continue;
		for (const key of [entry.id, entry.selector]) {
			if (!key) continue;
			assignWindow(windows, normalizeKey(key), cw);
			assignWindow(windows, normalizeKey(bareId(key)), cw);
		}
	}
	catalogs.set(catalogKey, { windows, primedAt: Date.now() });
}

/**
 * Synchronously resolve the context window for a model reported by omp under the
 * given identity, or null when it isn't cataloged for that identity or resolves
 * ambiguously. Tolerant of provider-qualified selectors vs bare ids.
 */
export function getOmpModelContextWindow(
	model: string | null | undefined,
	catalogKey: string | null | undefined
): number | null {
	if (!model || !catalogKey) return null;
	const windows = catalogs.get(catalogKey)?.windows;
	if (!windows) return null;
	const direct = windows.get(normalizeKey(model));
	if (direct !== undefined) return direct; // number, or null when ambiguous
	return windows.get(normalizeKey(bareId(model))) ?? null;
}

/**
 * Fetch `omp models --json` with the given command/env and populate the catalog
 * under `catalogKey`. Best-effort and deduped per identity: concurrent callers
 * share one fetch, and a fresh catalog is not re-fetched within
 * {@link PRIME_TTL_MS}. Never throws.
 */
export function primeOmpModelCatalog(
	command: string,
	env: NodeJS.ProcessEnv | undefined,
	catalogKey: string
): Promise<void> {
	const inFlight = primingPromises.get(catalogKey);
	if (inFlight) return inFlight;
	const existing = catalogs.get(catalogKey);
	if (existing && Date.now() - existing.primedAt < PRIME_TTL_MS) {
		return Promise.resolve();
	}
	const promise = (async () => {
		try {
			const result = await execFileNoThrow(command, ['models', '--json'], undefined, env);
			if (result.exitCode !== 0) {
				logger.debug('omp models --json failed while priming catalog', LOG_CONTEXT, {
					exitCode: result.exitCode,
				});
				return;
			}
			const parsed = parseJsonWithBom<{ models?: OmpCatalogEntry[] }>(result.stdout);
			if (Array.isArray(parsed.models)) {
				setOmpModelCatalog(parsed.models, catalogKey);
			}
		} catch (error) {
			logger.debug('Failed to prime omp model catalog', LOG_CONTEXT, { error: String(error) });
		} finally {
			primingPromises.delete(catalogKey);
		}
	})();
	primingPromises.set(catalogKey, promise);
	return promise;
}

/** Test-only: reset the in-memory catalogs so cases don't leak into each other. */
export function __resetOmpModelCatalogForTests(): void {
	catalogs.clear();
	primingPromises.clear();
}
