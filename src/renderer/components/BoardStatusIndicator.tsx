import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { LayoutGrid } from 'lucide-react';
import type { Theme } from '../types';
import type { Board } from '../../shared/board/types';
import { countActiveCards } from '../../shared/board/graph';
import { useSettingsStore } from '../stores/settingsStore';
import { getModalActions } from '../stores/modalStore';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';

interface BoardStatusIndicatorProps {
	/** Project root whose boards to count. Empty => nothing to show. */
	projectRoot: string | undefined;
	theme: Theme;
}

/**
 * Board activity pill in the Main Window header, beside the git status widget.
 *
 * Shows how many cards are `running` / `ready` across the active project's
 * boards, and opens the Board modal on click. Hidden entirely when the Board
 * Encore feature (or its Maestro Cue dependency) is off, when the project has
 * no boards, or when nothing is in flight - the header stays quiet until the
 * Board actually has something to say.
 *
 * Counts come from the same `board:changed` push the Board modal listens to
 * (emitted after every `board.yaml` write), so there is no timer here and no
 * second copy of board state: the pill re-reads and re-counts on each write.
 */
export const BoardStatusIndicator = memo(function BoardStatusIndicator({
	projectRoot,
	theme,
}: BoardStatusIndicatorProps) {
	const boardEnabled = useSettingsStore((s) => s.encoreFeatures.board === true);
	const cueEnabled = useSettingsStore((s) => s.encoreFeatures.maestroCue === true);
	const enabled = boardEnabled && cueEnabled;

	const [counts, setCounts] = useState({ running: 0, ready: 0 });

	// Monotonic request generation: a board.list() that resolves after the
	// active project changed must not overwrite the new project's counts.
	const requestGen = useRef(0);
	// One Sentry report per project: the pill refreshes on every board:changed
	// push, and re-reporting the same corrupt-file error on each write is noise.
	const reportedListFailure = useRef(false);
	useEffect(() => {
		reportedListFailure.current = false;
	}, [projectRoot]);

	const refresh = useCallback(async () => {
		const gen = ++requestGen.current;
		if (!enabled || !projectRoot) {
			setCounts({ running: 0, ready: 0 });
			return;
		}
		try {
			const boards: Board[] = await window.maestro.board.list(projectRoot);
			if (gen !== requestGen.current) return;
			setCounts(countActiveCards(boards));
		} catch (err) {
			if (gen !== requestGen.current) return;
			// A corrupt board.yaml already surfaces as a toast from the Board modal;
			// a header pill must not raise a second one on every write. It is still
			// an unexpected failure, so report it (once per project) instead of
			// silently converting it to zero counts.
			if (!reportedListFailure.current) {
				reportedListFailure.current = true;
				captureException(err, {
					tags: { operation: 'board:list', surface: 'board-status-indicator' },
				});
			}
			logger.warn(`Board indicator: failed to count cards - ${String(err)}`);
			setCounts({ running: 0, ready: 0 });
		}
	}, [enabled, projectRoot]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		if (!enabled || !projectRoot) return;
		return window.maestro.board.onBoardChanged?.((payload) => {
			if (payload?.projectRoot !== projectRoot) return;
			void refresh();
		});
	}, [enabled, projectRoot, refresh]);

	const total = counts.running + counts.ready;
	if (!enabled || total === 0) return null;

	const label = `${counts.running} running, ${counts.ready} ready`;

	return (
		<button
			type="button"
			data-testid="board-status-indicator"
			onClick={() => getModalActions().setBoardModalOpen(true)}
			title={`Board: ${label}. Click to open.`}
			aria-label={`Board: ${label}`}
			className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] transition-colors hover:bg-white/10"
			style={{ color: theme.colors.textDim }}
		>
			<LayoutGrid className="w-3 h-3" />
			<span className={counts.running > 0 ? 'animate-pulse' : undefined}>
				{counts.running}/{counts.ready}
			</span>
		</button>
	);
});
