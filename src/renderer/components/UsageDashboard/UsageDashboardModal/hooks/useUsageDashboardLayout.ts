import { useEffect, useMemo, useState, type RefObject } from 'react';
import type { UsageDashboardLayout } from '../types';

export function useUsageDashboardLayout(
	isOpen: boolean,
	contentRef: RefObject<HTMLDivElement | null>
): UsageDashboardLayout {
	const [containerWidth, setContainerWidth] = useState(0);

	useEffect(() => {
		if (!isOpen || !contentRef.current) return;

		const updateWidth = () => {
			if (contentRef.current) {
				setContainerWidth(contentRef.current.offsetWidth);
			}
		};

		updateWidth();

		const resizeObserver = new ResizeObserver(updateWidth);
		resizeObserver.observe(contentRef.current);

		return () => resizeObserver.disconnect();
	}, [isOpen, contentRef]);

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
