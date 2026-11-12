import { useCallback } from 'react';
import { useOutputSearchLayer } from '../../../hooks/ui/useOutputSearchLayer';
import { useOutputSearchMatching } from '../../../hooks/ui/useOutputSearchMatching';

interface UseTerminalOutputSearchOptions {
	scrollContainerRef: React.RefObject<HTMLDivElement>;
	terminalOutputRef: React.RefObject<HTMLDivElement>;
	outputSearchOpen: boolean;
	outputSearchRegex: boolean;
	debouncedSearchQuery: string;
	filteredLogsLength: number;
	/**
	 * Start offset of the progressive render window (see useProgressiveRenderWindow).
	 * Idle backfill adds entries to the DOM after the initial pass without changing
	 * filteredLogsLength, so this must be a dependency too - otherwise matches in
	 * freshly hydrated history are never highlighted or counted.
	 */
	logStartIndex: number;
	setOutputSearchOpen: (open: boolean) => void;
	setOutputSearchQuery: (query: string) => void;
	/**
	 * Rendered log id a cross-tab search jump landed on, as a mutable ref the
	 * transcript sets before this hook's pass runs. When set, the "current" match
	 * becomes the hit inside that row rather than the first hit in the tab, so
	 * next/prev continues from where the user clicked.
	 */
	pendingJumpMatchIdRef?: React.MutableRefObject<string | null>;
}

export function useTerminalOutputSearch({
	scrollContainerRef,
	terminalOutputRef,
	outputSearchOpen,
	outputSearchRegex,
	debouncedSearchQuery,
	filteredLogsLength,
	logStartIndex,
	setOutputSearchOpen,
	setOutputSearchQuery,
	pendingJumpMatchIdRef,
}: UseTerminalOutputSearchOptions) {
	const closeSearch = useCallback(() => {
		setOutputSearchOpen(false);
		setOutputSearchQuery('');
		terminalOutputRef.current?.focus();
	}, [setOutputSearchOpen, setOutputSearchQuery, terminalOutputRef]);

	useOutputSearchLayer({
		open: outputSearchOpen,
		onEscape: closeSearch,
		ariaLabel: 'Output Search',
	});

	const { currentMatchIndex, totalMatches, regexError, goToNextMatch, goToPrevMatch } =
		useOutputSearchMatching({
			containerRef: scrollContainerRef,
			outputSearchOpen,
			outputSearchRegex,
			debouncedSearchQuery,
			contentRevision: `${filteredLogsLength}:${logStartIndex}`,
			pendingJumpMatchIdRef,
			jumpIdAttribute: 'data-log-id',
		});

	return {
		currentMatchIndex,
		totalMatches,
		regexError,
		goToNextMatch,
		goToPrevMatch,
		// Exposed so the find bar's ESC pill runs the exact same dismissal the
		// Escape layer does - a pointer-only user gets identical behavior.
		closeSearch,
	};
}
