import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseAutoScrollToBottomOptions {
	containerRef: React.RefObject<HTMLElement>;
	/** Values whose updates may add or reflow content. */
	contentDependencies: readonly unknown[];
	/** Changing this value starts a new stream and unlocks auto-scroll. */
	resetKey?: unknown;
	bottomThreshold?: number;
	enabled?: boolean;
}

export interface UseAutoScrollToBottomReturn {
	isUserScrolledUp: boolean;
	handleScroll: () => void;
	resumeAutoScroll: () => void;
	forceScrollToBottom: () => void;
}

/**
 * Keeps a streaming surface pinned to its bottom until the user deliberately
 * reads history. Content and container resizes obey that lock; callers can
 * explicitly reset it for a new user-authored message or stream.
 */
export function useAutoScrollToBottom({
	containerRef,
	contentDependencies,
	resetKey,
	bottomThreshold = 50,
	enabled = true,
}: UseAutoScrollToBottomOptions): UseAutoScrollToBottomReturn {
	const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
	const userScrolledUpRef = useRef(false);
	const animationFrameRef = useRef<number | null>(null);
	const resetKeyRef = useRef(resetKey);

	const setUserScrolledUp = useCallback((next: boolean) => {
		userScrolledUpRef.current = next;
		setIsUserScrolledUp((current) => (current === next ? current : next));
	}, []);

	const scrollToBottom = useCallback(() => {
		const container = containerRef.current;
		if (!container) return;
		container.scrollTo({ top: container.scrollHeight, behavior: 'auto' });
	}, [containerRef]);

	const scheduleAutoScroll = useCallback(() => {
		if (!enabled || userScrolledUpRef.current) return;
		if (animationFrameRef.current !== null) {
			cancelAnimationFrame(animationFrameRef.current);
		}
		animationFrameRef.current = requestAnimationFrame(() => {
			animationFrameRef.current = null;
			if (!userScrolledUpRef.current) {
				scrollToBottom();
			}
		});
	}, [enabled, scrollToBottom]);

	const handleScroll = useCallback(() => {
		const container = containerRef.current;
		if (!container) return;
		const distanceFromBottom =
			container.scrollHeight - container.scrollTop - container.clientHeight;
		setUserScrolledUp(distanceFromBottom > bottomThreshold);
	}, [bottomThreshold, containerRef, setUserScrolledUp]);

	const resumeAutoScroll = useCallback(() => {
		setUserScrolledUp(false);
		scrollToBottom();
	}, [scrollToBottom, setUserScrolledUp]);

	const forceScrollToBottom = useCallback(() => {
		setUserScrolledUp(false);
		scrollToBottom();
	}, [scrollToBottom, setUserScrolledUp]);

	useEffect(() => {
		if (resetKeyRef.current !== resetKey) {
			resetKeyRef.current = resetKey;
			setUserScrolledUp(false);
		}
		scheduleAutoScroll();
	}, [resetKey, scheduleAutoScroll, setUserScrolledUp]);

	useEffect(() => {
		scheduleAutoScroll();
	}, [scheduleAutoScroll, ...contentDependencies]);

	useEffect(() => {
		if (!enabled || !containerRef.current || typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(scheduleAutoScroll);
		observer.observe(containerRef.current);
		return () => observer.disconnect();
	}, [containerRef, enabled, scheduleAutoScroll]);

	useEffect(() => {
		return () => {
			if (animationFrameRef.current !== null) {
				cancelAnimationFrame(animationFrameRef.current);
			}
		};
	}, []);

	return { isUserScrolledUp, handleScroll, resumeAutoScroll, forceScrollToBottom };
}
