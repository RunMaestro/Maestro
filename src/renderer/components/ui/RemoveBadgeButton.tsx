/**
 * RemoveBadgeButton - the small red X that takes an attachment off a message
 * before it is sent: a staged image's thumbnail, a Design Mode chip.
 *
 * One look for "remove this attachment", so a chip and a thumbnail in the same
 * composer cannot drift apart. The call site places it (`className`): the image
 * tile overlays it on the thumbnail's corner, a chip puts it at the end of its
 * row. The click never reaches the element underneath, which is clickable too
 * (open the lightbox, open the chip).
 *
 * A centering flex box, like `GhostIconButton`, so the circle is the icon plus
 * its padding wherever it sits, rather than a line box that grows with the
 * inherited font size and rides the baseline in a row.
 *
 * Usage:
 * ```tsx
 * <RemoveBadgeButton label="Remove image 2" onRemove={remove} className="absolute top-0.5 right-0.5" />
 * ```
 */

import { X } from 'lucide-react';

export interface RemoveBadgeButtonProps {
	/** Tooltip and accessible name, e.g. `Remove image 2`. */
	label: string;
	onRemove: () => void;
	/** Placement from the call site (`absolute top-0.5 right-0.5`, `shrink-0`). */
	className?: string;
	testId?: string;
}

export function RemoveBadgeButton({
	label,
	onRemove,
	className = '',
	testId,
}: RemoveBadgeButtonProps) {
	return (
		<button
			type="button"
			// A staged image tile is a drag source: pressing its X must not start a drag.
			draggable={false}
			onClick={(e) => {
				e.stopPropagation();
				onRemove();
			}}
			title={label}
			aria-label={label}
			className={`inline-flex items-center justify-center bg-red-500 text-white rounded-full p-1 shadow-md hover:bg-red-600 transition-colors opacity-90 hover:opacity-100 outline-none focus-visible:ring-2 focus-visible:ring-white ${className}`}
			data-testid={testId}
		>
			<X className="w-3 h-3" />
		</button>
	);
}
