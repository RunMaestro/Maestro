import { useRef, useState, useEffect, useCallback } from 'react';
import { useScrollPosition, useThrottledCallback } from '../../../hooks';

/** How long a programmatic bottom-jump keeps its scroll-event guard armed. */
const PROGRAMMATIC_SCROLL_GUARD_MS = 100;
/** Slack (px) for treating scrollTop as still parked at the recorded bottom. */
const PROGRAMMATIC_TARGET_EPSILON_PX = 4;

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
	// Absolute scrollTop the last programmatic bottom-jump parked at. A stream
	// only grows scrollHeight, so our scrollTop stays here until the user
	// scrolls; comparing against it tells our own scroll events apart from a
	// real user scroll-up. -1 = no programmatic jump yet.
	const programmaticTargetTopRef = useRef(-1);
	// ONE shared guard timer so overlapping jumps can't clear each other's guard.
	const programmaticGuardTimerRef = useRef<number | undefined>(undefined);
	const tabReadStateRef = useRef<Map<string, number>>(new Map());
	const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const hasRestoredScrollRef = useRef(false);

	const { getScrollMetrics } = useScrollPosition({
		containerRef: scrollContainerRef,
		bottomThreshold: 50,
		throttleMs: 0,
		observeChanges: true,
	});

	const handleScrollInner = useCallback(() => {
		if (!scrollContainerRef.current) return;
		const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
		const atBottom = scrollHeight - scrollTop - clientHeight < 50;
		// A programmatic bottom-jump (observer re-pin or the pin button) fires its
		// own scroll event. Streaming content only grows scrollHeight, so our
		// scrollTop stays parked at the recorded bottom target; a genuine user
		// scroll-up drops scrollTop below it. Ignore ONLY events that are still
		// parked at that target while the guard is armed; handle everything else -
		// including a user scroll-up within the guard window - as a real position
		// change so it correctly pauses auto-scroll. (#1140)
		const parkedAtProgrammaticTarget =
			isProgrammaticScrollRef.current &&
			scrollTop >= programmaticTargetTopRef.current - PROGRAMMATIC_TARGET_EPSILON_PX;
		if (atBottom || !parkedAtProgrammaticTarget) {
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
			} else {
				setAutoScrollPaused(true);
			}
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

	// Single choke point for programmatic bottom-jumps. Records the clamped
	// bottom target so handleScrollInner can tell our own scroll events apart
	// from a user scroll-up, and (re)starts ONE shared guard timer so an earlier
	// jump's timeout can never clear a later jump's guard.
	const jumpToBottom = useCallback(() => {
		const container = scrollContainerRef.current;
		if (!container) return;
		isProgrammaticScrollRef.current = true;
		programmaticTargetTopRef.current = Math.max(0, container.scrollHeight - container.clientHeight);
		container.scrollTo({ top: container.scrollHeight, behavior: 'auto' });
		window.clearTimeout(programmaticGuardTimerRef.current);
		programmaticGuardTimerRef.current = window.setTimeout(() => {
			isProgrammaticScrollRef.current = false;
			programmaticGuardTimerRef.current = undefined;
		}, PROGRAMMATIC_SCROLL_GUARD_MS);
	}, [scrollContainerRef]);

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
			const actuallyAtBottom = getScrollMetrics()?.isAtBottom ?? isAtBottom;

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
					jumpToBottom();
				}
			});
		};

		// Only auto-scroll when the user's tracked position is at the bottom.
		// Gating on isAtBottom (not `!autoScrollPaused`) keeps a content re-render
		// after generation finishes - code-block re-highlight, markdown reflow -
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
	}, [autoScrollPaused, scrollContainerRef, jumpToBottom]);

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
			window.clearTimeout(programmaticGuardTimerRef.current);
		};
	}, []);

	const scrollToBottomAndResume = useCallback(() => {
		setAutoScrollPaused(false);
		setHasNewMessages(false);
		setNewMessageCount(0);
		// Flip the at-bottom tracking synchronously. The MutationObserver's
		// stick-to-bottom gate reads `isAtBottomRef`, not `autoScrollPaused`, so
		// without this the button scrolls once but the observer refuses to keep
		// following the streaming thinking output (it still sees the pre-click
		// `false`). Mirror the state, ref, and prev-ref, mark everything read,
		// and notify the unread-tracking consumer.
		setIsAtBottom(true);
		isAtBottomRef.current = true;
		if (!prevIsAtBottomRef.current) {
			prevIsAtBottomRef.current = true;
			onAtBottomChange?.(true);
		}
		if (activeTabId) {
			tabReadStateRef.current.set(activeTabId, filteredLogsLength);
		}
		// Instant jump to the *current* bottom via the shared helper. A smooth
		// animation would target a scrollHeight the stream outgrows before it
		// settles, landing above the true bottom; the helper also records the
		// target so handleScrollInner keeps following without fighting a real
		// user scroll-up.
		jumpToBottom();
	}, [jumpToBottom, activeTabId, filteredLogsLength, onAtBottomChange]);

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
