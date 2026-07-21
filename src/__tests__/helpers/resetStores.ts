/**
 * Shared Zustand store reset for tests.
 *
 * Stores are module singletons: state leaks across tests in the same file
 * unless reset. Prefer this helper over hand-rolled partial `setState`
 * snapshots that drift from each store's real initial state.
 *
 * Uses `getInitialState()` + replace (`setState(..., true)`), and deep-clones
 * `Set` / `Map` / arrays / plain objects so in-place mutations in one test
 * cannot poison the shared initial collections. Functions (store actions)
 * keep their original references.
 */

import { useImageAnnotatorStore } from '../../renderer/components/ImageAnnotator/imageAnnotatorStore';
import { useAgentStore } from '../../renderer/stores/agentStore';
import { useBatchStore } from '../../renderer/stores/batchStore';
import { useCenterFlashStore } from '../../renderer/stores/centerFlashStore';
import { useClaudeUsageStore } from '../../renderer/stores/claudeUsageStore';
import { useCodexUsageStore } from '../../renderer/stores/codexUsageStore';
import { useComposerInputStore } from '../../renderer/stores/composerInputStore';
import { useCoworkingApprovalStore } from '../../renderer/stores/coworkingApprovalStore';
import { useCoworkingBackgroundBrowserStore } from '../../renderer/stores/coworkingBackgroundBrowserStore';
import { useCoworkingBrowserKeepAliveStore } from '../../renderer/stores/coworkingBrowserKeepAliveStore';
import { useCrossAgentInFlightStore } from '../../renderer/stores/crossAgentInFlightStore';
import { useCueDirtyStore } from '../../renderer/stores/cueDirtyStore';
import { useFeedbackDraftStore } from '../../renderer/stores/feedbackDraftStore';
import { useFileExplorerStore } from '../../renderer/stores/fileExplorerStore';
import { useGroupChatStore } from '../../renderer/stores/groupChatStore';
import { useMessageGistStore } from '../../renderer/stores/messageGistStore';
import { useModalStore } from '../../renderer/stores/modalStore';
import { useNotificationStore } from '../../renderer/stores/notificationStore';
import { useOperationStore } from '../../renderer/stores/operationStore';
import { useQuitWhenIdleStore } from '../../renderer/stores/quitWhenIdleStore';
import { useRestartPendingStore } from '../../renderer/stores/restartPendingStore';
import { useRetryStore } from '../../renderer/stores/retryStore';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../renderer/stores/settingsStore';
import { useTabStore } from '../../renderer/stores/tabStore';
import { useThoughtStreamStore } from '../../renderer/stores/thoughtStreamStore';
import { useTtsrStore } from '../../renderer/stores/ttsrStore';
import { useUIStore } from '../../renderer/stores/uiStore';

/**
 * Minimal store shape for reset (Zustand v5 `getInitialState`).
 *
 * - `getInitialState` returns `unknown` (not `Record<string, unknown>`) so
 *   interface state types without an index signature stay assignable.
 * - `setState` uses a rest `any[]` signature so Zustand's replace/partial
 *   overloads remain assignable under `strictFunctionTypes`.
 */
export type ResettableStore = {
	getInitialState: () => unknown;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see note above
	setState: (...args: any[]) => void;
};

function isPlainObject(value: object): boolean {
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Deep-clone mutable collection defaults from `getInitialState()`.
 * Leaves functions and non-plain objects (class instances, etc.) shared.
 */
function cloneCollections(value: unknown): unknown {
	if (value instanceof Set) {
		const next = new Set();
		for (const entry of value) {
			next.add(cloneCollections(entry));
		}
		return next;
	}
	if (value instanceof Map) {
		const next = new Map();
		for (const [key, entry] of value) {
			next.set(key, cloneCollections(entry));
		}
		return next;
	}
	if (Array.isArray(value)) {
		return value.map((entry) => cloneCollections(entry));
	}
	if (value && typeof value === 'object' && isPlainObject(value)) {
		const next: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			next[key] = cloneCollections(entry);
		}
		return next;
	}
	return value;
}

/**
 * Reset one Zustand store to a fresh copy of its create-time initial state.
 * Actions keep their original function references from `getInitialState()`.
 */
export function resetStore(store: ResettableStore): void {
	const initial = store.getInitialState() as Record<string, unknown>;
	const next: Record<string, unknown> = { ...initial };
	for (const key of Object.keys(next)) {
		next[key] = cloneCollections(next[key]);
	}
	store.setState(next, true);
}

/** All renderer Zustand stores that tests commonly seed or assert against. */
export const ALL_RENDERER_STORES: ResettableStore[] = [
	useSessionStore,
	useUIStore,
	useSettingsStore,
	useModalStore,
	useGroupChatStore,
	useAgentStore,
	useTabStore,
	useBatchStore,
	useFileExplorerStore,
	useNotificationStore,
	useOperationStore,
	useComposerInputStore,
	useThoughtStreamStore,
	useCenterFlashStore,
	useRetryStore,
	useRestartPendingStore,
	useQuitWhenIdleStore,
	useCueDirtyStore,
	useFeedbackDraftStore,
	useMessageGistStore,
	useClaudeUsageStore,
	useCodexUsageStore,
	useCrossAgentInFlightStore,
	useCoworkingApprovalStore,
	useCoworkingBackgroundBrowserStore,
	useCoworkingBrowserKeepAliveStore,
	useImageAnnotatorStore,
	useTtsrStore,
];

/**
 * Reset every renderer Zustand store to its initial state.
 * Call from `beforeEach` in suites that touch real stores (preferred over
 * `vi.mock` of store modules).
 */
export function resetAllStores(): void {
	for (const store of ALL_RENDERER_STORES) {
		resetStore(store);
	}
}

/**
 * Reset only the listed stores. Prefer `resetAllStores()` unless a suite
 * intentionally leaves unrelated store state alone for speed.
 */
export function resetStores(...stores: ResettableStore[]): void {
	for (const store of stores) {
		resetStore(store);
	}
}
