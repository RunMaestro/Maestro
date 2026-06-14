import React, { memo } from 'react';
import { PenLine, X } from 'lucide-react';
import type { Theme } from '../../../types';

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
}

export const StagedImagesStrip = memo(function StagedImagesStrip({
	isVisible,
	stagedImages,
	theme,
	setLightboxImage,
	setStagedImages,
	openAnnotator,
}: StagedImagesStripProps) {
	if (!isVisible || stagedImages.length === 0) {
		return null;
	}

	return (
		<div className="flex gap-2 mb-3 pb-2 overflow-x-auto overflow-y-visible scrollbar-thin">
			{stagedImages.map((img, idx) => (
				<div
					key={img}
					className="relative group shrink-0 flex items-center justify-center"
					style={{ minWidth: '64px' }}
				>
					<button
						type="button"
						className="p-0 bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
						onClick={() => setLightboxImage(img, stagedImages, 'staged')}
					>
						<img
							src={img}
							alt={`Staged image ${idx + 1}`}
							className="h-16 rounded border cursor-pointer hover:opacity-80 transition-opacity block"
							style={{
								borderColor: theme.colors.border,
								objectFit: 'contain',
								maxWidth: '200px',
							}}
						/>
					</button>
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							openAnnotator(img, (newDataUrl) =>
								setStagedImages((prev) => prev.map((s) => (s === img ? newDataUrl : s)))
							);
						}}
						title="Annotate image"
						aria-label="Annotate image"
						className="absolute top-0.5 left-0.5 bg-black/60 text-white rounded-full p-1 shadow-md hover:bg-black/80 transition-colors opacity-90 hover:opacity-100 outline-none focus-visible:ring-2 focus-visible:ring-white"
					>
						<PenLine className="w-3 h-3" />
					</button>
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							setStagedImages((p) => p.filter((x) => x !== img));
						}}
						title={`Remove image ${idx + 1}`}
						aria-label={`Remove image ${idx + 1}`}
						className="absolute top-0.5 right-0.5 bg-red-500 text-white rounded-full p-1 shadow-md hover:bg-red-600 transition-colors opacity-90 hover:opacity-100 outline-none focus-visible:ring-2 focus-visible:ring-white"
					>
						<X className="w-3 h-3" />
					</button>
				</div>
			))}
		</div>
	);
});
