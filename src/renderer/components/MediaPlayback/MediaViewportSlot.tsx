import { memo, useCallback, useEffect, useRef } from 'react';

import { useMediaPlaybackStore } from '../../stores/mediaPlaybackStore';
import { useEventListener } from '../../hooks/utils/useEventListener';

interface MediaViewportSlotProps {
	/** File tab this slot belongs to. Matches the host's frame for the same tab. */
	tabId: string;
}

/**
 * Placeholder that reserves the file preview's content area for a media tab and
 * tells MediaPlaybackHost where to park the actual player.
 *
 * FilePreview renders this instead of the player itself, because the player has
 * to survive FilePreview unmounting on every tab switch (see MediaPlaybackHost).
 * Keeping the slot here rather than letting the host cover the whole panel is
 * what preserves the preview's header - breadcrumbs, toolbar, and close button
 * still belong to the tab.
 */
export const MediaViewportSlot = memo(function MediaViewportSlot({
	tabId,
}: MediaViewportSlotProps) {
	const ref = useRef<HTMLDivElement>(null);
	const setSlotRect = useMediaPlaybackStore((s) => s.setSlotRect);
	const hideSlot = useMediaPlaybackStore((s) => s.hideSlot);
	const setActiveTab = useMediaPlaybackStore((s) => s.setActiveTab);

	// Looking at a media tab claims the single player, so a visible media tab is
	// always the one loaded. Without this, viewing file B while A floats would
	// leave B's tab showing an empty slot. No autoplay: merely arriving at a tab
	// is not a request to make noise (opening the file is, and that path sets its
	// own autoplay flag).
	useEffect(() => {
		setActiveTab(tabId);
	}, [tabId, setActiveTab]);

	const publish = useCallback(() => {
		const el = ref.current;
		if (!el) return;
		const r = el.getBoundingClientRect();
		// A collapsed rect means the panel is mid-layout; publishing it would
		// briefly zero-size the video and can cost the decode pipeline.
		if (r.width <= 0 || r.height <= 0) return;
		setSlotRect(tabId, { top: r.top, left: r.left, width: r.width, height: r.height });
	}, [tabId, setSlotRect]);

	useEffect(() => {
		publish();
		const el = ref.current;
		if (!el) return;
		// Catches sidebar drags, window resizes, and tab bar reflows - all of which
		// resize this element because it is a flex child of the panel.
		const observer = new ResizeObserver(publish);
		observer.observe(el);
		return () => {
			observer.disconnect();
			// Mark off screen rather than forgetting the rect: the host keeps the
			// element mounted at its last size so playback continues.
			hideSlot(tabId);
		};
	}, [tabId, publish, hideSlot]);

	// Window resize can move the slot without changing its own box (e.g. a
	// chrome-height change), which ResizeObserver would miss.
	useEventListener('resize', publish);

	return <div ref={ref} className="flex-1 min-h-0" data-media-slot={tabId} />;
});
