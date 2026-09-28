import { useRef, useState, useEffect, useCallback } from 'react';
import { useThrottledCallback } from '../../../hooks';
import { useEventListener } from '../../../hooks/utils/useEventListener';
import {
	TRANSCRIPT_SCROLL_TO_BOTTOM_EVENT,
	type TranscriptScrollToBottomDetail,
} from '../../../services/transcriptScroll';

/** How long a programmatic bottom-jump keeps its scroll-event guard armed. */
const PROGRAMMATIC_SCROLL_GUARD_MS = 100;
/**
 * How long a restored transcript offset waits for the content to grow again
 * before giving up. Images, web fonts, markdown reflow and code highlighting
 * all grow scrollHeight after the first frame, and the restore clamps against
 * whatever height it sees.
 *
 * This is a QUIET window, re-armed on every growth, not a deadline measured
 * from the first frame. A long transcript does not mount in one commit - the
 * progressive render window (issue #1342) walks back through history a chunk
 * at a time on idle ticks, and rows carry `content-visibility: auto`, so their
 * real heights replace the `contain-intrinsic-size` estimate only as they come
 * near the viewport. Both can run well past two seconds, and a fixed deadline
 * expired in the middle of them. (#1535)
 */
const SCROLL_RESTORE_SETTLE_MS = 2000;
/**
 * Absolute ceiling on a restore, however long the content keeps growing. The
 * quiet window above re-arms, so this is what guarantees the observer and its
 * timers are always torn down.
 */
const SCROLL_RESTORE_MAX_MS = 15000;

/**
 * How long after a wheel, touch, scroll key, or scrollbar drag a `scroll` event
 * still counts as the user's. Long enough to cover trackpad momentum between
 * two wheel events, short enough that the next auto-scroll is not mistaken for
 * them.
 */
const USER_SCROLL_WINDOW_MS = 500;

/** Keys that move a scroll box, so pressing one counts as the user scrolling. */
const SCROLL_KEYS = new Set([
	'ArrowUp',
	'ArrowDown',
	'PageUp',
	'PageDown',
	'Home',
	'End',
	' ',
	'Spacebar',
]);

/** Slack (px) for treating scrollTop as still parked at the recorded bottom. */
const PROGRAMMATIC_TARGET_EPSILON_PX = 4;
/** Slack (px) within which the transcript counts as scrolled to the bottom. */
const AT_BOTTOM_SLACK_PX = 50;
/**
 * Distance from the top that triggers loading older history (issue #1407).
 * Generous enough to fire before the user bottoms out against the first entry,
 * so the next page is on its way while there is still content to scroll through.
 */
const TRANSCRIPT_BACKFILL_TOP_THRESHOLD = 200;

/**
 * The two facts every scroll path needs about the container. `handleScroll` and
 * `handleScrollInner` MUST agree on both - the unthrottled wrapper records the
 * user's intent and the throttled inner persists it, so a divergence between
 * them would let the two disagree about where the user actually is. Measuring
 * in one place makes that impossible rather than merely unlikely.
 */
function measureScrollState(
	container: HTMLElement,
	isProgrammatic: boolean,
	programmaticTargetTop: number,
	userScrolledRecently: boolean
): { scrollTop: number; atBottom: boolean; parkedAtProgrammaticTarget: boolean } {
	const { scrollTop, scrollHeight, clientHeight } = container;
	return {
		scrollTop,
		atBottom: scrollHeight - scrollTop - clientHeight < AT_BOTTOM_SLACK_PX,
		// A programmatic bottom-jump (observer re-pin or the pin button) fires its
		// own scroll event. Streaming content only grows scrollHeight, so our
		// scrollTop stays parked at the recorded bottom target; a genuine user
		// scroll-up drops scrollTop below it.
		//
		// The guard flag alone cannot cover every one of those events: it is a
		// single boolean consumed by ONE throttled handler call, while the restore
		// loop writes every frame and `jumpToBottom` clears it on a timer. An echo
		// the flag missed reported an offset that was no longer the bottom (the
		// content grew underneath it) and read as a scroll-up - auto-scroll paused
		// and the tab was persisted as parked mid-history, so every later visit
		// opened it higher. So an event still parked at our recorded target counts
		// as ours whenever the user has not touched the scroll recently, armed or
		// not. `programmaticTargetTop < 0` means we have not written one yet, or
		// the user's own input superseded it.
		parkedAtProgrammaticTarget:
			programmaticTargetTop >= 0 &&
			(isProgrammatic || !userScrolledRecently) &&
			scrollTop >= programmaticTargetTop - PROGRAMMATIC_TARGET_EPSILON_PX,
	};
}

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
	/**
	 * Fired when the user scrolls within `TRANSCRIPT_BACKFILL_TOP_THRESHOLD` of
	 * the top, so the caller can page older history in (issue #1407). Kept here
	 * rather than in the component because this hook already owns the throttled
	 * scroll handler; a second listener on the same container would double the
	 * per-frame measurement work.
	 */
	onNearTop?: () => void;
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
	onNearTop,
}: UseTerminalOutputScrollOptions) {
	const [isAtBottom, setIsAtBottom] = useState(true);
	const [hasNewMessages, setHasNewMessages] = useState(false);
	const [newMessageCount, setNewMessageCount] = useState(0);
	const lastLogCountRef = useRef(0);
	const prevIsAtBottomRef = useRef(true);
	const isAtBottomRef = useRef(true);
	// Records the user's intent separately from React state. The public scroll
	// handler updates this ref immediately, before its throttled state update,
	// so a settled-response DOM mutation cannot steal the reading position.
	const userScrolledAwayRef = useRef(initialIsAtBottom === false);
	isAtBottomRef.current = isAtBottom;

	const [autoScrollPaused, setAutoScrollPaused] = useState(false);

	// Kept in a ref so the throttled scroll handler does not have to re-create
	// itself (and reset its throttle window) when the callback identity changes.
	const onNearTopRef = useRef(onNearTop);
	onNearTopRef.current = onNearTop;

	// Guard flag: a cross-tab search jump is landing, so the follow-the-tail
	// auto-scroll must stand down. Switching tabs re-renders every row, and the
	// MutationObserver below reacts to that by slamming the container to the
	// bottom - which is what used to eat the scroll to the hit.
	const jumpInFlightRef = useRef(false);

	const isProgrammaticScrollRef = useRef(false);
	// Absolute scrollTop the last programmatic bottom-jump parked at. A stream
	// only grows scrollHeight, so our scrollTop stays here until the user
	// scrolls; comparing against it tells our own scroll events apart from a
	// real user scroll-up. -1 = no programmatic jump yet.
	const programmaticTargetTopRef = useRef(-1);
	// When the user last actually touched the scroll: wheel, trackpad, touch, a
	// scroll key, or a scrollbar drag. This is the only proof a scroll came from
	// them - this component moves the offset constantly on its own, and each of
	// those writes fires an indistinguishable `scroll` event.
	const lastUserInputAtRef = useRef(0);
	// ONE shared guard timer so overlapping jumps can't clear each other's guard.
	const programmaticGuardTimerRef = useRef<number | undefined>(undefined);
	const tabReadStateRef = useRef<Map<string, number>>(new Map());
	const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const hasRestoredScrollRef = useRef(false);
	// True while the mount-time restore is still walking the offset up through a
	// growing transcript. Suppresses persistence: every write the restore makes
	// fires a scroll event, and saving one of those clamped intermediate offsets
	// overwrites the very position being restored to. (#1535)
	const restoreInFlightRef = useRef(false);
	// Tears down an in-flight restore-settle retry (observer, timers, listeners).
	const cancelRestoreSettleRef = useRef<(() => void) | undefined>(undefined);

	const handleScrollInner = useCallback(() => {
		if (!scrollContainerRef.current) return;
		// Ignore ONLY events that are still parked at the programmatic target while
		// the guard is armed; handle everything else - including a user scroll-up
		// within the guard window - as a real position change so it correctly
		// pauses auto-scroll. (#1140)
		const { scrollTop, atBottom, parkedAtProgrammaticTarget } = measureScrollState(
			scrollContainerRef.current,
			isProgrammaticScrollRef.current,
			programmaticTargetTopRef.current,
			Date.now() - lastUserInputAtRef.current < USER_SCROLL_WINDOW_MS
		);
		// A restore in flight owns these three refs outright. Every offset it
		// writes fires a real scroll event, and while it is still short of its
		// target that offset IS the live bottom, so this handler would measure
		// `atBottom === true` and hand the view straight back to the tail-follower
		// the restore is trying to walk up through - the MutationObserver gate
		// reads `isAtBottomRef.current` and re-pins to the next growth. The
		// user-takeover listeners all clear the flag before the scroll event they
		// cause reaches here, so their positions are still recorded. (#1535)
		if (!restoreInFlightRef.current && (atBottom || !parkedAtProgrammaticTarget)) {
			userScrolledAwayRef.current = !atBottom;
			setIsAtBottom(atBottom);
			// Mirror into the ref synchronously so MutationObserver sees the user's
			// new position before a content re-render can yank to bottom (#1140).
			isAtBottomRef.current = atBottom;

			if (atBottom !== prevIsAtBottomRef.current) {
				prevIsAtBottomRef.current = atBottom;
				onAtBottomChange?.(atBottom);
				// The flag and the offset MUST be persisted together. The debounced
				// save below is dropped on unmount (see the cleanup effect), so a
				// swap within 200ms of crossing the boundary would otherwise store
				// `isAtBottom: false` with no matching scrollTop - and the remount
				// restore, which requires `initialScrollTop > 0`, then skips and the
				// mount-time bottom jump snaps the user back down. Writing both
				// halves in the same tick, in both directions, keeps the saved pair
				// coherent no matter when the component goes away. (Y1)
				onScrollPositionChange?.(scrollTop);
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

		// Reaching the top pulls the next page of older history in from the
		// provider transcript (issue #1407). Guarded on the container actually
		// being scrollable so a short transcript that sits at scrollTop 0 does
		// not fire a read on every scroll event.
		const { scrollHeight, clientHeight } = scrollContainerRef.current;
		if (scrollTop < TRANSCRIPT_BACKFILL_TOP_THRESHOLD && scrollHeight > clientHeight) {
			onNearTopRef.current?.();
		}

		// Nothing our OWN write produced is a position the user chose. The branch
		// above already refused to act on such an event; the debounced save has to
		// refuse too, or the tab is persisted at whatever offset the echo reported
		// - which is how a tail-following tab was stored as parked mid-history and
		// opened higher on every later visit.
		//
		// A restore in flight is the same thing one step earlier: it writes the
		// offset on every growth, and saving one of those clamped intermediates
		// both destroys the position being restored to AND changes the
		// `initialScrollTop` prop, whose effect cleanup then cancels the settle
		// loop mid-restore. (#1535)
		const isOwnEcho = restoreInFlightRef.current || (!atBottom && parkedAtProgrammaticTarget);
		if (onScrollPositionChange && !isOwnEcho) {
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

	const throttledHandleScroll = useThrottledCallback(handleScrollInner, 16);

	const handleScroll = useCallback(() => {
		const container = scrollContainerRef.current;
		if (container) {
			const { atBottom, parkedAtProgrammaticTarget } = measureScrollState(
				container,
				isProgrammaticScrollRef.current,
				programmaticTargetTopRef.current,
				Date.now() - lastUserInputAtRef.current < USER_SCROLL_WINDOW_MS
			);

			// The throttled handler persists position and updates UI state, but the
			// user's scroll-away intent must become authoritative immediately.
			// Otherwise a DOM mutation in the same frame can observe stale
			// at-bottom state and jump over what the user is reading.
			if (atBottom) {
				userScrolledAwayRef.current = false;
				isAtBottomRef.current = true;
			} else if (!parkedAtProgrammaticTarget) {
				userScrolledAwayRef.current = true;
				isAtBottomRef.current = false;
			}
		}

		throttledHandleScroll();
	}, [scrollContainerRef, throttledHandleScroll]);

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
			userScrolledAwayRef.current = false;
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
				userScrolledAwayRef.current = true;
			} else {
				setHasNewMessages(false);
				setNewMessageCount(0);
				setIsAtBottom(true);
				userScrolledAwayRef.current = false;
			}
		} else {
			tabReadStateRef.current.set(activeTabId, currentCount);
			setHasNewMessages(false);
			setNewMessageCount(0);
			setIsAtBottom(true);
			userScrolledAwayRef.current = false;
		}

		lastLogCountRef.current = currentCount;
	}, [activeTabId]);

	useEffect(() => {
		const currentCount = filteredLogsLength;
		if (currentCount > lastLogCountRef.current) {
			// A newly-appended entry (e.g. a tall tool badge) must not pause a user
			// who is already following the bottom. Re-measuring the container here
			// would read the PRE-scroll position - the MutationObserver's rAF jump
			// has not run yet - so any entry taller than the at-bottom slack looks like a
			// scroll-up and spuriously pauses follow, and the stream then stops
			// sticking to the bottom. Trust the tracked follow state instead: while
			// following, mark the new content read and let the observer pin to the new
			// bottom; only raise the "new messages" pill when genuinely paused.
			if (isAtBottomRef.current && !userScrolledAwayRef.current) {
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
				if (
					scrollContainerRef.current &&
					isAtBottomRef.current &&
					!userScrolledAwayRef.current &&
					!jumpInFlightRef.current
				) {
					jumpToBottom();
				}
			});
		};

		// Only auto-scroll when the user's tracked position is at the bottom.
		// Gating on isAtBottom (not `!autoScrollPaused`) keeps a content re-render
		// after generation finishes - code-block re-highlight, markdown reflow -
		// from yanking the view down while the user reads earlier output. (#1140)
		if (isAtBottomRef.current && !userScrolledAwayRef.current) {
			scrollToBottom();
		}

		const observer = new MutationObserver(() => {
			if (isAtBottomRef.current && !userScrolledAwayRef.current) {
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
		// A restore belongs to the tab it was started for. Leaving the flag set
		// across a switch would suppress persistence for the incoming tab forever.
		restoreInFlightRef.current = false;
		userScrolledAwayRef.current = initialIsAtBottom === false;
	}, [sessionId, activeTabId]);

	useEffect(() => {
		// `>= 0`, not `> 0`: scrolling to the ABSOLUTE TOP of an overflowing
		// transcript persists `scrollTop: 0` with `isAtBottom: false`, which is a
		// perfectly ordinary deliberate position. Requiring a positive offset made
		// that one spot unrestorable, so returning to a tab left at the very top
		// snapped it to the live bottom. `initialIsAtBottom !== false` below is the
		// real gate; the offset only needs to exist. (Y1 review)
		if (initialScrollTop !== undefined && initialScrollTop >= 0 && !hasRestoredScrollRef.current) {
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
			restoreInFlightRef.current = true;

			// Applying the offset ONCE, one frame after mount, is not enough. The
			// clamp below is against whatever scrollHeight happens to be in that
			// frame, and a transcript is at its shortest right then: only the newest
			// entries have been mounted (the progressive render window, issue #1342),
			// the rows that ARE mounted are still laid out at their
			// `contain-intrinsic-size` estimate, images have not decoded, web fonts
			// have not loaded, and markdown and code highlighting have not settled. A
			// deep offset lands short and the tab opens scrolled UP from where it was
			// left, permanently - the deps here do not change as content grows.
			//
			// This is the same growth the ResizeObserver above was added for, and its
			// comment describes this exact mechanism. That one is gated on
			// isAtBottomRef.current, so it only ever rescued the bottom-following
			// case. This is the scrolled-up half of the same problem.
			//
			// No conflict between the two: while this restore is short of its target
			// it holds isAtBottomRef.current = false, which is precisely the gate the
			// bottom-follower checks. Only one of them is ever live.
			let settleObserver: ResizeObserver | undefined;
			// Re-armed on every growth: the transcript mounts over many idle ticks,
			// so the budget is SILENCE from the content, not wall clock. (#1535)
			let quietTimer: number | undefined;
			let capTimer: number | undefined;

			// Hands the view back to the ordinary follow/pause bookkeeping. The hold
			// applyRestore keeps while it is short of the target has to be lifted if
			// the restore ends parked at the live bottom anyway (the transcript is
			// genuinely shorter than the saved offset, or the user scrolled back
			// down), or the tab sits at the bottom showing a scroll-to-bottom button
			// and refusing to follow the stream. Measured from live geometry, so a
			// user who took over somewhere else stays paused.
			const releaseRestore = () => {
				if (!restoreInFlightRef.current) return;
				restoreInFlightRef.current = false;
				const container = scrollContainerRef.current;
				if (!container) return;
				const { scrollHeight, clientHeight, scrollTop } = container;
				if (scrollHeight - scrollTop - clientHeight < AT_BOTTOM_SLACK_PX) {
					userScrolledAwayRef.current = false;
					isAtBottomRef.current = true;
					setIsAtBottom(true);
					setAutoScrollPaused(false);
				}
			};

			const stopSettling = () => {
				settleObserver?.disconnect();
				settleObserver = undefined;
				window.clearTimeout(quietTimer);
				window.clearTimeout(capTimer);
				const el = scrollContainerRef.current;
				el?.removeEventListener('wheel', stopSettling);
				el?.removeEventListener('touchstart', stopSettling);
				// Keyboard and scrollbar are the other two ways a user takes the view
				// over, and neither sends a wheel: a scrollbar drag starts at
				// `pointerdown`, and PageUp / arrows arrive as `keydown`. Without
				// these the retry loop kept re-applying the saved offset over the
				// position they had just chosen, for up to SCROLL_RESTORE_MAX_MS,
				// while `restoreInFlightRef` also suppressed persisting it.
				el?.removeEventListener('pointerdown', stopSettling);
				el?.removeEventListener('keydown', stopSettlingOnKey);
				releaseRestore();
			};
			// A scroll key only counts when it is one that actually moves a scroll
			// box - typing in an inline editor inside the transcript is not the user
			// taking the view over. Same filter `noteUserScrollInput` applies.
			const stopSettlingOnKey = (event: Event) => {
				if (!SCROLL_KEYS.has((event as KeyboardEvent).key)) return;
				stopSettling();
			};
			cancelRestoreSettleRef.current = stopSettling;

			// Returns true once the offset has actually been REACHED. Falling short
			// is deliberately not an ending: `targetScroll` clamped to the current
			// maxScroll used to count as "the transcript cannot scroll that far",
			// which is only true once it has finished mounting. In the first frame it
			// is true of every deep offset, so the retry loop below was never even
			// installed and the tab opened wherever the estimate-height content
			// happened to end - a fixed fraction down a transcript that then grew
			// several times taller underneath it. (#1535)
			const applyRestore = (): boolean => {
				const container = scrollContainerRef.current;
				if (!container) return true;
				const { scrollHeight, clientHeight } = container;
				const maxScroll = Math.max(0, scrollHeight - clientHeight);
				const targetScroll = Math.min(initialScrollTop, maxScroll);
				if (targetScroll < initialScrollTop || targetScroll < maxScroll - AT_BOTTOM_SLACK_PX) {
					// Flip isAtBottomRef first so the observer's live at-bottom
					// check sees the restored position this frame (#1140). Held down
					// while still SHORT of the target too: the clamp parks us at the
					// live bottom, and a bottom-follower claiming the view there
					// re-pins to every growth the restore is trying to walk up
					// through.
					userScrolledAwayRef.current = true;
					isAtBottomRef.current = false;
					setAutoScrollPaused(true);
					setIsAtBottom(false);
				} else {
					userScrolledAwayRef.current = false;
				}
				container.scrollTop = targetScroll;
				return Math.abs(container.scrollTop - initialScrollTop) <= 1;
			};

			requestAnimationFrame(() => {
				// A cross-tab search jump asked for a specific message in this tab.
				// That beats the position the tab was left at - restoring here would
				// scroll straight back off the hit.
				if (jumpInFlightRef.current) {
					restoreInFlightRef.current = false;
					return;
				}
				const container = scrollContainerRef.current;
				if (!container) {
					restoreInFlightRef.current = false;
					return;
				}
				if (applyRestore()) {
					releaseRestore();
					return;
				}

				// Fell short: the content is still growing. Re-apply as it does, and
				// give up the moment the user takes over - a restore that fights a
				// scroll already in progress is worse than the miss it corrects.
				const armQuietTimer = () => {
					window.clearTimeout(quietTimer);
					quietTimer = window.setTimeout(stopSettling, SCROLL_RESTORE_SETTLE_MS);
				};
				if (typeof ResizeObserver !== 'undefined') {
					settleObserver = new ResizeObserver(() => {
						if (jumpInFlightRef.current || applyRestore()) {
							stopSettling();
							return;
						}
						// Still short, but the content DID grow, so the transcript is
						// still mounting. Give it another quiet window rather than
						// expiring part-way through a long history.
						armQuietTimer();
					});
					// The CONTENT wrapper, not the scroll box. The scroll box's own
					// border box is the VIEWPORT, which does not change as entries
					// mount, so observing it fires only on a window resize - the retry
					// loop was inert for the very growth it exists to follow. Same
					// element the bottom-follower's observer above watches, and for the
					// same reason. (#1535)
					settleObserver.observe(contentRef?.current ?? container);
				}
				armQuietTimer();
				capTimer = window.setTimeout(stopSettling, SCROLL_RESTORE_MAX_MS);
				container.addEventListener('wheel', stopSettling, { passive: true });
				container.addEventListener('touchstart', stopSettling, { passive: true });
				container.addEventListener('pointerdown', stopSettling, { passive: true });
				container.addEventListener('keydown', stopSettlingOnKey, { passive: true });
			});
		}
		return () => cancelRestoreSettleRef.current?.();
	}, [initialScrollTop, initialIsAtBottom, scrollContainerRef, contentRef]);

	useEffect(() => {
		return () => {
			// The pending 200ms scrollTop save is DROPPED here, not flushed, on
			// purpose. `onScrollPositionChange` (see useScrollLogHandlers) resolves
			// its target from `selectActiveSession` AT CALL TIME, and during an agent
			// swap the store already points at the NEW session by the time this
			// component unmounts - so flushing would write the outgoing agent's
			// offset into the incoming agent's tab. The cost is now only that up to
			// the last ~200ms of scrolling REFINEMENT is not persisted, never the
			// coherence of the saved pair: handleScrollInner writes the flag and the
			// offset together, synchronously, whenever the at-bottom boundary is
			// crossed (Y1), so a dropped debounce can only cost precision within a
			// position that was already saved. Removing even that imprecision would
			// need the callback to carry the owning sessionId/tabId, which is out of
			// scope here.
			if (scrollSaveTimerRef.current) {
				clearTimeout(scrollSaveTimerRef.current);
			}
			window.clearTimeout(programmaticGuardTimerRef.current);
		};
	}, []);

	const pauseForJump = useCallback(() => {
		isAtBottomRef.current = false;
		setAutoScrollPaused(true);
		setIsAtBottom(false);
	}, []);

	const scrollToBottomAndResume = useCallback(() => {
		userScrolledAwayRef.current = false;
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

	// A bang command's output card is a reply the user asked for by pressing
	// Enter, so it has to be visible the moment it starts streaming. If they were
	// reading history at the time, auto-scroll is paused and the card would land
	// offscreen behind the unread badge - the one case where the pause is wrong,
	// because the new content is theirs, not the agent's. The request names its
	// session and tab, so a command dispatched into a background conversation
	// cannot yank the view off what the user is reading.
	useEventListener(TRANSCRIPT_SCROLL_TO_BOTTOM_EVENT, (event) => {
		const detail = (event as CustomEvent<TranscriptScrollToBottomDetail>).detail;
		if (!detail || detail.sessionId !== sessionId || detail.tabId !== activeTabId) return;
		scrollToBottomAndResume();
	});

	// Timestamp the user's own scroll input. Pointer events are included for the
	// scrollbar itself, which drags without ever sending a wheel. Keys are
	// filtered to the ones that actually move a scroll box - typing in an inline
	// editor inside the transcript is not a scroll.
	const noteUserScrollInput = useCallback((event: React.SyntheticEvent) => {
		if (event.type === 'keydown') {
			const key = (event as React.KeyboardEvent).key;
			if (!SCROLL_KEYS.has(key)) return;
		}
		lastUserInputAtRef.current = Date.now();
		// Their input supersedes wherever we last put the view, so stop treating
		// that offset as ours.
		programmaticTargetTopRef.current = -1;
	}, []);

	return {
		isAtBottom,
		hasNewMessages,
		newMessageCount,
		autoScrollPaused,
		isAutoScrollActive: !autoScrollPaused,
		handleScroll,
		noteUserScrollInput,
		scrollToBottomAndResume,
		/** True while a cross-tab jump is landing; suppresses follow-the-tail. */
		jumpInFlightRef,
		/**
		 * Stay on a jumped-to hit instead of following the tail. Scrolling back to
		 * the bottom resumes auto-scroll (see handleScrollInner), so this leaves the
		 * same state a manual scroll-up would. Flips the refs before the state so
		 * the observers' live reads see the pause this frame, not next render.
		 */
		pauseForJump,
	};
}
