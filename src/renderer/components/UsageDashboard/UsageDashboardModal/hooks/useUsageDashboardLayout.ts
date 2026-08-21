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
		const isNarrow = containerWidth > 0 && containerWidth < 600;
		const isMedium = containerWidth >= 600 && containerWidth < 900;
		const isWide = containerWidth >= 900;

		return {
			isNarrow,
			isMedium,
			isWide,
			chartGridCols: isNarrow ? 1 : 2,
			summaryCardsCols: isNarrow ? 2 : 3,
			autoRunStatsCols: isNarrow ? 2 : isMedium ? 3 : 6,
		};
	}, [containerWidth]);
}
