import { useState, useCallback, useRef, useEffect, type RefObject } from 'react';

export interface UseAutoRunSearchParams {
	localContent: string;
	mode: 'edit' | 'preview';
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	previewRef?: RefObject<HTMLDivElement | null>;
}

export interface UseAutoRunSearchReturn {
	searchOpen: boolean;
	searchQuery: string;
	setSearchQuery: (q: string) => void;
	currentMatchIndex: number;
	totalMatches: number;
	openSearch: () => void;
	closeSearch: () => void;
	goToNextMatchWithFlag: () => void;
	goToPrevMatchWithFlag: () => void;
	handleMatchRendered: (index: number, element: HTMLElement) => void;
}

export function useAutoRunSearch({
	localContent,
	mode,
	textareaRef,
	previewRef,
}: UseAutoRunSearchParams): UseAutoRunSearchReturn {
	// Search state
	const [searchOpen, setSearchOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState('');
	const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
	const [totalMatches, setTotalMatches] = useState(0);
	// Track if the user manually navigated to a match (prev/next buttons or Enter key)
	// vs just typing in the search box
	const userNavigatedToMatchRef = useRef(false);

	// Open search function
	const openSearch = useCallback(() => {
		setSearchOpen(true);
	}, []);

	// Close search function
	const closeSearch = useCallback(() => {
		setSearchOpen(false);
		setSearchQuery('');
		setCurrentMatchIndex(0);
		setTotalMatches(0);
		userNavigatedToMatchRef.current = false;
		// Refocus appropriate element
		if (mode === 'edit' && textareaRef.current) {
			textareaRef.current.focus();
		} else if (mode === 'preview' && previewRef?.current) {
			previewRef.current.focus();
		}
	}, [mode, textareaRef, previewRef]);

	// Debounced search match counting - prevent expensive regex on every keystroke
	const searchCountTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	useEffect(() => {
		// Clear any pending count
		if (searchCountTimeoutRef.current) {
			clearTimeout(searchCountTimeoutRef.current);
		}

		if (searchQuery.trim()) {
			// Debounce the match counting for large documents
			searchCountTimeoutRef.current = setTimeout(() => {
				const escapedQuery = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				const regex = new RegExp(escapedQuery, 'gi');
				const matches = localContent.match(regex);
				const count = matches ? matches.length : 0;
				setTotalMatches(count);
				// Use functional updater to avoid stale currentMatchIndex from closure
				setCurrentMatchIndex((prev) => (count > 0 && prev >= count ? 0 : prev));
			}, 150); // Short delay for search responsiveness
		} else {
			setTotalMatches(0);
			setCurrentMatchIndex(0);
		}

		return () => {
			if (searchCountTimeoutRef.current) {
				clearTimeout(searchCountTimeoutRef.current);
			}
		};
	}, [searchQuery, localContent]);

	// Navigate to next search match
	const goToNextMatch = useCallback(() => {
		if (totalMatches === 0) return;
		const nextIndex = (currentMatchIndex + 1) % totalMatches;
		setCurrentMatchIndex(nextIndex);
	}, [currentMatchIndex, totalMatches]);

	// Navigate to previous search match
	const goToPrevMatch = useCallback(() => {
		if (totalMatches === 0) return;
		const prevIndex = (currentMatchIndex - 1 + totalMatches) % totalMatches;
		setCurrentMatchIndex(prevIndex);
	}, [currentMatchIndex, totalMatches]);

	// Wrapped navigation handlers that set the flag only when navigation will proceed
	const goToNextMatchWithFlag = useCallback(() => {
		if (totalMatches === 0) return;
		userNavigatedToMatchRef.current = true;
		goToNextMatch();
	}, [goToNextMatch, totalMatches]);

	const goToPrevMatchWithFlag = useCallback(() => {
		if (totalMatches === 0) return;
		userNavigatedToMatchRef.current = true;
		goToPrevMatch();
	}, [goToPrevMatch, totalMatches]);

	// Scroll to current match in edit mode
	// Only run when user explicitly navigated to a match (not on every keystroke)
	useEffect(() => {
		// Only scroll when user explicitly navigated (prev/next buttons or Enter key)
		if (!userNavigatedToMatchRef.current) return;
		if (!searchOpen || !searchQuery.trim() || totalMatches === 0) return;
		if (mode !== 'edit' || !textareaRef.current) return;

		// For edit mode, find the match position in the text and scroll
		const escapedQuery = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const regex = new RegExp(escapedQuery, 'gi');
		let matchPosition = -1;

		// Find the nth match position using matchAll
		const matches = Array.from(localContent.matchAll(regex));
		if (currentMatchIndex < matches.length) {
			matchPosition = matches[currentMatchIndex].index!;
		}

		if (matchPosition >= 0 && textareaRef.current) {
			const textarea = textareaRef.current;

			// Create a temporary element to measure text height up to the match
			const measureDiv = document.createElement('div');
			const computedStyle = window.getComputedStyle(textarea);
			measureDiv.style.font = computedStyle.font;
			measureDiv.style.fontSize = computedStyle.fontSize;
			measureDiv.style.lineHeight = computedStyle.lineHeight;
			measureDiv.style.padding = computedStyle.padding;
			measureDiv.style.border = computedStyle.border;
			measureDiv.style.boxSizing = computedStyle.boxSizing;
			measureDiv.style.height = 'auto';
			measureDiv.style.position = 'absolute';
			measureDiv.style.visibility = 'hidden';
			measureDiv.style.whiteSpace = 'pre-wrap';
			measureDiv.style.wordWrap = 'break-word';
			measureDiv.style.width = `${textarea.clientWidth}px`;
			measureDiv.style.overflow = 'hidden';

			// Set content up to the match position to measure vertical offset
			const textBeforeMatch = localContent.substring(0, matchPosition);
			measureDiv.textContent = textBeforeMatch;
			document.body.appendChild(measureDiv);

			// The height of the measureDiv is the vertical position of the match
			const matchVerticalPos = measureDiv.scrollHeight;
			document.body.removeChild(measureDiv);

			// Scroll to center the match in the viewport
			const scrollTarget = Math.max(0, matchVerticalPos - textarea.clientHeight / 2);
			textarea.scrollTop = scrollTarget;

			// Focus textarea and select the match text
			textarea.focus();
			textarea.setSelectionRange(matchPosition, matchPosition + searchQuery.length);
			userNavigatedToMatchRef.current = false;
		}
	}, [currentMatchIndex, searchOpen, searchQuery, totalMatches, mode, localContent, textareaRef]);

	// Callback for when a search match is rendered (used for scrolling to current match in preview)
	const handleMatchRendered = useCallback(
		(index: number, element: HTMLElement) => {
			if (index === currentMatchIndex) {
				element.scrollIntoView({ behavior: 'smooth', block: 'center' });
			}
		},
		[currentMatchIndex]
	);

	return {
		searchOpen,
		searchQuery,
		setSearchQuery,
		currentMatchIndex,
		totalMatches,
		openSearch,
		closeSearch,
		goToNextMatchWithFlag,
		goToPrevMatchWithFlag,
		handleMatchRendered,
	};
}
