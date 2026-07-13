import { useCallback, useEffect, useReducer } from 'react';
import type { OmpWorkspaceAdapter, OmpWorkspaceSnapshot } from './types';

export interface OmpWorkspaceState {
	snapshot: OmpWorkspaceSnapshot | null;
	phase: 'loading' | 'ready' | 'error';
	loadError: string | null;
}

type OmpWorkspaceAction =
	| { type: 'snapshot'; snapshot: OmpWorkspaceSnapshot }
	| { type: 'load-error'; message: string };

export const initialOmpWorkspaceState: OmpWorkspaceState = {
	snapshot: null,
	phase: 'loading',
	loadError: null,
};

export function reduceOmpWorkspaceState(
	state: OmpWorkspaceState,
	action: OmpWorkspaceAction
): OmpWorkspaceState {
	if (action.type === 'snapshot') {
		return { snapshot: action.snapshot, phase: 'ready', loadError: null };
	}
	return { ...state, phase: 'error', loadError: action.message };
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'OMP workspace could not load.';
}

/** Binds a renderer-local OMP adapter to a small explicit load/stream state machine. */
export function useOmpWorkspace(adapter: OmpWorkspaceAdapter) {
	const [state, dispatch] = useReducer(reduceOmpWorkspaceState, initialOmpWorkspaceState);

	const refresh = useCallback(async () => {
		try {
			dispatch({ type: 'snapshot', snapshot: await adapter.getSnapshot() });
		} catch (error) {
			dispatch({ type: 'load-error', message: toErrorMessage(error) });
		}
	}, [adapter]);

	useEffect(() => {
		let active = true;
		void adapter
			.getSnapshot()
			.then((snapshot) => {
				if (active) dispatch({ type: 'snapshot', snapshot });
			})
			.catch((error: unknown) => {
				if (active) dispatch({ type: 'load-error', message: toErrorMessage(error) });
			});
		const unsubscribe = adapter.subscribe((snapshot) => {
			if (active) dispatch({ type: 'snapshot', snapshot });
		});
		return () => {
			active = false;
			unsubscribe();
		};
	}, [adapter]);

	return { ...state, refresh };
}
