/**
 * useHistoryPagination
 *
 * Shared windowed-pagination engine for the History panels (right-bar
 * single-session and Director's Notes unified). Both views ride on the
 * same hook so scroll-to-load-older and click-to-jump-to-old-bucket
 * behave identically.
 *
 * Why "windowed":
 * - The list is a contiguous slice `[startOffset, startOffset + entries.length)`
 *   of the newest-first sorted history, never the whole thing.
 * - Scrolling near the bottom appends an older page.
 * - Clicking a graph bucket far in the past **does not** fetch every
 *   page in between — it seeks directly, replacing the loaded window
 *   with a single page anchored at the target offset. Memory stays bounded.
 *
 * Real-time entries that arrive while the window is jumped (startOffset > 0)
 * are silently dropped from the visible list (they'd be at offset 0, well
 * outside the user's viewport). Total/badge counts still tick up via the
 * caller's own stats handling.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { logger } from '../../utils/logger';

/** Shape every page-loader must return. */
export interface PaginatedPage<T> {
	entries: T[];
	hasMore: boolean;
	total: number;
}

export interface UseHistoryPaginationOptions<T> {
	/** Page size (entries per fetch). Both panels currently use 100. */
	pageSize: number;
	/**
	 * Page loader. Must return entries newest-first within the window
	 * `[offset, offset + limit)`. Stable identity (useCallback) — when this
	 * changes the loaded window resets and the initial page is fetched
	 * again. Use this to react to lookback / filter changes upstream.
	 */
	loadPage: (offset: number, limit: number) => Promise<PaginatedPage<T>>;
	/** Stable identifier for an entry — used to dedupe streamed prepends. */
	getEntryId: (entry: T) => string;
}

export interface UseHistoryPaginationResult<T> {
	entries: T[];
	/** Offset of `entries[0]` in the full newest-first list. */
	startOffset: number;
	totalCount: number;
	hasMoreOlder: boolean;
	/** True while the initial page (or a jump) is in flight. */
	isLoading: boolean;
	/** True while a scroll-triggered older page is in flight. */
	isLoadingMore: boolean;
	/** True while a click-to-jump fetch is in flight. */
	isJumping: boolean;
	/** True when the loaded window starts at offset 0 (i.e. newest entries). */
	isAtTop: boolean;

	/**
	 * Append the next older page. Safe to call from a scroll handler — it
	 * coalesces concurrent calls and is a no-op when nothing more to load.
	 */
	loadMoreOlder: () => Promise<void>;

	/**
	 * Replace the loaded window with a page anchored at `targetOffset`
	 * (page-aligned). Use after `getOffsetForTimestamp` to jump to a
	 * graph bucket far from the current viewport.
	 */
	jumpToOffset: (targetOffset: number) => Promise<void>;

	/**
	 * Jump back to the top (offset 0) — equivalent to a fresh initial load.
	 */
	jumpToTop: () => Promise<void>;

	/**
	 * Try to prepend a real-time entry. Returns true if it was inserted
	 * (the window is at the top), false if it was dropped (the window is
	 * jumped). Caller handles totals/stats independently.
	 */
	prependLiveEntry: (entry: T) => boolean;

	/**
	 * Replace the entries set in place — for client-side mutations like
	 * delete/update that the caller already applied to the IPC.
	 */
	mutateEntries: (mutator: (current: T[]) => T[]) => void;
}

const LOG_CONTEXT = 'useHistoryPagination';

export function useHistoryPagination<T>({
	pageSize,
	loadPage,
	getEntryId,
}: UseHistoryPaginationOptions<T>): UseHistoryPaginationResult<T> {
	const [entries, setEntries] = useState<T[]>([]);
	const [startOffset, setStartOffset] = useState(0);
	const [totalCount, setTotalCount] = useState(0);
	const [hasMoreOlder, setHasMoreOlder] = useState(true);
	const [isLoading, setIsLoading] = useState(true);
	const [isLoadingMore, setIsLoadingMore] = useState(false);
	const [isJumping, setIsJumping] = useState(false);

	// Single in-flight guard shared across loadMoreOlder / jumpToOffset /
	// jumpToTop so a fast scroll into a click-to-jump can't race.
	const inFlightRef = useRef(false);

	// Latest values for the prepend handler — keeping it stable means
	// caller-side effect deps don't change every render.
	const startOffsetRef = useRef(startOffset);
	useEffect(() => {
		startOffsetRef.current = startOffset;
	}, [startOffset]);
	const getEntryIdRef = useRef(getEntryId);
	useEffect(() => {
		getEntryIdRef.current = getEntryId;
	}, [getEntryId]);

	// Reload from the top whenever the loader identity changes — this is
	// the canonical signal that the upstream filters (lookback, etc.)
	// shifted, so the offset semantics no longer match.
	useEffect(() => {
		let cancelled = false;
		setIsLoading(true);
		inFlightRef.current = true;
		loadPage(0, pageSize)
			.then((result) => {
				if (cancelled) return;
				setEntries(result.entries);
				setStartOffset(0);
				setTotalCount(result.total);
				setHasMoreOlder(result.hasMore);
			})
			.catch((err) => {
				if (cancelled) return;
				logger.error('Initial page load failed', LOG_CONTEXT, err);
				setEntries([]);
				setStartOffset(0);
				setTotalCount(0);
				setHasMoreOlder(false);
			})
			.finally(() => {
				if (cancelled) return;
				setIsLoading(false);
				inFlightRef.current = false;
			});
		return () => {
			cancelled = true;
		};
	}, [loadPage, pageSize]);

	const loadMoreOlder = useCallback(async () => {
		if (inFlightRef.current || !hasMoreOlder) return;
		inFlightRef.current = true;
		setIsLoadingMore(true);
		try {
			const offset = startOffset + entries.length;
			const result = await loadPage(offset, pageSize);
			setEntries((prev) => [...prev, ...result.entries]);
			setHasMoreOlder(result.hasMore);
			setTotalCount(result.total);
		} catch (err) {
			logger.error('loadMoreOlder failed', LOG_CONTEXT, err);
			setHasMoreOlder(false);
		} finally {
			inFlightRef.current = false;
			setIsLoadingMore(false);
		}
	}, [hasMoreOlder, startOffset, entries.length, loadPage, pageSize]);

	const jumpToOffset = useCallback(
		async (targetOffset: number) => {
			if (inFlightRef.current) return;
			inFlightRef.current = true;
			setIsJumping(true);
			try {
				const pageStart = Math.max(0, Math.floor(targetOffset / pageSize) * pageSize);
				const result = await loadPage(pageStart, pageSize);
				setEntries(result.entries);
				setStartOffset(pageStart);
				setHasMoreOlder(result.hasMore);
				setTotalCount(result.total);
			} catch (err) {
				logger.error('jumpToOffset failed', LOG_CONTEXT, err);
			} finally {
				inFlightRef.current = false;
				setIsJumping(false);
			}
		},
		[loadPage, pageSize]
	);

	const jumpToTop = useCallback(async () => {
		await jumpToOffset(0);
	}, [jumpToOffset]);

	const prependLiveEntry = useCallback((entry: T): boolean => {
		// Only safe at the top — anywhere else and we'd be inserting an
		// entry into an arbitrary page slice, breaking offset semantics.
		if (startOffsetRef.current !== 0) return false;
		const id = getEntryIdRef.current(entry);
		setEntries((prev) => {
			if (prev.some((e) => getEntryIdRef.current(e) === id)) return prev;
			return [entry, ...prev];
		});
		setTotalCount((t) => t + 1);
		return true;
	}, []);

	const mutateEntries = useCallback((mutator: (current: T[]) => T[]) => {
		setEntries((prev) => mutator(prev));
	}, []);

	return {
		entries,
		startOffset,
		totalCount,
		hasMoreOlder,
		isLoading,
		isLoadingMore,
		isJumping,
		isAtTop: startOffset === 0,
		loadMoreOlder,
		jumpToOffset,
		jumpToTop,
		prependLiveEntry,
		mutateEntries,
	};
}
