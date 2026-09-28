import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import type { TextareaSizeKey } from '../../utils/textareaSizing';
import { clampTextareaHeight, resolveTextareaHeight } from '../../utils/textareaSizing';
import { useDebouncedCallback } from '../utils/useThrottle';

const RESIZE_PERSIST_DEBOUNCE_MS = 300;

export interface UseResizableTextareaOptions {
	/** Stable key the remembered height is stored under. */
	sizeKey: TextareaSizeKey;
	/**
	 * Height to use before the user has ever dragged the grip. Omit to leave the
	 * textarea at whatever its `rows` / CSS min-height already give it.
	 */
	defaultHeight?: number;
	/** Smallest height a remembered value is allowed to be. */
	minHeight?: number;
	maxHeight?: number;
	enabled?: boolean;
	/** Use when the caller already owns a ref on the textarea. */
	externalRef?: RefObject<HTMLTextAreaElement>;
}

export interface UseResizableTextareaReturn {
	textareaRef: RefObject<HTMLTextAreaElement>;
	/** Remembered height in px, or null while the textarea sizes itself. */
	height: number | null;
	/** Spread onto the textarea's `style` prop, after the caller's own styles. */
	style: CSSProperties;
}

/**
 * Remembers the height a user drags a `resize-y` textarea to and restores it on
 * the next mount, including after an app restart. A size the user picked by
 * hand is a preference, not a transient bit of layout state.
 *
 * The native grip writes the dragged height straight onto the element's inline
 * `style.height`, which is the same property this hook writes when it applies a
 * remembered height. So the observer only has to compare the element's current
 * inline height against the last one applied: any difference is the user's
 * drag. Nothing else moves it (content, font size and viewport width don't
 * change an explicit height), so there is no feedback loop to break.
 */
export function useResizableTextarea({
	sizeKey,
	defaultHeight,
	minHeight,
	maxHeight,
	enabled = true,
	externalRef,
}: UseResizableTextareaOptions): UseResizableTextareaReturn {
	const internalRef = useRef<HTMLTextAreaElement>(null) as RefObject<HTMLTextAreaElement>;
	const textareaRef = externalRef ?? internalRef;
	const savedHeight = useSettingsStore((state) => state.textareaHeights[sizeKey]);
	const setTextareaHeight = useSettingsStore((state) => state.setTextareaHeight);

	const [height, setHeight] = useState<number | null>(() =>
		resolveTextareaHeight({ savedHeight, defaultHeight, minHeight, maxHeight })
	);
	// The height currently written to the element, so the observer can tell our
	// own writes apart from the user dragging the grip.
	const appliedHeightRef = useRef<number | null>(height);

	// Settings load asynchronously, so `savedHeight` normally arrives a beat
	// after the first render. Re-resolving here is what restores the remembered
	// height on app start.
	useEffect(() => {
		if (!enabled) return;
		setHeight(resolveTextareaHeight({ savedHeight, defaultHeight, minHeight, maxHeight }));
	}, [defaultHeight, enabled, maxHeight, minHeight, savedHeight]);

	useEffect(() => {
		const element = textareaRef.current;
		if (!element || !enabled || height === null) return;
		element.style.height = `${height}px`;
		appliedHeightRef.current = height;
	}, [enabled, height, textareaRef]);

	const { debouncedCallback: persistHeight } = useDebouncedCallback((...args: unknown[]) => {
		const [key, next] = args as [TextareaSizeKey, number];
		setTextareaHeight(key, next);
	}, RESIZE_PERSIST_DEBOUNCE_MS);

	useEffect(() => {
		const element = textareaRef.current;
		if (!element || !enabled || typeof ResizeObserver === 'undefined') return;

		const observer = new ResizeObserver(() => {
			const inlineHeight = parseFloat(element.style.height);
			// No inline height means the user has never dragged the grip and no
			// remembered height has been applied - nothing to record yet.
			if (!Number.isFinite(inlineHeight)) return;
			if (
				appliedHeightRef.current !== null &&
				Math.abs(inlineHeight - appliedHeightRef.current) < 1
			) {
				return;
			}

			const next = clampTextareaHeight(inlineHeight, { minHeight, maxHeight });
			// Claim the new height right away so an in-progress drag doesn't
			// re-enter on every observed frame; the clamped value is written back
			// to the element by the apply effect above.
			appliedHeightRef.current = next;
			setHeight(next);
			persistHeight(sizeKey, next);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [enabled, maxHeight, minHeight, persistHeight, sizeKey, textareaRef]);

	const style = useMemo<CSSProperties>(
		() => (enabled && height !== null ? { height: `${height}px` } : {}),
		[enabled, height]
	);

	return { textareaRef, height, style };
}
