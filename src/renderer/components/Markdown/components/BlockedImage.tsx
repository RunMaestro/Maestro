/**
 * BlockedImage - the stand-in a markdown surface draws where it chose not to
 * load an image: a remote image while File Preview's remote-image toggle is
 * off, or any image in text from someone outside this computer (a Sketch Book
 * guest), where loading it would tell the author this computer's address or
 * read a local file on their say-so.
 */

import { Image } from 'lucide-react';
import type { Theme } from '../../../types';

export interface BlockedImageProps {
	theme: Theme;
	label: string;
	/** Hover text, e.g. the address the image would have come from. */
	title?: string;
}

export function BlockedImage({ theme, label, title }: BlockedImageProps) {
	return (
		<span
			className="inline-flex items-center gap-2 px-3 py-2 rounded my-2"
			style={{
				backgroundColor: theme.colors.bgActivity,
				border: `1px dashed ${theme.colors.border}`,
			}}
			title={title}
		>
			<Image className="w-4 h-4" style={{ color: theme.colors.textDim }} />
			<span className="text-xs" style={{ color: theme.colors.textDim }}>
				{label}
			</span>
		</span>
	);
}
