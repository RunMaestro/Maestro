import { useRef, useState, useEffect, useCallback } from 'react';
import { useThrottledCallback } from '../../../hooks';

/** How long a programmatic bottom-jump keeps its scroll-event guard armed. */
const PROGRAMMATIC_SCROLL_GUARD_MS = 100;
/** Slack (px) for treating scrollTop as still parked at the recorded bottom. */
const PROGRAMMATIC_TARGET_EPSILON_PX = 4;

interface UseTerminalOutputScrollOptions {
	scrollContainerRef: React.RefObject<HTMLDivElement>;
	/**
	 * Inner wrapper whose height equals the scrollable content height. Optional so
	 * callers (and tests) that do not render one keep the previous behaviour; when
	 * present it gets a ResizeObserver that re-pins the bottom on content growth
	 * that arrives without a DOM mutation (image decode, font load, late layout).
	 */
	contentRef?: React.RefObject<HTMLElement | null>;
	initialScrollTop?: number;
	initialIsAtBottom?: boolean;
	sessionId: string;
	activeTabId: string | undefined;
	filteredLogsLength: number;
	onScrollPositionChange?: (scrollTop: number) => void;
	onAtBottomChange?: (isAtBottom: boolean) => void;
}

export function useTerminalOutputScroll({
	scrollContainerRef,
	contentRef,
	initialScrollTop,
	initialIsAtBottom,
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
			// A newly-appended entry (e.g. a tall tool badge) must not pause a user
			// who is already following the bottom. Re-measuring the container here
			// would read the PRE-scroll position - the MutationObserver's rAF jump
			// has not run yet - so any entry taller than the 50px slack looks like a
			// scroll-up and spuriously pauses follow, and the stream then stops
			// sticking to the bottom. Trust the tracked follow state instead: while
			// following, mark the new content read and let the observer pin to the new
			// bottom; only raise the "new messages" pill when genuinely paused.
			if (isAtBottomRef.current) {
				if (activeTabId) tabReadStateRef.current.set(activeTabId, currentCount);
			} else {
				const newCount = currentCount - lastLogCountRef.current;
				setHasNewMessages(true);
				setNewMessageCount((prev) => prev + newCount);
				setIsAtBottom(false);
			}
		}
		lastLogCountRef.current = currentCount;
	}, [filteredLogsLength, activeTabId]);

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

		// Content can grow WITHOUT any DOM mutation - an image decoding, a web font
		// loading, markdown or tool-badge layout settling after the initial commit.
		// The MutationObserver above is blind to that, and for a freshly swapped-in
		// idle agent no mutations arrive at all, so the mount-time jump's one-frame
		// scrollHeight reading is all we would ever get and the view lands above the
		// live bottom. Watch the content wrapper instead: it is the only element
		// whose height tracks the scrollable content (observing the scroll container
		// would only fire on viewport resize). Same gate, same rAF, same
		// jumpToBottom choke point, so the #1140 guard bookkeeping stays in one place.
		const content = contentRef?.current;
		let resizeObserver: ResizeObserver | undefined;
		if (content && typeof ResizeObserver !== 'undefined') {
			resizeObserver = new ResizeObserver(() => {
				if (isAtBottomRef.current) {
					scrollToBottom();
				}
			});
			resizeObserver.observe(content);
		}

		return () => {
			observer.disconnect();
			resizeObserver?.disconnect();
		};
	}, [autoScrollPaused, scrollContainerRef, contentRef, jumpToBottom]);

	// Declared BEFORE the restore effect on purpose. React runs effects in
	// declaration order, so on mount and every tab switch this clears the latch
	// first and the restore effect below then latches it for good. Reversing the
	// order would leave the ref unlatched after commit, letting a later prop
	// change (e.g. a synchronous isAtBottom flip while initialScrollTop is still
	// the debounced-stale offset) re-fire the restore and yank the user. (J1)
	useEffect(() => {
		hasRestoredScrollRef.current = false;
	}, [sessionId, activeTabId]);

	useEffect(() => {
		if (initialScrollTop !== undefined && initialScrollTop > 0 && !hasRestoredScrollRef.current) {
			hasRestoredScrollRef.current = true;
			// Only restore a saved absolute offset when the user had deliberately
			// scrolled up when they left (initialIsAtBottom === false). When they
			// were following the bottom (true) - or on a legacy tab that never
			// persisted the flag (undefined) - skip the restore and let the
			// mount-time bottom jump + MutationObserver snap to and follow the live
			// bottom. hasRestoredScrollRef is latched above and the reset effect
			// runs earlier in declaration order, so a later prop change cannot
			// re-trigger this. (J1)
			if (initialIsAtBottom !== false) return;
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
	}, [initialScrollTop, initialIsAtBottom, scrollContainerRef]);

	useEffect(() => {
		return () => {
			// The pending 200ms scrollTop save is DROPPED here, not flushed, on
			// purpose. `onScrollPositionChange` (see useScrollLogHandlers) resolves
			// its target from `selectActiveSession` AT CALL TIME, and during an agent
			// swap the store already points at the NEW session by the time this
			// component unmounts - so flushing would write the outgoing agent's
			// offset into the incoming agent's tab. The cost is that up to the last
			// ~200ms of scrolling is not persisted; the fix would need the callback
			// to carry the owning sessionId/tabId, which is out of scope here.
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
