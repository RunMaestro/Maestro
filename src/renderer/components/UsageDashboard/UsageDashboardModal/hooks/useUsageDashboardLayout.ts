import { useMemo, type RefObject } from 'react';
import { useElementWidth } from '../../../../hooks/ui/useElementWidth';
import type { UsageDashboardLayout } from '../types';

export function useUsageDashboardLayout(
	isOpen: boolean,
	contentRef: RefObject<HTMLDivElement | null>
): UsageDashboardLayout {
	// Drives the responsive breakpoints below. Only measured while open, since a
	// closed modal has no laid-out content to observe.
	const containerWidth = useElementWidth(contentRef, isOpen);

	return useMemo(() => {
		// A phone's content column is ~340px once the modal's own padding is off.
		// Two metric cards there leave each one about 90px of text, which is
		// narrower than the figures they carry, so this rung drops them to one
		// column rather than letting every card wrap its number onto three lines.
		const isTiny = containerWidth > 0 && containerWidth < 440;
		const isNarrow = containerWidth > 0 && containerWidth < 600;
		const isMedium = containerWidth >= 600 && containerWidth < 900;
		const isWide = containerWidth >= 900;

		return {
			isTiny,
			isNarrow,
			isMedium,
			isWide,
			chartGridCols: isNarrow ? 1 : 2,
			summaryCardsCols: isTiny ? 1 : isNarrow ? 2 : 3,
			// Same rung for the Auto Run tiles, and for a sharper reason: those
			// cards TRUNCATE their value rather than wrapping it, so two columns
			// on a phone rendered "4h 3…" and "10m …" where the whole point of
			// the tile is the duration.
			autoRunStatsCols: isTiny ? 1 : isNarrow ? 2 : isMedium ? 3 : 6,
		};
	}, [containerWidth]);
}
