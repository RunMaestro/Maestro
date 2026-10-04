/**
 * useToastAvoidZone - keep toast notifications off a region the user works in.
 *
 * In a bottom corner, the toast stack sits over a side bar when that bar is
 * open, but with it closed (or narrow) the corner is the composer, and a toast
 * covers the text the user is typing.
 *
 * A surface marks itself as an avoid zone by attaching the returned callback
 * ref. Its rect is tracked in a small store; `ToastContainer` reads it through
 * {@link toastBottomInset} and lifts the whole stack above any zone it overlaps
 * horizontally. A zone the stack does not overlap moves nothing, so the Right
 * Bar case keeps the toasts flush with the window bottom.
 *
 * ```tsx
 * const avoidRef = useToastAvoidZone();
 * return <div ref={avoidRef}><InputArea ... /></div>;
 * ```
 */

import { useEffect, useId, useState } from 'react';
import { create } from 'zustand';

export interface ToastAvoidRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

interface ToastAvoidZoneStore {
	zones: Record<string, ToastAvoidRect>;
	setZone: (id: string, rect: ToastAvoidRect | null) => void;
}

const sameRect = (a: ToastAvoidRect | undefined, b: ToastAvoidRect): boolean =>
	!!a && a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;

export const useToastAvoidZoneStore = create<ToastAvoidZoneStore>()((set) => ({
	zones: {},
	setZone: (id, rect) =>
		set((s) => {
			if (rect === null) {
				if (!(id in s.zones)) return s;
				const { [id]: _removed, ...rest } = s.zones;
				return { zones: rest };
			}
			// ResizeObserver fires on every composer resize; skip no-op writes so
			// the toast stack does not re-render for an unchanged rect.
			if (sameRect(s.zones[id], rect)) return s;
			return { zones: { ...s.zones, [id]: rect } };
		}),
}));

/**
 * Distance (px) the toast stack must sit above the window bottom to clear every
 * zone it overlaps horizontally. 0 when nothing overlaps. Zones with no height
 * (a hidden element) are ignored.
 */
export function toastBottomInset(
	zones: Record<string, ToastAvoidRect>,
	stack: { left: number; right: number },
	viewportHeight: number
): number {
	let inset = 0;
	for (const zone of Object.values(zones)) {
		if (zone.bottom <= zone.top) continue;
		if (zone.right <= stack.left || zone.left >= stack.right) continue;
		inset = Math.max(inset, viewportHeight - zone.top);
	}
	return inset;
}

export function useToastAvoidZone(): (element: HTMLElement | null) => void {
	const id = useId();
	const [element, setElement] = useState<HTMLElement | null>(null);

	useEffect(() => {
		if (!element) return;
		const { setZone } = useToastAvoidZoneStore.getState();
		const measure = () => {
			const r = element.getBoundingClientRect();
			setZone(id, { left: r.left, top: r.top, right: r.right, bottom: r.bottom });
		};
		measure();

		// A window resize can move the element without resizing it (a taller
		// window drops the composer lower), so ResizeObserver alone misses it.
		window.addEventListener('resize', measure);
		// jsdom has no ResizeObserver; the initial measure is enough there.
		const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
		observer?.observe(element);
		return () => {
			window.removeEventListener('resize', measure);
			observer?.disconnect();
			setZone(id, null);
		};
	}, [element, id]);

	return setElement;
}
