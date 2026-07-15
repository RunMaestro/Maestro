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
 * primed off-path from the detector's existing `omp models --json` call and,
 * eagerly, when an omp process is spawned.
 *
 * Scope: the catalog is fetched with the LOCAL `omp` binary, so it only
 * describes local runs. Remote (SSH) omp agents may resolve models differently;
 * callers gate lookups to local processes and fall back to the configured /
 * default window when the model can't be resolved here.
 */

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

/** Normalized-model-key -> context window (tokens). */
const catalog = new Map<string, number>();

/** In-flight prime, so concurrent spawns share one `omp models --json` call. */
let primingPromise: Promise<void> | null = null;
let lastPrimedAt = 0;
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
 * Populate the catalog from already-parsed `omp models --json` entries. Keyed by
 * both the provider-qualified selector and the bare id (each normalized) so a
 * lookup succeeds whether the stream reports `claude-opus-4-8` or
 * `anthropic/claude-opus-4-8`.
 */
export function setOmpModelCatalog(entries: readonly OmpCatalogEntry[]): void {
	let added = 0;
	for (const entry of entries) {
		const cw = entry.contextWindow;
		if (typeof cw !== 'number' || cw <= 0) continue;
		for (const key of [entry.id, entry.selector]) {
			if (!key) continue;
			catalog.set(normalizeKey(key), cw);
			catalog.set(normalizeKey(bareId(key)), cw);
			added++;
		}
	}
	if (added > 0) lastPrimedAt = Date.now();
}

/**
 * Synchronously resolve the context window for a model reported by omp, or null
 * when it isn't in the (local) catalog. Tolerant of provider-qualified selectors
 * vs bare ids in either direction.
 */
export function getOmpModelContextWindow(model: string | null | undefined): number | null {
	if (!model) return null;
	return catalog.get(normalizeKey(model)) ?? catalog.get(normalizeKey(bareId(model))) ?? null;
}

/**
 * Fetch `omp models --json` with the given command/env and populate the catalog.
 * Best-effort and deduped: concurrent callers share one fetch, and a fresh
 * catalog is not re-fetched within {@link PRIME_TTL_MS}. Never throws.
 */
export function primeOmpModelCatalog(command: string, env?: NodeJS.ProcessEnv): Promise<void> {
	if (primingPromise) return primingPromise;
	if (catalog.size > 0 && Date.now() - lastPrimedAt < PRIME_TTL_MS) {
		return Promise.resolve();
	}
	primingPromise = (async () => {
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
				setOmpModelCatalog(parsed.models);
			}
		} catch (error) {
			logger.debug('Failed to prime omp model catalog', LOG_CONTEXT, { error: String(error) });
		} finally {
			primingPromise = null;
		}
	})();
	return primingPromise;
}

/** Test-only: reset the in-memory catalog so cases don't leak into each other. */
export function __resetOmpModelCatalogForTests(): void {
	catalog.clear();
	primingPromise = null;
	lastPrimedAt = 0;
}
