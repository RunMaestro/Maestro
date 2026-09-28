import React, { memo, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import type { Theme } from '../../../types';
import { useEventListener } from '../../../hooks/utils/useEventListener';
import { OPEN_STAGED_IMAGES_ORGANIZER_EVENT } from '../../../services/stagedImagesOrganizer';
import { StagedImageTile } from './StagedImageTile';
import { useStagedImageDnd } from './stagedImageDrag';
import { StagedImagesOrganizerModal } from './StagedImagesOrganizerModal';

interface StagedImagesStripProps {
	isVisible: boolean;
	stagedImages: string[];
	theme: Theme;
	setLightboxImage: (
		image: string | null,
		contextImages?: string[],
		source?: 'staged' | 'history'
	) => void;
	setStagedImages: React.Dispatch<React.SetStateAction<string[]>>;
	openAnnotator: (image: string, onSave: (newDataUrl: string) => void) => void;
	/** Move an image, renumbering any `Screenshot N` references in the draft. */
	onReorder: (from: number, to: number) => void;
}

export const StagedImagesStrip = memo(function StagedImagesStrip({
	isVisible,
	stagedImages,
	theme,
	setLightboxImage,
	setStagedImages,
	openAnnotator,
	onReorder,
}: StagedImagesStripProps) {
	const [organizerOpen, setOrganizerOpen] = useState(false);
	const dnd = useStagedImageDnd(stagedImages.length, onReorder);

	// The openImageOrganizer shortcut (opt+cmd+y's sibling) opens the expanded
	// view from anywhere. Like the Maximize button, it only acts with more than
	// one image - a single thumbnail has nothing to compare or reorder, and the
	// lightbox (cmd+y) already covers viewing one image full-screen.
	useEventListener(OPEN_STAGED_IMAGES_ORGANIZER_EVENT, () => {
		if (isVisible && stagedImages.length > 1) setOrganizerOpen(true);
	});

	if (!isVisible || stagedImages.length === 0) {
		return null;
	}

	const removeImage = (img: string) => setStagedImages((p) => p.filter((x) => x !== img));
	const annotateImage = (img: string) =>
		openAnnotator(img, (newDataUrl) =>
			setStagedImages((prev) => prev.map((s) => (s === img ? newDataUrl : s)))
		);

	return (
		<>
			<div className="flex items-center gap-2 mb-3">
				{/* The organizer exists to compare thumbnails and reorder them, and a
				    single image can do neither. Offering it there is a button that
				    opens a modal with nothing to do in it. */}
				{stagedImages.length > 1 && (
					<button
						type="button"
						onClick={() => setOrganizerOpen(true)}
						title="Open image organizer"
						aria-label="Open image organizer"
						className="shrink-0 self-center p-1.5 rounded border transition-colors hover:opacity-80 outline-none focus-visible:ring-2 focus-visible:ring-accent"
						style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
					>
						<Maximize2 className="w-4 h-4" />
					</button>
				)}

				<div
					className="flex gap-2 pb-2 flex-1 overflow-x-auto overflow-y-visible scrollbar-thin"
					{...dnd.containerHandlers}
				>
					{stagedImages.map((img, idx) => (
						<StagedImageTile
							key={img}
							image={img}
							index={idx}
							theme={theme}
							size="strip"
							// The number is how you name an image in the message
							// ("annotate screenshot 3"), so it stays visible whenever
							// there is more than one to pick from. A lone thumbnail
							// needs no label, but it still gets one mid-drag to answer
							// "which slot am I aiming at".
							showSlotNumber={stagedImages.length > 1 || dnd.isDragging}
							isDragging={dnd.dragIndex === idx}
							isDimmed={dnd.isDragging && dnd.dragIndex !== idx}
							dropBefore={dnd.dropGap === idx}
							dropAfter={dnd.dropGap === idx + 1 && idx === stagedImages.length - 1}
							dragHandlers={dnd.tileHandlers(idx)}
							onOpen={() => setLightboxImage(img, stagedImages, 'staged')}
							onAnnotate={() => annotateImage(img)}
							onRemove={() => removeImage(img)}
						/>
					))}
				</div>
			</div>

			{organizerOpen && (
				<StagedImagesOrganizerModal
					theme={theme}
					stagedImages={stagedImages}
					onClose={() => setOrganizerOpen(false)}
					onReorder={onReorder}
					onRemove={removeImage}
					onAnnotate={annotateImage}
					setLightboxImage={setLightboxImage}
				/>
			)}
		</>
	);
});
