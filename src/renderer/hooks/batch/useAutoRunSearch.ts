import { useState, useCallback, useRef, useEffect, type RefObject } from 'react';
import type { MarkdownEditorHandle } from '../../components/FilePreview/markdownEditor';
import { searchMatchRanges, type MatchRange } from '../../utils/highlightMatches';

export interface UseAutoRunSearchParams {
	localContent: string;
	mode: 'edit' | 'preview';
	editorRef: RefObject<MarkdownEditorHandle | null>;
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
	editorRef,
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
	// Offsets of every hit in the source, recomputed with the debounced count so
	// the editor's painted decorations and the counter can never disagree.
	const matchRangesRef = useRef<MatchRange[]>([]);

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
		matchRangesRef.current = [];
		// Drop the painted decorations before the editor loses the query that
		// justified them, then refocus the surface the user was reading.
		editorRef.current?.setSearchMatches([], -1);
		if (mode === 'edit' && editorRef.current) {
			editorRef.current.focus();
		} else if (mode === 'preview' && previewRef?.current) {
			previewRef.current.focus();
		}
	}, [mode, editorRef, previewRef]);

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
				const ranges = searchMatchRanges(localContent, searchQuery);
				matchRangesRef.current = ranges;
				const count = ranges.length;
				setTotalMatches(count);
				// Use functional updater to avoid stale currentMatchIndex from closure
				setCurrentMatchIndex((prev) => (count > 0 && prev >= count ? 0 : prev));
			}, 150); // Short delay for search responsiveness
		} else {
			matchRangesRef.current = [];
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

	// Paint every hit in the source editor, with the current one in the stronger
	// color. The old textarea could not mark its own text, so edit-mode search
	// only ever moved the caret - CodeMirror decorations make the hits visible.
	useEffect(() => {
		if (mode !== 'edit') return;
		if (!searchOpen || !searchQuery.trim()) {
			editorRef.current?.setSearchMatches([], -1);
			return;
		}
		editorRef.current?.setSearchMatches(matchRangesRef.current, currentMatchIndex);
	}, [mode, searchOpen, searchQuery, currentMatchIndex, totalMatches, editorRef]);

	// Reveal the current match in edit mode. Only when the user explicitly
	// navigated (prev/next or Enter), not on every keystroke.
	useEffect(() => {
		if (!userNavigatedToMatchRef.current) return;
		if (!searchOpen || !searchQuery.trim() || totalMatches === 0) return;
		if (mode !== 'edit' || !editorRef.current) return;

		const range = matchRangesRef.current[currentMatchIndex];
		if (!range) return;

		// CodeMirror scrolls the selection into view for us - no mirror-div
		// height measurement, and it stays correct under soft wrap.
		editorRef.current.setSelection(range.from, range.to, true);
		editorRef.current.focus();
		userNavigatedToMatchRef.current = false;
	}, [currentMatchIndex, searchOpen, searchQuery, totalMatches, mode, editorRef]);

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
