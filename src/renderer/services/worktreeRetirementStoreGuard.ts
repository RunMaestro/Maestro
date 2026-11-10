import { create, type StateCreator, type StoreApi } from 'zustand';

type RetirementStore = 'sessions' | 'batch' | 'composer' | 'modals' | 'ui';
type Guard = (store: RetirementStore, previous: unknown, next: unknown) => void;
const guards = new Set<Guard>();
const dialogs = new Set<object>();

/** Installed synchronously before inspection; removed only by the token owner. */
export function registerRetirementStoreGuard(guard: Guard): () => void {
	guards.add(guard);
	return () => guards.delete(guard);
}

export function assertRetirementStoreUpdate(
	store: RetirementStore,
	previous: unknown,
	next: unknown
): void {
	for (const guard of guards) guard(store, previous, next);
}

/** Zustand's internal action setter AND public setState must share admission.
 * No snapshot subscriptions: those run after a forbidden update has committed.
 */
export function createRetirementStore<T>(store: RetirementStore) {
	return (initialize: StateCreator<T>) =>
		create<T>()((set, get, api) => {
			const guardedSet: StoreApi<T>['setState'] = (partial, replace) => {
				if (!guards.size) return set(partial as T, replace as true);
				const previous = get();
				const patch = typeof partial === 'function' ? (partial as (s: T) => T)(previous) : partial;
				if (Object.is(patch, previous)) return;
				const next =
					(replace ?? (typeof patch !== 'object' || patch === null))
						? (patch as T)
						: Object.assign({}, previous, patch);
				assertRetirementStoreUpdate(store, previous, next);
				set(next, true);
			};
			api.setState = guardedSet;
			return initialize(guardedSet, get, api);
		});
}

/** File explorer dialogs keep React-local draft state. Register at the opening
 * setter, before React commits an effect or a modal layer appears.
 */
export function setRetirementDialogOpen(owner: object, open: boolean): void {
	if (open) {
		if (guards.size) throw new Error('Worktree retirement: editing dialog admission is frozen');
		dialogs.add(owner);
	} else dialogs.delete(owner);
}

export function hasRetirementDialogs(): boolean {
	return dialogs.size > 0;
}
