import { useRef, useState, useEffect, useCallback } from 'react';
import { useThrottledCallback } from '../../../hooks';

interface UseTerminalOutputScrollOptions {
	scrollContainerRef: React.RefObject<HTMLDivElement>;
	initialScrollTop?: number;
	sessionId: string;
	activeTabId: string | undefined;
	filteredLogsLength: number;
	onScrollPositionChange?: (scrollTop: number) => void;
	onAtBottomChange?: (isAtBottom: boolean) => void;
}

export function useTerminalOutputScroll({
	scrollContainerRef,
	initialScrollTop,
	sessionId,
	activeTabId,
	filteredLogsLength,
	onScrollPositionChange,
	onAtBottomChange,
}: UseTerminalOutputScrollOptions) {
	const [isAtBottom, setIsAtBottom] = useState(true);
	const [hasNewMessages, setHasNewMessages] = useState(false);
	const [newMessageCount, setNewMessageCount] = useState(0);
	const lastLogCountRef = useRef(0);
	const prevIsAtBottomRef = useRef(true);
	const isAtBottomRef = useRef(true);
	isAtBottomRef.current = isAtBottom;

	const [autoScrollPaused, setAutoScrollPaused] = useState(false);

	const isProgrammaticScrollRef = useRef(false);
	const tabReadStateRef = useRef<Map<string, number>>(new Map());
	const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const hasRestoredScrollRef = useRef(false);

	const handleScrollInner = useCallback(() => {
		if (!scrollContainerRef.current) return;
		const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
		const atBottom = scrollHeight - scrollTop - clientHeight < 50;
		setIsAtBottom(atBottom);
		// Mirror into the ref synchronously so MutationObserver sees the user's
		// new position before a content re-render can yank to bottom (#1140).
		isAtBottomRef.current = atBottom;

		if (atBottom !== prevIsAtBottomRef.current) {
			prevIsAtBottomRef.current = atBottom;
			onAtBottomChange?.(atBottom);
		}

		if (atBottom) {
			setHasNewMessages(false);
			setNewMessageCount(0);
			setAutoScrollPaused(false);
			if (activeTabId) {
				tabReadStateRef.current.set(activeTabId, filteredLogsLength);
			}
		} else if (isProgrammaticScrollRef.current) {
			isProgrammaticScrollRef.current = false;
		} else {
			setAutoScrollPaused(true);
		}

		if (onScrollPositionChange) {
			if (scrollSaveTimerRef.current) {
				clearTimeout(scrollSaveTimerRef.current);
			}
			scrollSaveTimerRef.current = setTimeout(() => {
				onScrollPositionChange(scrollTop);
				scrollSaveTimerRef.current = null;
			}, 200);
		}
	}, [
		activeTabId,
		filteredLogsLength,
		onScrollPositionChange,
		onAtBottomChange,
		scrollContainerRef,
	]);

	const handleScroll = useThrottledCallback(handleScrollInner, 16);

	useEffect(() => {
		if (!activeTabId) {
			setHasNewMessages(false);
			setNewMessageCount(0);
			setIsAtBottom(true);
			lastLogCountRef.current = filteredLogsLength;
			return;
		}

		const savedReadCount = tabReadStateRef.current.get(activeTabId);
		const currentCount = filteredLogsLength;

		if (savedReadCount !== undefined) {
			const unreadCount = currentCount - savedReadCount;
			if (unreadCount > 0) {
				setHasNewMessages(true);
				setNewMessageCount(unreadCount);
				setIsAtBottom(false);
			} else {
				setHasNewMessages(false);
				setNewMessageCount(0);
				setIsAtBottom(true);
			}
		} else {
			tabReadStateRef.current.set(activeTabId, currentCount);
			setHasNewMessages(false);
			setNewMessageCount(0);
			setIsAtBottom(true);
		}

		lastLogCountRef.current = currentCount;
	}, [activeTabId]);

	useEffect(() => {
		const currentCount = filteredLogsLength;
		if (currentCount > lastLogCountRef.current) {
			const container = scrollContainerRef.current;
			let actuallyAtBottom = isAtBottom;
			if (container) {
				const { scrollTop, scrollHeight, clientHeight } = container;
				actuallyAtBottom = scrollHeight - scrollTop - clientHeight < 50;
			}

			if (!actuallyAtBottom) {
				const newCount = currentCount - lastLogCountRef.current;
				setHasNewMessages(true);
				setNewMessageCount((prev) => prev + newCount);
				setIsAtBottom(false);
			} else if (activeTabId) {
				tabReadStateRef.current.set(activeTabId, currentCount);
			}
		}
		lastLogCountRef.current = currentCount;
	}, [filteredLogsLength, isAtBottom, activeTabId, scrollContainerRef]);

	useEffect(() => {
		const container = scrollContainerRef.current;
		if (!container) return;

		const scrollToBottom = () => {
			if (!scrollContainerRef.current) return;
			requestAnimationFrame(() => {
				// Re-check isAtBottomRef inside the rAF so a scroll-up that happens
				// after schedule but before paint cancels the yank (#1140).
				if (scrollContainerRef.current && isAtBottomRef.current) {
					isProgrammaticScrollRef.current = true;
					scrollContainerRef.current.scrollTo({
						top: scrollContainerRef.current.scrollHeight,
						behavior: 'auto',
					});
					setTimeout(() => {
						isProgrammaticScrollRef.current = false;
					}, 32);
				}
			});
		};

		// Only auto-scroll when the user's tracked position is at the bottom.
		// Gating on isAtBottom (not `!autoScrollPaused`) keeps a content re-render
		// after generation finishes — code-block re-highlight, markdown reflow —
		// from yanking the view down while the user reads earlier output. (#1140)
		if (isAtBottomRef.current) {
			scrollToBottom();
		}

		const observer = new MutationObserver(() => {
			if (isAtBottomRef.current) {
				scrollToBottom();
			}
		});

		observer.observe(container, {
			childList: true,
			subtree: true,
			characterData: true,
		});

		return () => observer.disconnect();
	}, [autoScrollPaused, scrollContainerRef]);

	useEffect(() => {
		if (initialScrollTop !== undefined && initialScrollTop > 0 && !hasRestoredScrollRef.current) {
			hasRestoredScrollRef.current = true;
			requestAnimationFrame(() => {
				if (scrollContainerRef.current) {
					const { scrollHeight, clientHeight } = scrollContainerRef.current;
					const maxScroll = Math.max(0, scrollHeight - clientHeight);
					const targetScroll = Math.min(initialScrollTop, maxScroll);
					if (targetScroll < maxScroll - 50) {
						// Flip isAtBottomRef first so the observer's live at-bottom
						// check sees the restored position this frame (#1140).
						isAtBottomRef.current = false;
						setAutoScrollPaused(true);
						setIsAtBottom(false);
					}
					scrollContainerRef.current.scrollTop = targetScroll;
				}
			});
		}
	}, [initialScrollTop, scrollContainerRef]);

	useEffect(() => {
		hasRestoredScrollRef.current = false;
	}, [sessionId, activeTabId]);

	useEffect(() => {
		return () => {
			if (scrollSaveTimerRef.current) {
				clearTimeout(scrollSaveTimerRef.current);
			}
		};
	}, []);

	const scrollToBottomAndResume = useCallback(() => {
		setAutoScrollPaused(false);
		setHasNewMessages(false);
		setNewMessageCount(0);
		if (scrollContainerRef.current) {
			scrollContainerRef.current.scrollTo({
				top: scrollContainerRef.current.scrollHeight,
				behavior: 'smooth',
			});
		}
	}, [scrollContainerRef]);

	return {
		isAtBottom,
		hasNewMessages,
		newMessageCount,
		autoScrollPaused,
		isAutoScrollActive: !autoScrollPaused,
		handleScroll,
		scrollToBottomAndResume,
	};
}
