/**
 * Staged Images organizer: the same strip at a size you can actually read.
 *
 * Reordering here is the identical `onReorder` the strip uses, so a move made
 * in the modal renumbers `Screenshot N` references in the draft exactly as a
 * move made in the composer would.
 */

import { createPortal } from 'react-dom';
import type { Theme } from '../../../types';
import { MODAL_PRIORITIES } from '../../../constants/modalPriorities';
import { useModalLayer } from '../../../hooks/ui/useModalLayer';
import { EscCloseButton } from '../../ui/EscCloseButton';
import { StagedImageTile } from './StagedImageTile';
import { useStagedImageDnd } from './stagedImageDrag';

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
					<EscCloseButton theme={theme} onClose={onClose} />
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
