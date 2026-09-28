/**
 * Staged Images organizer: the same strip at a size you can actually read.
 *
 * Reordering here is the identical `onReorder` the strip uses, so a move made
 * in the modal renumbers `Screenshot N` references in the draft exactly as a
 * move made in the composer would.
 */

import { createPortal } from 'react-dom';
import { ZoomIn, ZoomOut } from 'lucide-react';
import type { Theme } from '../../../types';
import { MODAL_PRIORITIES } from '../../../constants/modalPriorities';
import { useIsTopLayer } from '../../../hooks/ui/useIsTopLayer';
import { useModalLayer } from '../../../hooks/ui/useModalLayer';
import { useScalePreference, type ScaleRange } from '../../../hooks/ui/useScalePreference';
import { useScaleShortcuts } from '../../../hooks/ui/useScaleShortcuts';
import { EscCloseButton } from '../../ui/EscCloseButton';
import { ScaleControl } from '../../ui/ScaleControl';
import { StagedImageTile } from './StagedImageTile';
import { useStagedImageDnd } from './stagedImageDrag';

// Around the 11rem preset: small enough to fit a dozen shots on screen at once,
// large enough to read a line of code in one. Persisted, because how big you
// want the thumbnails follows your display, not the message you are writing.
const THUMBNAIL_SCALE_RANGE: ScaleRange = { min: 0.6, max: 2.2, step: 0.2, initial: 1 };
const THUMBNAIL_SCALE_KEY = 'stagedImages.thumbnailScale';

interface StagedImagesOrganizerModalProps {
	theme: Theme;
	stagedImages: string[];
	onClose: () => void;
	onReorder: (from: number, to: number) => void;
	onRemove: (image: string) => void;
	onAnnotate: (image: string) => void;
	setLightboxImage: (
		image: string | null,
		contextImages?: string[],
		source?: 'staged' | 'history'
	) => void;
}

export function StagedImagesOrganizerModal({
	theme,
	stagedImages,
	onClose,
	onReorder,
	onRemove,
	onAnnotate,
	setLightboxImage,
}: StagedImagesOrganizerModalProps) {
	useModalLayer(MODAL_PRIORITIES.STAGED_IMAGES_ORGANIZER, 'Staged Images', onClose);
	const dnd = useStagedImageDnd(stagedImages.length, onReorder);
	const thumbnailScale = useScalePreference(THUMBNAIL_SCALE_KEY, THUMBNAIL_SCALE_RANGE);
	// Zoom from the keyboard, but not while the lightbox or the annotator is
	// open on top of us - both are opened from this modal and stay above it.
	const isTopLayer = useIsTopLayer(MODAL_PRIORITIES.STAGED_IMAGES_ORGANIZER);
	useScaleShortcuts(thumbnailScale, { enabled: isTopLayer });

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center select-none"
			style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
			onClick={onClose}
		>
			<div
				className="rounded-lg border shadow-2xl flex flex-col"
				style={{
					backgroundColor: theme.colors.bgMain,
					borderColor: theme.colors.border,
					width: 'min(1100px, 92vw)',
					maxHeight: '80vh',
				}}
				onClick={(e) => e.stopPropagation()}
			>
				<div
					className="flex items-center justify-between px-4 py-3 border-b"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex flex-col">
						<span className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
							Staged Images
						</span>
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							Drag to reorder. The numbers are what you can call them in your message.
						</span>
					</div>
					<div className="flex items-center gap-3">
						<ScaleControl
							theme={theme}
							control={thumbnailScale}
							decreaseIcon={ZoomOut}
							increaseIcon={ZoomIn}
							subject="thumbnail size"
							shortcutHint={{ decrease: '-', increase: '+', reset: '0' }}
							testId="staged-images-zoom"
						/>
						<EscCloseButton theme={theme} onClose={onClose} />
					</div>
				</div>

				<div className="p-4 overflow-auto">
					{stagedImages.length === 0 ? (
						<div className="text-sm py-8 text-center" style={{ color: theme.colors.textDim }}>
							No images staged.
						</div>
					) : (
						<div className="flex flex-wrap gap-4" {...dnd.containerHandlers}>
							{stagedImages.map((img, idx) => (
								<StagedImageTile
									key={img}
									image={img}
									index={idx}
									theme={theme}
									size="large"
									// Always numbered here: reading the slot off a big
									// thumbnail is the reason this view exists.
									showSlotNumber
									scale={thumbnailScale.scale}
									isDragging={dnd.dragIndex === idx}
									isDimmed={dnd.isDragging && dnd.dragIndex !== idx}
									dropBefore={dnd.dropGap === idx}
									dropAfter={dnd.dropGap === idx + 1 && idx === stagedImages.length - 1}
									dragHandlers={dnd.tileHandlers(idx)}
									onOpen={() => setLightboxImage(img, stagedImages, 'staged')}
									onAnnotate={() => onAnnotate(img)}
									onRemove={() => onRemove(img)}
								/>
							))}
						</div>
					)}
				</div>
			</div>
		</div>,
		document.body
	);
}
