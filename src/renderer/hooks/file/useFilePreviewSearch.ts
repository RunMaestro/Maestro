import { useState, useRef, useEffect, useCallback, RefObject } from 'react';
import type {
	SearchHit,
	FilePreviewSearchAdapter,
} from '../../components/FilePreview/search/types';

/** Maximum search query length to prevent expensive regex operations */
const MAX_SEARCH_QUERY_LENGTH = 200;

// Re-export so existing consumers that import the adapter type from this hook
// keep working. New code should import from
// `components/FilePreview/search/types` directly.
export type { SearchHit, FilePreviewSearchAdapter };

export interface UseFilePreviewSearchParams {
	codeContainerRef: RefObject<HTMLDivElement | null>;
	markdownContainerRef: RefObject<HTMLDivElement | null>;
	contentRef: RefObject<HTMLDivElement | null>;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	isMarkdown: boolean;
	/** Readable-text previews (plain prose files like .txt) share the markdown search path. */
	isReadableText?: boolean;
	isImage: boolean;
	isCsv: boolean;
	isJsonl: boolean;
	isJson: boolean;
	isEditableText: boolean;
	markdownEditMode: boolean;
	editContent: string;
	fileContent: string | undefined;
	accentColor: string;
	/** When in 'jq' mode, skip DOM-based highlighting (jq filtering is handled externally) */
	searchMode: 'text' | 'jq';
	/** Length of actually displayed content (may differ from fileContent when truncated) */
	displayedContentLength?: number;
	initialSearchQuery?: string;
	onSearchQueryChange?: (query: string) => void;
	/** Optional pluggable search source for tiers where DOM walking undercounts (Fast tier). */
	searchAdapter?: FilePreviewSearchAdapter;
}

export interface UseFilePreviewSearchReturn {
	searchQuery: string;
	setSearchQuery: (query: string) => void;
	searchOpen: boolean;
	setSearchOpen: (open: boolean) => void;
	currentMatchIndex: number;
	totalMatches: number;
	goToNextMatch: () => void;
	goToPrevMatch: () => void;
	searchInputRef: RefObject<HTMLInputElement>;
	/** Update match count from external source (e.g. CsvTableRenderer) */
	setMatchCount: (count: number) => void;
}

export function useFilePreviewSearch({
	codeContainerRef,
	markdownContainerRef,
	contentRef,
	textareaRef,
	isMarkdown,
	isReadableText = false,
	isImage,
	isCsv,
	isJsonl,
	isJson,
	isEditableText,
	markdownEditMode,
	editContent,
	fileContent,
	accentColor,
	searchMode,
	displayedContentLength,
	initialSearchQuery,
	onSearchQueryChange,
	searchAdapter,
}: UseFilePreviewSearchParams): UseFilePreviewSearchReturn {
	// Search state - use initialSearchQuery if provided, and notify parent of changes
	const [internalSearchQuery, setInternalSearchQuery] = useState(
		(initialSearchQuery ?? '').slice(0, MAX_SEARCH_QUERY_LENGTH)
	);
	// Wrapper to update state and notify parent
	const setSearchQuery = useCallback(
		(query: string) => {
			const capped =
				query.length > MAX_SEARCH_QUERY_LENGTH ? query.slice(0, MAX_SEARCH_QUERY_LENGTH) : query;
			setInternalSearchQuery(capped);
			onSearchQueryChange?.(capped);
		},
		[onSearchQueryChange]
	);
	// Expose the current search query value
	const searchQuery = internalSearchQuery;
	// If initialSearchQuery is provided and non-empty, auto-open search
	const [searchOpen, setSearchOpen] = useState(Boolean(initialSearchQuery));
	const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
	const [totalMatches, setTotalMatches] = useState(0);

	const matchElementsRef = useRef<HTMLElement[]>([]);
	const searchInputRef = useRef<HTMLInputElement>(null);
	const prevSearchQueryRef = useRef<string>('');
	const prevMatchIndexRef = useRef<number>(0);

	// Keep search input focused when search is open
	useEffect(() => {
		if (searchOpen && searchInputRef.current) {
			searchInputRef.current.focus();
		}
	}, [searchOpen, searchQuery]);

	// In jq mode, text-based highlighting is disabled — jq filtering is handled by JsonlViewer
	const isJqMode = searchMode === 'jq';

	// Highlight search matches in syntax-highlighted code
	useEffect(() => {
		if (
			!searchQuery.trim() ||
			!codeContainerRef.current ||
			isMarkdown ||
			isReadableText ||
			isImage ||
			isCsv ||
			isJsonl ||
			(isJson && isJqMode) ||
			// Fast tier provides its own adapter — defer counting + scroll to
			// the markdown/readable-text CSS-Highlight effect below, which has
			// been widened to handle code Fast tier when an adapter is present.
			searchAdapter
		) {
			setTotalMatches(0);
			setCurrentMatchIndex(-1);
			matchElementsRef.current = [];
			return;
		}

		const container = codeContainerRef.current;
		const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
		const textNodes: Text[] = [];

		// Collect all text nodes
		let node;
		while ((node = walker.nextNode())) {
			textNodes.push(node as Text);
		}

		// Escape regex special characters
		const escapedQuery = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const regex = new RegExp(escapedQuery, 'gi');
		const matchElements: HTMLElement[] = [];

		// Highlight matches using safe DOM methods
		textNodes.forEach((textNode) => {
			const text = textNode.textContent || '';
			const matches = text.match(regex);

			if (matches) {
				const fragment = document.createDocumentFragment();
				let lastIndex = 0;

				text.replace(regex, (match, offset) => {
					// Add text before match
					if (offset > lastIndex) {
						fragment.appendChild(document.createTextNode(text.substring(lastIndex, offset)));
					}

					// Add highlighted match
					const mark = document.createElement('mark');
					mark.style.backgroundColor = '#ffd700';
					mark.style.color = '#000';
					mark.style.padding = '0 2px';
					mark.style.borderRadius = '2px';
					mark.className = 'search-match';
					mark.textContent = match;
					fragment.appendChild(mark);
					matchElements.push(mark);

					lastIndex = offset + match.length;
					return match;
				});

				// Add remaining text
				if (lastIndex < text.length) {
					fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
				}

				textNode.parentNode?.replaceChild(fragment, textNode);
			}
		});

		// Store match elements and update count
		matchElementsRef.current = matchElements;
		setTotalMatches(matchElements.length);
		setCurrentMatchIndex(matchElements.length > 0 ? 0 : -1);

		// Highlight first match with different color and scroll to it
		if (matchElements.length > 0) {
			matchElements[0].style.backgroundColor = accentColor;
			matchElements[0].style.color = '#fff';
			matchElements[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
		}

		// Cleanup function to remove highlights
		return () => {
			container.querySelectorAll('mark.search-match').forEach((mark) => {
				const parent = mark.parentNode;
				if (parent) {
					parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
					parent.normalize();
				}
			});
			matchElementsRef.current = [];
		};
	}, [
		searchQuery,
		fileContent,
		displayedContentLength,
		isMarkdown,
		isReadableText,
		isImage,
		isCsv,
		isJsonl,
		isJson,
		isJqMode,
		accentColor,
		// The early-return guard reads `searchAdapter` to defer to the Fast/Giant
		// tier's own search; include it in deps so flipping the tier chip
		// re-runs the effect with the fresh adapter state.
		searchAdapter,
	]);

	// Search matches in markdown preview mode - use CSS Custom Highlight API.
	// Also runs for Fast tier non-markdown content when a search adapter is
	// provided (the adapter supplies the authoritative match count; the
	// effect still applies CSS Highlights to currently-mounted DOM text).
	useEffect(() => {
		const adapterActive = Boolean(searchAdapter);
		const isTextLike = isMarkdown || isReadableText || adapterActive;
		if (!isTextLike || markdownEditMode || !searchQuery.trim() || !markdownContainerRef.current) {
			if (isTextLike && !markdownEditMode) {
				setTotalMatches(0);
				setCurrentMatchIndex(-1);
				matchElementsRef.current = [];
				// Clear any existing highlights
				if ('highlights' in CSS) {
					(CSS as any).highlights.delete('search-results');
					(CSS as any).highlights.delete('search-current');
				}
			}
			return;
		}

		const container = markdownContainerRef.current;
		const escapedQuery = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const searchRegex = new RegExp(escapedQuery, 'gi');

		// Check if CSS Custom Highlight API is available
		if ('highlights' in CSS) {
			const allRanges: Range[] = [];
			const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);

			// Find all text nodes and create ranges for matches
			let textNode;
			while ((textNode = walker.nextNode())) {
				const text = textNode.textContent || '';
				let match;
				const localRegex = new RegExp(escapedQuery, 'gi');
				while ((match = localRegex.exec(text)) !== null) {
					const range = document.createRange();
					range.setStart(textNode, match.index);
					range.setEnd(textNode, match.index + match[0].length);
					allRanges.push(range);
				}
			}

			// When a search adapter is supplied (Fast tier), its `findHits` is
			// authoritative — the DOM walker only sees the small slice of
			// currently-mounted blocks. We still apply CSS Highlights to the
			// visible ranges so the user can see matches in view, but the
			// match COUNT and scroll target come from the adapter.
			const adapterHits = searchAdapter ? searchAdapter.findHits(searchQuery) : null;
			const totalCount = adapterHits ? adapterHits.length : allRanges.length;
			setTotalMatches(totalCount);

			// Create highlights
			if (totalCount > 0) {
				const targetIndex = currentMatchIndex < 0 ? 0 : Math.min(currentMatchIndex, totalCount - 1);
				if (targetIndex !== currentMatchIndex) {
					setCurrentMatchIndex(targetIndex);
				}

				// Highlight whatever DOM-mounted matches exist. Even with the
				// adapter, only on-screen text nodes can carry highlights — that's
				// fine, scrolling brings new blocks into view which then receive
				// highlight via the next effect run.
				if (allRanges.length > 0) {
					const allHighlight = new (window as any).Highlight(...allRanges);
					(CSS as any).highlights.set('search-results', allHighlight);
					const visibleIndex = Math.min(targetIndex, allRanges.length - 1);
					const currentHighlight = new (window as any).Highlight(allRanges[visibleIndex]);
					(CSS as any).highlights.set('search-current', currentHighlight);
				} else {
					(CSS as any).highlights.delete('search-results');
					(CSS as any).highlights.delete('search-current');
				}

				// Scroll: prefer the adapter's scrollToMatch (Fast tier — moves
				// the virtualizer); fall back to native scrollIntoView via Range.
				if (adapterHits && adapterHits[targetIndex]) {
					searchAdapter!.scrollToMatch(adapterHits[targetIndex]);
				} else if (allRanges.length > 0) {
					const currentRange = allRanges[Math.min(targetIndex, allRanges.length - 1)];
					const rect = currentRange.getBoundingClientRect();
					const scrollParent = contentRef.current;
					if (scrollParent && rect) {
						const scrollContainerRect = scrollParent.getBoundingClientRect();
						const matchOffsetInScrollContainer =
							rect.top - scrollContainerRect.top + scrollParent.scrollTop;
						const scrollTop =
							matchOffsetInScrollContainer - scrollParent.clientHeight / 2 + rect.height / 2;
						scrollParent.scrollTo({ top: Math.max(0, scrollTop), behavior: 'smooth' });
					}
				}
			} else {
				setCurrentMatchIndex(-1);
				(CSS as any).highlights.delete('search-results');
				(CSS as any).highlights.delete('search-current');
			}

			// Cleanup function
			return () => {
				(CSS as any).highlights.delete('search-results');
				(CSS as any).highlights.delete('search-current');
			};
		} else {
			// Fallback: count matches and scroll to location (no highlighting)
			const matches = fileContent?.match(searchRegex);
			const count = matches ? matches.length : 0;
			setTotalMatches(count);
			if (count > 0 && currentMatchIndex < 0) {
				setCurrentMatchIndex(0);
			} else if (count === 0 && currentMatchIndex !== -1) {
				setCurrentMatchIndex(-1);
			}

			if (count > 0) {
				const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
				let matchCount = 0;
				const targetIndex = Math.max(0, Math.min(currentMatchIndex, count - 1));

				let textNode;
				while ((textNode = walker.nextNode())) {
					const text = textNode.textContent || '';
					const nodeMatches = text.match(searchRegex);
					if (nodeMatches) {
						for (const _ of nodeMatches) {
							if (matchCount === targetIndex) {
								const parentElement = (textNode as Text).parentElement;
								if (parentElement) {
									parentElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
								}
								return;
							}
							matchCount++;
						}
					}
				}
			}
		}

		matchElementsRef.current = [];
	}, [
		searchQuery,
		fileContent,
		isMarkdown,
		isReadableText,
		markdownEditMode,
		currentMatchIndex,
		accentColor,
		searchAdapter,
	]);

	// Handle search in edit mode - count matches, paint highlights, and update state
	// Note: We separate counting from selection to avoid stealing focus while typing
	useEffect(() => {
		const clearEditHighlights = () => {
			if ('highlights' in CSS) {
				(CSS as any).highlights.delete('search-results');
				(CSS as any).highlights.delete('search-current');
			}
		};

		if (!isEditableText || !markdownEditMode || !searchQuery.trim() || !textareaRef.current) {
			if (isEditableText && markdownEditMode) {
				setTotalMatches(0);
				setCurrentMatchIndex(-1);
				clearEditHighlights();
			}
			return;
		}

		const content = editContent;
		const escapedQuery = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const regex = new RegExp(escapedQuery, 'gi');

		// Find all matches and their positions
		const matches: { start: number; end: number }[] = [];
		let matchResult;
		while ((matchResult = regex.exec(content)) !== null) {
			matches.push({ start: matchResult.index, end: matchResult.index + matchResult[0].length });
		}

		setTotalMatches(matches.length);
		if (matches.length === 0) {
			setCurrentMatchIndex(-1);
			clearEditHighlights();
			return;
		}

		// Initialize from -1 when new matches appear, or clamp if index exceeds count
		const validIndex = currentMatchIndex < 0 ? 0 : Math.min(currentMatchIndex, matches.length - 1);
		if (validIndex !== currentMatchIndex) {
			setCurrentMatchIndex(validIndex);
			return;
		}

		// Paint highlights on the syntax-highlighted overlay. The textarea has
		// color:transparent so its native selection is invisible — instead we
		// apply the CSS Custom Highlight API on the overlay's text nodes, which
		// show through the transparent textarea sitting on top.
		if ('highlights' in CSS && textareaRef.current.parentElement) {
			const container = textareaRef.current.parentElement;
			const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
				acceptNode: (node) =>
					(node as Text).parentElement?.tagName === 'TEXTAREA'
						? NodeFilter.FILTER_REJECT
						: NodeFilter.FILTER_ACCEPT,
			});
			const textNodes: { node: Text; start: number; end: number }[] = [];
			let pos = 0;
			let textNode: Node | null;
			while ((textNode = walker.nextNode())) {
				const text = (textNode as Text).textContent || '';
				textNodes.push({ node: textNode as Text, start: pos, end: pos + text.length });
				pos += text.length;
			}

			const findContainingNode = (offset: number, isRangeStart: boolean) => {
				for (const tn of textNodes) {
					if (isRangeStart) {
						if (offset >= tn.start && offset < tn.end) return tn;
					} else if (offset > tn.start && offset <= tn.end) {
						return tn;
					}
				}
				if (textNodes.length > 0 && offset === textNodes[textNodes.length - 1].end) {
					return textNodes[textNodes.length - 1];
				}
				return null;
			};

			const allRanges: Range[] = [];
			for (const m of matches) {
				const startTn = findContainingNode(m.start, true);
				const endTn = findContainingNode(m.end, false);
				if (!startTn || !endTn) continue;
				try {
					const range = document.createRange();
					range.setStart(startTn.node, m.start - startTn.start);
					range.setEnd(endTn.node, m.end - endTn.start);
					allRanges.push(range);
				} catch {
					// Range creation can fail if offsets fall outside the text node
					// (e.g. overlay text out of sync mid-render). Skip this match.
				}
			}

			if (allRanges.length > 0) {
				(CSS as any).highlights.set('search-results', new (window as any).Highlight(...allRanges));
				const currentRange = allRanges[validIndex] ?? allRanges[0];
				(CSS as any).highlights.set('search-current', new (window as any).Highlight(currentRange));
			} else {
				clearEditHighlights();
			}
		}

		// Only scroll and select when navigating between matches (Enter/Shift+Enter)
		// or when search query is complete (user stopped typing)
		// We detect navigation by checking if currentMatchIndex changed without searchQuery changing
		const isNavigating =
			prevSearchQueryRef.current === searchQuery && prevMatchIndexRef.current !== currentMatchIndex;
		prevSearchQueryRef.current = searchQuery;
		prevMatchIndexRef.current = currentMatchIndex;

		// Select the current match in the textarea only when navigating
		if (isNavigating) {
			const currentMatch = matches[validIndex];
			if (currentMatch) {
				const textarea = textareaRef.current;
				// Briefly focus the textarea to set selection, then return focus to the
				// search input so the user can keep typing/navigating without the cursor
				// jumping into the editor (matches browser Cmd+F behavior).
				textarea.focus();
				textarea.setSelectionRange(currentMatch.start, currentMatch.end);

				// Scroll to make the selection visible
				// Calculate approximate line number and scroll to it
				const textBeforeMatch = content.substring(0, currentMatch.start);
				const lineNumber = textBeforeMatch.split('\n').length;
				const lineHeight = parseInt(getComputedStyle(textarea).lineHeight) || 24;
				const targetScroll = (lineNumber - 5) * lineHeight; // Leave some lines above
				textarea.scrollTop = Math.max(0, targetScroll);

				searchInputRef.current?.focus();
			}
		}

		return () => {
			clearEditHighlights();
		};
	}, [searchQuery, currentMatchIndex, isEditableText, markdownEditMode, editContent]);

	// Navigate to next search match
	const goToNextMatch = useCallback(() => {
		if (totalMatches === 0) return;

		// Move to next match (wrap around)
		const nextIndex = (currentMatchIndex + 1) % totalMatches;
		setCurrentMatchIndex(nextIndex);

		// For code files, handle DOM-based highlighting
		const matches = matchElementsRef.current;
		if (matches.length > 0) {
			// Reset previous highlight
			if (matches[currentMatchIndex]) {
				matches[currentMatchIndex].style.backgroundColor = '#ffd700';
				matches[currentMatchIndex].style.color = '#000';
			}
			// Highlight new current match and scroll to it
			if (matches[nextIndex]) {
				matches[nextIndex].style.backgroundColor = accentColor;
				matches[nextIndex].style.color = '#fff';
				matches[nextIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
			}
		}
		// For markdown edit mode, the effect will handle selecting text
	}, [totalMatches, currentMatchIndex, accentColor]);

	// Navigate to previous search match
	const goToPrevMatch = useCallback(() => {
		if (totalMatches === 0) return;

		// Move to previous match (wrap around); treat -1 as "before first" → go to last
		const base = currentMatchIndex < 0 ? totalMatches : currentMatchIndex;
		const prevIndex = (base - 1 + totalMatches) % totalMatches;
		setCurrentMatchIndex(prevIndex);

		// For code files, handle DOM-based highlighting
		const matches = matchElementsRef.current;
		if (matches.length > 0) {
			// Reset previous highlight
			if (matches[currentMatchIndex]) {
				matches[currentMatchIndex].style.backgroundColor = '#ffd700';
				matches[currentMatchIndex].style.color = '#000';
			}
			// Highlight new current match and scroll to it
			if (matches[prevIndex]) {
				matches[prevIndex].style.backgroundColor = accentColor;
				matches[prevIndex].style.color = '#fff';
				matches[prevIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
			}
		}
		// For markdown edit mode, the effect will handle selecting text
	}, [totalMatches, currentMatchIndex, accentColor]);

	const setMatchCount = useCallback((count: number) => {
		setTotalMatches(count);
		setCurrentMatchIndex(count > 0 ? 0 : -1);
	}, []);

	return {
		searchQuery,
		setSearchQuery,
		searchOpen,
		setSearchOpen,
		currentMatchIndex,
		totalMatches,
		goToNextMatch,
		goToPrevMatch,
		searchInputRef,
		setMatchCount,
	};
}
