import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';

export interface UseAutoRunScrollSyncParams {
	mode: 'edit' | 'preview';
	setMode: (mode: 'edit' | 'preview') => void;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	previewRef: RefObject<HTMLDivElement | null>;
	localContent: string;
	searchOpen: boolean;
	searchQuery: string;
	initialCursorPosition: number;
	initialEditScrollPos: number;
	initialPreviewScrollPos: number;
	onStateChange?: (state: {
		mode: 'edit' | 'preview';
		cursorPosition: number;
		editScrollPos: number;
		previewScrollPos: number;
	}) => void;
}

export interface UseAutoRunScrollSyncReturn {
	switchMode: (newMode: 'edit' | 'preview') => void;
	toggleMode: () => void;
	handlePreviewScroll: () => void;
}

export function useAutoRunScrollSync({
	mode,
	setMode,
	textareaRef,
	previewRef,
	localContent,
	searchOpen,
	searchQuery,
	initialCursorPosition,
	initialEditScrollPos,
	initialPreviewScrollPos,
	onStateChange,
}: UseAutoRunScrollSyncParams): UseAutoRunScrollSyncReturn {
	const previewScrollPosRef = useRef(initialPreviewScrollPos);
	const editScrollPosRef = useRef(initialEditScrollPos);
	const previewScrollDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Switch mode with scroll position synchronization
	const switchMode = useCallback(
		(newMode: 'edit' | 'preview') => {
			if (newMode === mode) return;

			// Calculate scroll percentage from current mode to apply to new mode
			let scrollPercent = 0;
			if (mode === 'edit' && textareaRef.current) {
				const { scrollTop, scrollHeight, clientHeight } = textareaRef.current;
				const maxScroll = scrollHeight - clientHeight;
				scrollPercent = maxScroll > 0 ? scrollTop / maxScroll : 0;
			} else if (mode === 'preview' && previewRef.current) {
				const { scrollTop, scrollHeight, clientHeight } = previewRef.current;
				const maxScroll = scrollHeight - clientHeight;
				scrollPercent = maxScroll > 0 ? scrollTop / maxScroll : 0;
			}

			setMode(newMode);

			// Apply scroll percentage to the new mode after it renders,
			// then notify parent with synchronized scroll values
			requestAnimationFrame(() => {
				if (newMode === 'preview' && previewRef.current) {
					const { scrollHeight, clientHeight } = previewRef.current;
					const maxScroll = scrollHeight - clientHeight;
					const newScrollTop = Math.round(scrollPercent * maxScroll);
					previewRef.current.scrollTop = newScrollTop;
					previewScrollPosRef.current = newScrollTop;
				} else if (newMode === 'edit' && textareaRef.current) {
					const { scrollHeight, clientHeight } = textareaRef.current;
					const maxScroll = scrollHeight - clientHeight;
					const newScrollTop = Math.round(scrollPercent * maxScroll);
					textareaRef.current.scrollTop = newScrollTop;
					editScrollPosRef.current = newScrollTop;
				}

				if (onStateChange) {
					onStateChange({
						mode: newMode,
						cursorPosition: textareaRef.current?.selectionStart || 0,
						editScrollPos: textareaRef.current?.scrollTop || 0,
						previewScrollPos: previewRef.current?.scrollTop || 0,
					});
				}
			});
		},
		[mode, onStateChange]
	);

	// Toggle between edit and preview modes
	const toggleMode = useCallback(() => {
		switchMode(mode === 'edit' ? 'preview' : 'edit');
	}, [mode, switchMode]);

	// Debounced preview scroll handler to avoid triggering re-renders on every scroll event
	// We only save scroll position to ref immediately (for local use), but delay parent notification
	const handlePreviewScroll = useCallback(() => {
		if (previewRef.current) {
			// Save to ref immediately for local persistence
			previewScrollPosRef.current = previewRef.current.scrollTop;

			// Debounce the parent state update to avoid cascading re-renders
			if (previewScrollDebounceRef.current) {
				clearTimeout(previewScrollDebounceRef.current);
			}
			previewScrollDebounceRef.current = setTimeout(() => {
				if (onStateChange && previewRef.current) {
					onStateChange({
						mode,
						cursorPosition: textareaRef.current?.selectionStart || 0,
						editScrollPos: textareaRef.current?.scrollTop || 0,
						previewScrollPos: previewRef.current.scrollTop,
					});
				}
			}, 500); // Only notify parent after 500ms of no scrolling
		}
	}, [mode, onStateChange]);

	// Cleanup debounce timer on unmount
	useEffect(() => {
		return () => {
			if (previewScrollDebounceRef.current) {
				clearTimeout(previewScrollDebounceRef.current);
			}
		};
	}, []);

	// Restore cursor and scroll positions when component mounts
	// Each restore is independently guarded by its own condition
	useEffect(() => {
		if (textareaRef.current) {
			if (initialCursorPosition > 0) {
				textareaRef.current.setSelectionRange(initialCursorPosition, initialCursorPosition);
			}
			if (initialEditScrollPos > 0) {
				textareaRef.current.scrollTop = initialEditScrollPos;
			}
		}
		if (previewRef.current && initialPreviewScrollPos > 0) {
			previewRef.current.scrollTop = initialPreviewScrollPos;
		}
	}, []);

	// Restore scroll position after content changes cause ReactMarkdown to rebuild DOM
	// useLayoutEffect runs synchronously after DOM mutations but before paint
	// Only track content changes in preview mode to avoid unnecessary work during editing
	const previewContentRef = useRef(localContent);
	useLayoutEffect(() => {
		// Skip if not in preview mode - no DOM to restore scroll on
		if (mode !== 'preview') {
			previewContentRef.current = localContent;
			return;
		}

		// Only restore scroll if content actually changed while in preview
		if (
			previewContentRef.current !== localContent &&
			previewRef.current &&
			previewScrollPosRef.current > 0
		) {
			// Use requestAnimationFrame to ensure DOM is fully updated
			requestAnimationFrame(() => {
				if (previewRef.current) {
					previewRef.current.scrollTop = previewScrollPosRef.current;
				}
			});
		}
		previewContentRef.current = localContent;
	}, [localContent, mode, searchOpen, searchQuery]);

	return {
		switchMode,
		toggleMode,
		handlePreviewScroll,
	};
}
