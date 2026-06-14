import { useCallback, useEffect, useRef, useState } from 'react';
import { useClickOutside } from '../../../hooks/ui/useClickOutside';
import type { BadgeEscapeHandlerRegistrar } from '../types';

export function useBadgeTooltipState(onEscapeWithBadgeOpen?: BadgeEscapeHandlerRegistrar) {
	const [selectedBadge, setSelectedBadge] = useState<number | null>(null);
	const badgeContainerRef = useRef<HTMLDivElement>(null);

	const closeSelectedBadge = useCallback(() => {
		setSelectedBadge(null);
	}, []);

	const toggleBadge = useCallback((level: number) => {
		setSelectedBadge((current) => (current === level ? null : level));
	}, []);

	useEffect(() => {
		if (!onEscapeWithBadgeOpen) return;

		if (selectedBadge === null) {
			onEscapeWithBadgeOpen(null);
			return;
		}

		onEscapeWithBadgeOpen(() => {
			setSelectedBadge(null);
			return true;
		});

		return () => {
			onEscapeWithBadgeOpen(null);
		};
	}, [selectedBadge, onEscapeWithBadgeOpen]);

	useClickOutside(badgeContainerRef, closeSelectedBadge, selectedBadge !== null, {
		delay: true,
		eventType: 'click',
	});

	return {
		selectedBadge,
		badgeContainerRef,
		toggleBadge,
		closeSelectedBadge,
	};
}
