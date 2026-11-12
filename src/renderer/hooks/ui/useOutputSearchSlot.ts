/**
 * Bind a uiStore outputSearchByKey slot to a concrete chat-window key
 * (agent+tab or group-chat::<id>).
 */
import { useCallback } from 'react';
import { useUIStore } from '../../stores/uiStore';

export interface OutputSearchSlotBind {
	outputSearchOpen: boolean;
	outputSearchQuery: string;
	outputSearchRegex: boolean;
	setOutputSearchOpen: (open: boolean) => void;
	setOutputSearchQuery: (query: string) => void;
	setOutputSearchRegex: (regex: boolean) => void;
	/** Close the bar and clear the query for this key. */
	clearOutputSearch: () => void;
}

export function useOutputSearchSlot(searchKey: string): OutputSearchSlotBind {
	const searchSlot = useUIStore((s) => s.outputSearchByKey?.[searchKey]);
	const outputSearchOpen = searchSlot?.open ?? false;
	const outputSearchQuery = searchSlot?.query ?? '';
	const outputSearchRegex = searchSlot?.regex ?? false;

	const setOutputSearchOpen = useCallback(
		(open: boolean) => {
			useUIStore.getState().setOutputSearchOpen(searchKey, open);
		},
		[searchKey]
	);
	const setOutputSearchQuery = useCallback(
		(query: string) => {
			useUIStore.getState().setOutputSearchQuery(searchKey, query);
		},
		[searchKey]
	);
	const setOutputSearchRegex = useCallback(
		(regex: boolean) => {
			useUIStore.getState().setOutputSearchRegex(searchKey, regex);
		},
		[searchKey]
	);
	const clearOutputSearch = useCallback(() => {
		const ui = useUIStore.getState();
		ui.setOutputSearchOpen(searchKey, false);
		ui.setOutputSearchQuery(searchKey, '');
	}, [searchKey]);

	return {
		outputSearchOpen,
		outputSearchQuery,
		outputSearchRegex,
		setOutputSearchOpen,
		setOutputSearchQuery,
		setOutputSearchRegex,
		clearOutputSearch,
	};
}
