import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';

export interface OverlayPosition {
	top: number;
	left: number;
	tabWidth?: number;
}

export interface UseTabHoverOverlayOptions {
	/** Optional guard — return false to skip opening the overlay on hover */
	shouldOpen?: () => boolean;
	/** Optional parent ref registration callback (merged with internal tabRef) */
	registerRef?: (el: HTMLDivElement | null) => void;
}

export interface UseTabHoverOverlayReturn {
	isHovered: boolean;
	setIsHovered: React.Dispatch<React.SetStateAction<boolean>>;
	overlayOpen: boolean;
	setOverlayOpen: React.Dispatch<React.SetStateAction<boolean>>;
	overlayPosition: OverlayPosition | null;
	tabRef: React.RefObject<HTMLDivElement | null>;
	hoverTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
	isOverOverlayRef: React.MutableRefObject<boolean>;
	/** Ref callback to attach to the portal overlay div for viewport clamping */
	setOverlayRef: (el: HTMLDivElement | null) => void;
	/** False until the overlay has been measured and clamped to the viewport */
	positionReady: boolean;
	/** Combined ref callback — sets internal tabRef and calls parent registerRef */
	setTabRef: (el: HTMLDivElement | null) => void;
	handleMouseEnter: () => void;
	handleMouseLeave: () => void;
	/** onMouseEnter for the portal overlay div */
	overlayMouseEnter: () => void;
	/** onMouseLeave for the portal overlay div */
	overlayMouseLeave: () => void;
}

/**
 * Shared hover/overlay state and timing logic for tab components.
 * Manages the 400ms open delay, 100ms close delay, and portal mouse tracking
 * that is identical across AITab, FileTab, and TerminalTabItem.
 */
export function useTabHoverOverlay(options?: UseTabHoverOverlayOptions): UseTabHoverOverlayReturn {
	const [isHovered, setIsHovered] = useState(false);
	const [overlayOpen, setOverlayOpen] = useState(false);
	const [overlayPosition, setOverlayPosition] = useState<OverlayPosition | null>(null);
	const [positionReady, setPositionReady] = useState(false);
	const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const tabRef = useRef<HTMLDivElement | null>(null);
	const overlayRef = useRef<HTMLDivElement | null>(null);
	const isOverOverlayRef = useRef(false);

	// Stabilize registerRef in a ref so setTabRef doesn't recreate on every render
	const registerRefRef = useRef(options?.registerRef);
	useEffect(() => {
		registerRefRef.current = options?.registerRef;
	});

	const setTabRef = useCallback((el: HTMLDivElement | null) => {
		tabRef.current = el;
		registerRefRef.current?.(el);
	}, []);

	// Clear any pending timeout on unmount to prevent state updates after unmount
	useEffect(() => {
		return () => {
			if (hoverTimeoutRef.current) {
				clearTimeout(hoverTimeoutRef.current);
				hoverTimeoutRef.current = null;
			}
		};
	}, []);

	const handleMouseEnter = useCallback(() => {
		setIsHovered(true);
		if (options?.shouldOpen && !options.shouldOpen()) return;
		// Clear any pending close timer so it doesn't fire while we're opening
		if (hoverTimeoutRef.current) {
			clearTimeout(hoverTimeoutRef.current);
			hoverTimeoutRef.current = null;
		}
		hoverTimeoutRef.current = setTimeout(() => {
			if (tabRef.current) {
				const rect = tabRef.current.getBoundingClientRect();
				setOverlayPosition({ top: rect.bottom, left: rect.left, tabWidth: rect.width });
			}
			setOverlayOpen(true);
		}, 400);
	}, [options?.shouldOpen]);

	const handleMouseLeave = useCallback(() => {
		setIsHovered(false);
		if (hoverTimeoutRef.current) {
			clearTimeout(hoverTimeoutRef.current);
			hoverTimeoutRef.current = null;
		}
		hoverTimeoutRef.current = setTimeout(() => {
			if (!isOverOverlayRef.current) {
				setOverlayOpen(false);
			}
		}, 100);
	}, []);

	const overlayMouseEnter = useCallback(() => {
		isOverOverlayRef.current = true;
		if (hoverTimeoutRef.current) {
			clearTimeout(hoverTimeoutRef.current);
			hoverTimeoutRef.current = null;
		}
	}, []);

	const overlayMouseLeave = useCallback(() => {
		isOverOverlayRef.current = false;
		setOverlayOpen(false);
		setIsHovered(false);
	}, []);

	// Reset positionReady when overlay closes
	useEffect(() => {
		if (!overlayOpen) setPositionReady(false);
	}, [overlayOpen]);

	// Measure overlay and clamp to viewport before paint
	useLayoutEffect(() => {
		const el = overlayRef.current;
		if (!overlayOpen || !overlayPosition || !el) return;

		const { width, height } = el.getBoundingClientRect();
		const padding = 8;
		const maxLeft = window.innerWidth - width - padding;
		const maxTop = window.innerHeight - height - padding;

		const clampedLeft = Math.max(padding, Math.min(overlayPosition.left, maxLeft));
		const clampedTop = Math.max(padding, Math.min(overlayPosition.top, maxTop));

		if (clampedLeft !== overlayPosition.left || clampedTop !== overlayPosition.top) {
			setOverlayPosition({
				top: clampedTop,
				left: clampedLeft,
				tabWidth: overlayPosition.tabWidth,
			});
		}
		setPositionReady(true);
	}, [overlayOpen, overlayPosition]);

	return {
		isHovered,
		setIsHovered,
		overlayOpen,
		setOverlayOpen,
		overlayPosition,
		tabRef,
		hoverTimeoutRef,
		isOverOverlayRef,
		setOverlayRef: useCallback((el: HTMLDivElement | null) => {
			overlayRef.current = el;
		}, []),
		positionReady,
		setTabRef,
		handleMouseEnter,
		handleMouseLeave,
		overlayMouseEnter,
		overlayMouseLeave,
	};
}
