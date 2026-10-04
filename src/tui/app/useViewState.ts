import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { loadTuiState, saveTuiViewState, type TuiViewState } from '../store/view-state';

/**
 * The TUI's persisted view state (selection, folded groups, pane width).
 *
 * Loaded once, then saved after each change to `maestro-tui.json`. A state file
 * that cannot be read as JSON is never written over, and a write that fails
 * once (the data directory is missing, say) is not retried on every keypress.
 */
export function useViewState(file: string): [TuiViewState, Dispatch<SetStateAction<TuiViewState>>] {
	const loaded = useMemo(() => loadTuiState(file), [file]);
	const [view, setView] = useState<TuiViewState>(loaded.view);
	const skipFirstSave = useRef(true);
	const saveFailed = useRef(false);

	useEffect(() => {
		if (skipFirstSave.current) {
			skipFirstSave.current = false;
			return;
		}
		if (loaded.status === 'corrupt' || saveFailed.current) return;
		if (!saveTuiViewState(file, loaded.document, view)) saveFailed.current = true;
	}, [file, loaded, view]);

	return [view, setView];
}
