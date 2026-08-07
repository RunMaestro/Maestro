/**
 * Disk persistence for the main-authoritative TTSR runtime state (plan 3d).
 *
 * `once` and `after-gap` only mean anything if they outlive the process: a rule
 * that already fired must stay fired across an app restart or a session reload,
 * otherwise every relaunch re-interrupts the agent with guidance it has already
 * been given. The state store itself stays a pure in-memory structure; this
 * module is the only thing that knows about disk, mirroring how Cue keeps its
 * activity store behind a single electron-store namespace.
 *
 * Writes are debounced because the store is mutated mid-stream (once per
 * injection, once per turn end). Reads happen once, at install time.
 *
 * Retention: a conversation is dropped once it has been quiet for
 * {@link TTSR_STATE_TTL_MS}, and the newest {@link MAX_PERSISTED_CONVERSATIONS}
 * survive a cap prune. Auto Run mints a fresh Maestro session id per task, so
 * without both bounds this file would grow forever.
 */

import Store from 'electron-store';

import { logger } from '../utils/logger';
import {
	MAX_PERSISTED_CONVERSATIONS,
	TTSR_STATE_TTL_MS,
	type TtsrStateSnapshot,
	type TtsrStateStore,
} from './ttsr-state-store';

const LOG_CONTEXT = 'TTSR';

/** electron-store namespace, i.e. `userData/ttsr-state.json`. */
export const TTSR_STATE_STORE_NAME = 'ttsr-state';

// The retention policy lives with the store, which applies the same bounds to
// its in-memory map so memory never holds what disk has already dropped.
export { MAX_PERSISTED_CONVERSATIONS, TTSR_STATE_TTL_MS };

/** Default debounce between a mutation and the disk write it triggers. */
export const TTSR_STATE_SAVE_DEBOUNCE_MS = 1_000;

/** The narrow disk surface, swapped for an in-memory fake in tests. */
export interface TtsrStateBackend {
	read(): TtsrStateSnapshot;
	write(snapshot: TtsrStateSnapshot): void;
}

/** What the runtime holds: hydrate once, then schedule writes as state moves. */
export interface TtsrStatePersistence {
	/** Load the persisted snapshot into the store. Call before any matching. */
	hydrate(store: TtsrStateStore): void;
	/** Note that the store changed; the write itself is debounced. */
	scheduleSave(store: TtsrStateStore): void;
	/** Write any pending change immediately (app quit, tests). */
	flush(): void;
	/** Cancel the pending write timer. */
	dispose(): void;
}

interface TtsrStateStoreData {
	conversations: TtsrStateSnapshot;
}

/**
 * Drop expired conversations, then the oldest ones past the cap. Applied on both
 * read and write so a file that grew while an older build ran self-heals.
 */
export function pruneTtsrStateSnapshot(
	snapshot: TtsrStateSnapshot,
	now: number
): TtsrStateSnapshot {
	const live = Object.entries(snapshot ?? {}).filter(
		([, state]) => state && now - (state.updatedAt ?? 0) <= TTSR_STATE_TTL_MS
	);
	if (live.length > MAX_PERSISTED_CONVERSATIONS) {
		live.sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0));
		live.length = MAX_PERSISTED_CONVERSATIONS;
	}
	return Object.fromEntries(live);
}

/**
 * The real backend. The `Store` is created lazily on first use so a test that
 * mocks `electron-store` (or never touches persistence at all) does not pay for
 * a file handle at import time - the same reason `claudeUsageStore` defers it.
 */
export function createElectronTtsrStateBackend(): TtsrStateBackend {
	let store: Store<TtsrStateStoreData> | null = null;
	const get = (): Store<TtsrStateStoreData> => {
		if (!store) {
			store = new Store<TtsrStateStoreData>({
				name: TTSR_STATE_STORE_NAME,
				defaults: { conversations: {} },
			});
		}
		return store;
	};
	return {
		read: () => get().get('conversations', {}),
		write: (snapshot) => get().set('conversations', snapshot),
	};
}

export interface CreateTtsrStatePersistenceOptions {
	/** Defaults to the electron-store backend. */
	backend?: TtsrStateBackend;
	/** Defaults to {@link TTSR_STATE_SAVE_DEBOUNCE_MS}. */
	debounceMs?: number;
}

/**
 * Build the persistence layer. Every disk error is swallowed after being
 * logged: losing repeat bookkeeping degrades TTSR to "may re-fire a rule", but
 * throwing here would take down the agent's output stream.
 */
export function createTtsrStatePersistence(
	options: CreateTtsrStatePersistenceOptions = {}
): TtsrStatePersistence {
	const backend = options.backend ?? createElectronTtsrStateBackend();
	const debounceMs = options.debounceMs ?? TTSR_STATE_SAVE_DEBOUNCE_MS;
	let timer: NodeJS.Timeout | null = null;
	let dirty: TtsrStateStore | null = null;

	const writeNow = (store: TtsrStateStore): void => {
		try {
			backend.write(pruneTtsrStateSnapshot(store.snapshot(), Date.now()));
		} catch (err) {
			logger.warn('TTSR state persist failed', LOG_CONTEXT, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	};

	return {
		hydrate(store) {
			try {
				const pruned = pruneTtsrStateSnapshot(backend.read(), Date.now());
				store.hydrate(pruned);
			} catch (err) {
				logger.warn('TTSR state hydrate failed', LOG_CONTEXT, {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		},
		scheduleSave(store) {
			dirty = store;
			if (timer) return;
			timer = setTimeout(() => {
				timer = null;
				const pending = dirty;
				dirty = null;
				if (pending) writeNow(pending);
			}, debounceMs);
			// A pending save must never hold the app open past quit.
			timer.unref?.();
		},
		flush() {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			const pending = dirty;
			dirty = null;
			if (pending) writeNow(pending);
		},
		dispose() {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			dirty = null;
		},
	};
}
