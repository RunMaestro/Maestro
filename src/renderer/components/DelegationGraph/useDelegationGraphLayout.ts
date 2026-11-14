/**
 * useDelegationGraphLayout - one scope's saved arrangement, and the five ways
 * it changes.
 *
 * The record itself lives in the settings store
 * (`settingsDelegationGraphSlice.ts`). This hook is the canvas's view of it:
 * it reads the entry for the scope on screen, and it owns WHEN a change is
 * written, which the store cannot know.
 *
 *   - A drag fires on every mouse move, so its writes are debounced. A write
 *     per event would send the whole record through IPC dozens of times a
 *     second.
 *   - Applying an algorithm and resetting are single, deliberate actions, so
 *     they write at once, and they cancel a drag write that is still waiting.
 *     Otherwise the stale drag would land afterwards and put the scope back on
 *     `manual`.
 *   - A new agent that the canvas placed beside its neighbors is ADDED to what
 *     is saved, so it is in the same place on the next open. It changes
 *     neither the layout nor any position already saved.
 *   - An agent dropped on the canvas at a point is hand placement like a drag,
 *     and one deliberate action like an algorithm, so it is saved as a drag is
 *     and written at once.
 *
 * A drag write that is still waiting is flushed when the scope changes and
 * when the canvas unmounts, so switching scope or closing the graph inside the
 * debounce window does not lose the last move.
 */

import { useEffect } from 'react';
import type { DelegationGraphScope } from '../../../shared/delegationGraph';
import {
	prunePositions,
	scopeStorageKey,
	type DelegationSavedPositions,
} from '../../../shared/delegationGraphLayout';
import { useDebouncedCallback } from '../../hooks/utils/useThrottle';
import { useStableCallback } from '../../hooks/utils/useStableCallback';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import {
	DEFAULT_GLOBAL_DELEGATION_LAYOUT,
	DEFAULT_DELEGATION_LAYOUT,
	type DelegationAlgorithmLayout,
	type DelegationLayoutType,
} from './delegationLayoutTypes';

/** How long a drag must rest before its positions are written. */
export const DELEGATION_POSITION_SAVE_DEBOUNCE_MS = 300;

/** What a scope with nothing saved reads as. One object, so memo deps stay stable. */
const NO_SAVED_POSITIONS: DelegationSavedPositions = Object.freeze({});

export interface DelegationGraphLayoutControls {
	/** The scope's layout. The default until the user picks one or drags a node. */
	layout: DelegationLayoutType;
	/** The scope has an arrangement saved, so a reset has something to forget. */
	hasSavedLayout: boolean;
	/** Where the user left each agent in this scope. Empty when nothing is saved. */
	positions: DelegationSavedPositions;
	/**
	 * A node was dragged: the scope becomes `manual` and keeps these positions.
	 * Pass EVERY node on the canvas, not only the one that moved. The first drag
	 * is what turns an algorithm's arrangement into a saved one, and a node left
	 * out of it has no saved position on the next open.
	 */
	saveDraggedPositions: (positions: DelegationSavedPositions) => void;
	/**
	 * An agent was dropped on the canvas at a point: the scope becomes `manual`
	 * and keeps these positions, as after a drag. Pass every node on the canvas
	 * and the dropped agent. It is written AT ONCE, because the canvas reads the
	 * position back in the render that first draws the agent, and a write that
	 * waited would draw it somewhere else first.
	 */
	saveDroppedPositions: (positions: DelegationSavedPositions) => void;
	/** An algorithm was applied: its positions REPLACE everything saved for the scope. */
	saveAlgorithmLayout: (
		layout: DelegationAlgorithmLayout,
		positions: DelegationSavedPositions
	) => void;
	/**
	 * The canvas placed agents that had no saved position: keep them there. Only
	 * a scope that already has an arrangement saved is written, because a scope
	 * with nothing saved is arranged afresh on every open and has no place to
	 * keep. A position already saved is never replaced by this.
	 */
	savePlacedPositions: (positions: DelegationSavedPositions) => void;
	/** Forget the scope's arrangement. It opens on the default layout again. */
	resetLayout: () => void;
}

/** Every agent that exists, for `prunePositions`. */
function liveSessionIds(): string[] {
	return useSessionStore.getState().sessions.map((session) => session.id);
}

/**
 * Fold dragged positions into what the scope already has saved, and store the
 * result as `manual`. Reads the store when it RUNS, not when it was scheduled,
 * so a debounced call never writes over a newer record with an older one.
 */
function writeDraggedPositions(
	scope: DelegationGraphScope,
	positions: DelegationSavedPositions
): void {
	const { delegationGraphLayouts, setDelegationScopeLayout } = useSettingsStore.getState();
	const saved = delegationGraphLayouts[scopeStorageKey(scope)]?.positions;
	setDelegationScopeLayout(scope, {
		layout: 'manual',
		positions: prunePositions({ ...saved, ...positions }, liveSessionIds()),
	});
}

export function useDelegationGraphLayout(
	scope: DelegationGraphScope
): DelegationGraphLayoutControls {
	const scopeKey = scopeStorageKey(scope);
	const saved = useSettingsStore((state) => state.delegationGraphLayouts[scopeKey]);

	const { debouncedCallback, flush, cancel } = useDebouncedCallback(
		writeDraggedPositions,
		DELEGATION_POSITION_SAVE_DEBOUNCE_MS,
		{ flushOnUnmount: true }
	);

	// The pending write carries the scope it was made for, so flushing it after
	// the scope has changed still writes to the scope the drag happened in.
	useEffect(() => flush, [scopeKey, flush]);

	const saveDraggedPositions = useStableCallback((positions: DelegationSavedPositions) => {
		const stored = useSettingsStore.getState().delegationGraphLayouts[scopeKey];
		if (stored?.layout !== 'manual') {
			// The first move of a hand arrangement is written at once, so the
			// toolbar reads Manual while the node is still in the user's hand. Every
			// move after it finds `manual` already stored and waits for the debounce.
			cancel();
			writeDraggedPositions(scope, positions);
			return;
		}
		debouncedCallback(scope, positions);
	});

	const saveDroppedPositions = useStableCallback((positions: DelegationSavedPositions) => {
		// The caller passed where every node is now, so a drag write that is still
		// waiting holds nothing this one does not.
		cancel();
		writeDraggedPositions(scope, positions);
	});

	const saveAlgorithmLayout = useStableCallback(
		(layout: DelegationAlgorithmLayout, positions: DelegationSavedPositions) => {
			cancel();
			useSettingsStore.getState().setDelegationScopeLayout(scope, { layout, positions });
		}
	);

	const savePlacedPositions = useStableCallback((positions: DelegationSavedPositions) => {
		const { delegationGraphLayouts, setDelegationScopeLayout } = useSettingsStore.getState();
		const stored = delegationGraphLayouts[scopeKey];
		if (!stored) return;

		const live = liveSessionIds();
		const added: DelegationSavedPositions = {};
		for (const [sessionId, position] of Object.entries(prunePositions(positions, live))) {
			if (!Object.prototype.hasOwnProperty.call(stored.positions, sessionId)) {
				added[sessionId] = position;
			}
		}
		// Nothing new to keep: no write. The canvas calls this from an effect that
		// re-runs when the saved positions change, so a write that changes nothing
		// would call it again without end.
		if (Object.keys(added).length === 0) return;

		setDelegationScopeLayout(scope, {
			layout: stored.layout,
			positions: prunePositions({ ...stored.positions, ...added }, live),
		});
	});

	const resetLayout = useStableCallback(() => {
		cancel();
		useSettingsStore.getState().resetDelegationScopeLayout(scope);
	});

	return {
		layout:
			saved?.layout ??
			(scope.kind === 'all' ? DEFAULT_GLOBAL_DELEGATION_LAYOUT : DEFAULT_DELEGATION_LAYOUT),
		hasSavedLayout: saved !== undefined,
		positions: saved?.positions ?? NO_SAVED_POSITIONS,
		saveDraggedPositions,
		saveDroppedPositions,
		saveAlgorithmLayout,
		savePlacedPositions,
		resetLayout,
	};
}
