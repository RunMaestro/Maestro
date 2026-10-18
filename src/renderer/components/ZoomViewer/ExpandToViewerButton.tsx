/**
 * ExpandToViewerButton - the corner button that opens a diagram or image in the
 * full-screen ZoomViewerOverlay.
 *
 * Sits absolutely in the top-right of a `relative group` wrapper and fades in
 * on hover or keyboard focus, so it never covers the content while reading.
 * `resolveTarget` runs at click time: Mermaid injects its `<svg>` imperatively
 * after render, so the element does not exist when this button renders.
 */

import type { MouseEvent } from 'react';
import { Maximize2 } from 'lucide-react';
import type { Theme } from '../../types';
import type { ExportableImage } from '../../utils/imageExport';
import { openZoomViewer } from './zoomViewerStore';

interface ExpandToViewerButtonProps {
	theme: Theme;
	resolveTarget: () => ExportableImage | null | undefined;
	/** Viewer header text. */
	title?: string;
	label?: string;
}

export function ExpandToViewerButton({
	theme,
	resolveTarget,
	title,
	label = 'Expand (pan and zoom)',
}: ExpandToViewerButtonProps) {
	const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
		// Images can sit inside links and clickable rows; the button is not a
		// click on whatever is underneath it.
		e.preventDefault();
		e.stopPropagation();
		const target = resolveTarget();
		if (target) openZoomViewer(target, title);
	};

	return (
		<button
			type="button"
			onClick={handleClick}
			onMouseDown={(e) => e.stopPropagation()}
			title={label}
			aria-label={label}
			data-testid="expand-to-viewer"
			className="absolute top-2 right-2 z-10 p-1.5 rounded border opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
			style={{
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
				color: theme.colors.textMain,
			}}
		>
			<Maximize2 className="w-3.5 h-3.5" />
		</button>
	);
}
