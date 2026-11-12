/**
 * DOM text matching + CSS Custom Highlight for the Find bar.
 * Shared by AI TerminalOutput and group chat so count/nav/highlight stay in sync.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const HIGHLIGHT_ALL = 'terminal-search-all';
const HIGHLIGHT_CURRENT = 'terminal-search-current';

export interface UseOutputSearchMatchingOptions {
	containerRef: React.RefObject<HTMLElement | null>;
	outputSearchOpen: boolean;
	outputSearchRegex: boolean;
	debouncedSearchQuery: string;
	/**
	 * Any value that changes when the searchable DOM may have changed
	 * (log count, message count, progressive window start, etc.).
	 */
	contentRevision: unknown;
	/**
	 * Rendered entry id a cross-tab jump landed on. When set, the "current"
	 * match becomes the hit inside that row. Optional - group chat omits this.
	 */
	pendingJumpMatchIdRef?: React.MutableRefObject<string | null>;
	/** Attribute used to locate a jumped-to row (AI: data-log-id). */
	jumpIdAttribute?: string;
}

export function useOutputSearchMatching({
	containerRef,
	outputSearchOpen,
	outputSearchRegex,
	debouncedSearchQuery,
	contentRevision,
	pendingJumpMatchIdRef,
	jumpIdAttribute = 'data-log-id',
}: UseOutputSearchMatchingOptions) {
	const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
	const [totalMatches, setTotalMatches] = useState(0);
	const [regexError, setRegexError] = useState<string | null>(null);
	const matchRangesRef = useRef<Range[]>([]);

	useEffect(() => {
		const query = debouncedSearchQuery.trim();
		const clearHighlights = () => {
			if ('highlights' in CSS) {
				(CSS as unknown as { highlights: Map<string, unknown> }).highlights.delete(HIGHLIGHT_ALL);
				(CSS as unknown as { highlights: Map<string, unknown> }).highlights.delete(
					HIGHLIGHT_CURRENT
				);
			}
		};
		if (!outputSearchOpen || !query) {
			clearHighlights();
			matchRangesRef.current = [];
			setTotalMatches(0);
			setCurrentMatchIndex(0);
			setRegexError(null);
			if (pendingJumpMatchIdRef) pendingJumpMatchIdRef.current = null;
			return;
		}

		const container = containerRef.current;
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

		const jumpTargetId = pendingJumpMatchIdRef?.current;
		if (jumpTargetId) {
			const idx = ranges.findIndex((r) => {
				const el = (
					r.startContainer.nodeType === Node.ELEMENT_NODE
						? (r.startContainer as Element)
						: r.startContainer.parentElement
				)?.closest(`[${jumpIdAttribute}]`);
				return el?.getAttribute(jumpIdAttribute) === jumpTargetId;
			});
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
		highlights.set(HIGHLIGHT_ALL, new Highlight(...ranges));

		return clearHighlights;
	}, [
		debouncedSearchQuery,
		outputSearchRegex,
		outputSearchOpen,
		contentRevision,
		containerRef,
		pendingJumpMatchIdRef,
		jumpIdAttribute,
	]);

	useEffect(() => {
		if (!('highlights' in CSS)) return;
		const highlights = (CSS as unknown as { highlights: Map<string, unknown> }).highlights;
		const ranges = matchRangesRef.current;
		if (ranges.length === 0 || currentMatchIndex < 0 || currentMatchIndex >= ranges.length) {
			highlights.delete(HIGHLIGHT_CURRENT);
			return;
		}
		const current = ranges[currentMatchIndex];
		const Highlight = (window as unknown as { Highlight: new (...r: Range[]) => unknown })
			.Highlight;
		highlights.set(HIGHLIGHT_CURRENT, new Highlight(current));

		const scrollParent = containerRef.current;
		const rect = current.getBoundingClientRect();
		if (scrollParent && rect.height > 0) {
			const parentRect = scrollParent.getBoundingClientRect();
			const offset = rect.top - parentRect.top + scrollParent.scrollTop;
			const targetScroll = offset - scrollParent.clientHeight / 2 + rect.height / 2;
			scrollParent.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' });
		}
	}, [currentMatchIndex, totalMatches, containerRef]);

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
	};
}
