import { useCallback, useRef } from 'react';
import type { ResizeStartEvent } from './usePointerResize';
import { usePointerResize } from './usePointerResize';

export interface UseResizablePanelOptions {
	width: number;
	minWidth: number;
	maxWidth: number;
	settingsKey: string;
	setWidth: (width: number) => void;
	side: 'left' | 'right';
	externalRef?: React.RefObject<HTMLDivElement>;
}

export interface UseResizablePanelReturn {
	panelRef: React.RefObject<HTMLDivElement>;
	isResizing: boolean;
	onResizeStart: (event: ResizeStartEvent<HTMLElement>) => void;
	transitionClass: string;
}

export function useResizablePanel({
	width,
	minWidth,
	maxWidth,
	settingsKey,
	setWidth,
	side,
	externalRef,
}: UseResizablePanelOptions): UseResizablePanelReturn {
	const internalRef = useRef<HTMLDivElement>(null) as React.RefObject<HTMLDivElement>;
	const panelRef = externalRef ?? internalRef;
	const { isResizing, startResize } = usePointerResize<number>();

	const onResizeStart = useCallback(
		(event: ResizeStartEvent<HTMLElement>) => {
			const startWidth = width;
			startResize(event, {
				value: startWidth,
				getNextValue: (_initialWidth, deltaX) => {
					const signedDelta = side === 'left' ? deltaX : -deltaX;
					return Math.max(minWidth, Math.min(maxWidth, startWidth + signedDelta));
				},
				onResize: (currentWidth) => {
					if (panelRef.current) {
						panelRef.current.style.width = `${currentWidth}px`;
					}
				},
				onComplete: (currentWidth) => {
					setWidth(currentWidth);
					window.maestro.settings.set(settingsKey, currentWidth);
				},
			});
		},
		[maxWidth, minWidth, panelRef, settingsKey, setWidth, side, startResize, width]
	);

	return {
		panelRef,
		isResizing,
		onResizeStart,
		transitionClass: isResizing ? 'transition-none' : 'transition-[width] duration-150',
	};
}
