import { useRef, useState, useEffect, useCallback } from 'react';
import { useLayerStack } from '../../../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../../../constants/modalPriorities';

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
	const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
	const layerIdRef = useRef<string>();

	const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
	const [totalMatches, setTotalMatches] = useState(0);
	const [regexError, setRegexError] = useState<string | null>(null);
	const matchRangesRef = useRef<Range[]>([]);

	const closeSearch = useCallback(() => {
		setOutputSearchOpen(false);
		setOutputSearchQuery('');
		terminalOutputRef.current?.focus();
	}, [setOutputSearchOpen, setOutputSearchQuery, terminalOutputRef]);

	useEffect(() => {
		if (outputSearchOpen) {
			layerIdRef.current = registerLayer({
				type: 'overlay',
				priority: MODAL_PRIORITIES.SLASH_AUTOCOMPLETE,
				blocksLowerLayers: false,
				capturesFocus: true,
				focusTrap: 'none',
				onEscape: closeSearch,
				allowClickOutside: true,
				ariaLabel: 'Output Search',
			});

			return () => {
				if (layerIdRef.current) {
					unregisterLayer(layerIdRef.current);
				}
			};
		}
	}, [outputSearchOpen, registerLayer, unregisterLayer, closeSearch]);

	useEffect(() => {
		if (outputSearchOpen && layerIdRef.current) {
			updateLayerHandler(layerIdRef.current, closeSearch);
		}
	}, [outputSearchOpen, updateLayerHandler, closeSearch]);

	useEffect(() => {
		if (outputSearchOpen) {
			terminalOutputRef.current?.querySelector('input')?.focus();
		}
	}, [outputSearchOpen, terminalOutputRef]);

	useEffect(() => {
		const query = debouncedSearchQuery.trim();
		const clearHighlights = () => {
			if ('highlights' in CSS) {
				(CSS as unknown as { highlights: Map<string, unknown> }).highlights.delete(
					'terminal-search-all'
				);
				(CSS as unknown as { highlights: Map<string, unknown> }).highlights.delete(
					'terminal-search-current'
				);
			}
		};
		if (!outputSearchOpen || !query) {
			clearHighlights();
			matchRangesRef.current = [];
			setTotalMatches(0);
			setCurrentMatchIndex(0);
			setRegexError(null);
			// A closed/cleared search cancels any queued jump-to-match request so
			// it can't hijack the user's next search in this tab.
			if (pendingJumpMatchIdRef) pendingJumpMatchIdRef.current = null;
			return;
		}

		const container = scrollContainerRef.current;
		if (!container) return;

		let regex: RegExp;
		try {
			if (outputSearchRegex) {
				regex = new RegExp(query, 'gi');
			} else {
				const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				regex = new RegExp(escaped, 'gi');
			}
			setRegexError(null);
		} catch (err) {
			setRegexError(err instanceof Error ? err.message : 'Invalid regex');
			clearHighlights();
			matchRangesRef.current = [];
			setTotalMatches(0);
			return;
		}

		const ranges: Range[] = [];
		const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
		let textNode: Node | null = walker.nextNode();
		while (textNode !== null) {
			const text = textNode.textContent || '';
			if (text) {
				regex.lastIndex = 0;
				let m: RegExpExecArray | null = regex.exec(text);
				while (m !== null) {
					if (m[0].length === 0) {
						regex.lastIndex++;
					} else {
						const range = document.createRange();
						range.setStart(textNode, m.index);
						range.setEnd(textNode, m.index + m[0].length);
						ranges.push(range);
					}
					m = regex.exec(text);
				}
			}
			textNode = walker.nextNode();
		}

		matchRangesRef.current = ranges;
		setTotalMatches(ranges.length);
		setCurrentMatchIndex((prev) => (ranges.length === 0 ? 0 : Math.min(prev, ranges.length - 1)));

		// A cross-tab search jump pre-fills this query, so the "current" match
		// should be the entry the user clicked, not the first hit in the tab.
		const jumpTargetId = pendingJumpMatchIdRef?.current;
		if (jumpTargetId) {
			const idx = ranges.findIndex((r) => {
				const el = (
					r.startContainer.nodeType === Node.ELEMENT_NODE
						? (r.startContainer as Element)
						: r.startContainer.parentElement
				)?.closest('[data-log-id]');
				return el?.getAttribute('data-log-id') === jumpTargetId;
			});
			// Keep the request pending if this pass ran against a stale debounced
			// query (no range inside the target row yet) - the next pass, with the
			// jump's own query, will land it.
			if (idx >= 0) {
				pendingJumpMatchIdRef.current = null;
				setCurrentMatchIndex(idx);
			}
		}

		if (!('highlights' in CSS) || ranges.length === 0) {
			clearHighlights();
			return;
		}
		const Highlight = (window as unknown as { Highlight: new (...r: Range[]) => unknown })
			.Highlight;
		const highlights = (CSS as unknown as { highlights: Map<string, unknown> }).highlights;
		highlights.set('terminal-search-all', new Highlight(...ranges));

		return clearHighlights;
	}, [
		debouncedSearchQuery,
		outputSearchRegex,
		outputSearchOpen,
		filteredLogsLength,
		logStartIndex,
		scrollContainerRef,
		pendingJumpMatchIdRef,
	]);

	useEffect(() => {
		if (!('highlights' in CSS)) return;
		const highlights = (CSS as unknown as { highlights: Map<string, unknown> }).highlights;
		const ranges = matchRangesRef.current;
		if (ranges.length === 0 || currentMatchIndex < 0 || currentMatchIndex >= ranges.length) {
			highlights.delete('terminal-search-current');
			return;
		}
		const current = ranges[currentMatchIndex];
		const Highlight = (window as unknown as { Highlight: new (...r: Range[]) => unknown })
			.Highlight;
		highlights.set('terminal-search-current', new Highlight(current));

		const scrollParent = scrollContainerRef.current;
		const rect = current.getBoundingClientRect();
		if (scrollParent && rect.height > 0) {
			const parentRect = scrollParent.getBoundingClientRect();
			const offset = rect.top - parentRect.top + scrollParent.scrollTop;
			const targetScroll = offset - scrollParent.clientHeight / 2 + rect.height / 2;
			scrollParent.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' });
		}
	}, [currentMatchIndex, totalMatches, scrollContainerRef]);

	const goToNextMatch = useCallback(() => {
		setCurrentMatchIndex((i) => {
			if (totalMatches === 0) return 0;
			return (i + 1) % totalMatches;
		});
	}, [totalMatches]);

	const goToPrevMatch = useCallback(() => {
		setCurrentMatchIndex((i) => {
			if (totalMatches === 0) return 0;
			return (i - 1 + totalMatches) % totalMatches;
		});
	}, [totalMatches]);

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
