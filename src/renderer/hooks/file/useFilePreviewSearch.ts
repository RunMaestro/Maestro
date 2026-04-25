import { useState, useRef, useEffect, useCallback, RefObject } from 'react';

/** Maximum search query length to prevent expensive regex operations */
const MAX_SEARCH_QUERY_LENGTH = 200;

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
			(isJson && isJqMode)
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
	]);

	// Search matches in markdown preview mode - use CSS Custom Highlight API
	useEffect(() => {
		if (
			(!isMarkdown && !isReadableText) ||
			markdownEditMode ||
			!searchQuery.trim() ||
			!markdownContainerRef.current
		) {
			if ((isMarkdown || isReadableText) && !markdownEditMode) {
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

			// Update match count and sync current index
			setTotalMatches(allRanges.length);

			// Create highlights
			if (allRanges.length > 0) {
				const targetIndex =
					currentMatchIndex < 0 ? 0 : Math.min(currentMatchIndex, allRanges.length - 1);
				if (targetIndex !== currentMatchIndex) {
					setCurrentMatchIndex(targetIndex);
				}

				// Create highlight for all matches (yellow)
				const allHighlight = new (window as any).Highlight(...allRanges);
				(CSS as any).highlights.set('search-results', allHighlight);

				// Create highlight for current match (accent color)
				const currentHighlight = new (window as any).Highlight(allRanges[targetIndex]);
				(CSS as any).highlights.set('search-current', currentHighlight);

				// Scroll to current match
				const currentRange = allRanges[targetIndex];
				const rect = currentRange.getBoundingClientRect();
				const scrollParent = contentRef.current;

				if (scrollParent && rect) {
					// Calculate position of the match relative to the scroll container's top
					// rect.top is viewport-relative, so we need to account for current scroll
					// and the scroll container's viewport position
					const scrollContainerRect = scrollParent.getBoundingClientRect();
					const matchOffsetInScrollContainer =
						rect.top - scrollContainerRect.top + scrollParent.scrollTop;
					// Calculate scroll position to center the match vertically
					const scrollTop =
						matchOffsetInScrollContainer - scrollParent.clientHeight / 2 + rect.height / 2;
					scrollParent.scrollTo({ top: Math.max(0, scrollTop), behavior: 'smooth' });
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
	]);

	// Handle search in edit mode - count matches and update state
	// Note: We separate counting from selection to avoid stealing focus while typing
	useEffect(() => {
		if (!isEditableText || !markdownEditMode || !searchQuery.trim() || !textareaRef.current) {
			if (isEditableText && markdownEditMode) {
				setTotalMatches(0);
				setCurrentMatchIndex(-1);
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
			return;
		}

		// Initialize from -1 when new matches appear, or clamp if index exceeds count
		const validIndex = currentMatchIndex < 0 ? 0 : Math.min(currentMatchIndex, matches.length - 1);
		if (validIndex !== currentMatchIndex) {
			setCurrentMatchIndex(validIndex);
			return;
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
				textarea.focus();
				textarea.setSelectionRange(currentMatch.start, currentMatch.end);

				// Scroll to make the selection visible
				// Calculate approximate line number and scroll to it
				const textBeforeMatch = content.substring(0, currentMatch.start);
				const lineNumber = textBeforeMatch.split('\n').length;
				const lineHeight = parseInt(getComputedStyle(textarea).lineHeight) || 24;
				const targetScroll = (lineNumber - 5) * lineHeight; // Leave some lines above
				textarea.scrollTop = Math.max(0, targetScroll);
			}
		}
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
