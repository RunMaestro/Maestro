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
	const autoScrollPausedRef = useRef(false);
	autoScrollPausedRef.current = autoScrollPaused;

	const isProgrammaticScrollRef = useRef(false);
	const tabReadStateRef = useRef<Map<string, number>>(new Map());
	const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const hasRestoredScrollRef = useRef(false);

	const handleScrollInner = useCallback(() => {
		if (!scrollContainerRef.current) return;
		const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
		const atBottom = scrollHeight - scrollTop - clientHeight < 50;
		setIsAtBottom(atBottom);

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

		const shouldAutoScroll = () => !autoScrollPausedRef.current || isAtBottomRef.current;

		const scrollToBottom = () => {
			if (!scrollContainerRef.current) return;
			requestAnimationFrame(() => {
				if (scrollContainerRef.current) {
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

		if (shouldAutoScroll()) {
			scrollToBottom();
		}

		const observer = new MutationObserver(() => {
			if (shouldAutoScroll()) {
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
						autoScrollPausedRef.current = true;
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
