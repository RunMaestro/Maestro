import { X } from 'lucide-react';
import type { Theme } from '../../../../../types';

interface ImagePreviewProps {
	src: string;
	filename: string;
	theme: Theme;
	onRemove: () => void;
}

export function ImagePreview({ src, filename, theme, onRemove }: ImagePreviewProps): JSX.Element {
	return (
		<div className="relative inline-block group" style={{ margin: '4px' }}>
			<img
				src={src}
				alt={filename}
				className="w-20 h-20 object-cover rounded hover:opacity-80 transition-opacity"
				style={{ border: `1px solid ${theme.colors.border}` }}
			/>
			<button
				onClick={(event) => {
					event.stopPropagation();
					onRemove();
				}}
				className="absolute -top-2 -right-2 w-5 h-5 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-opacity focus:outline-none focus:ring-2 focus:ring-offset-1"
				style={{
					backgroundColor: theme.colors.error,
					color: 'white',
					['--tw-ring-color' as any]: theme.colors.error,
					['--tw-ring-offset-color' as any]: theme.colors.bgMain,
				}}
				title="Remove image"
				aria-label={`Remove image ${filename}`}
			>
				<X className="w-3 h-3" />
			</button>
			<div
				className="absolute bottom-0 left-0 right-0 px-1 py-0.5 text-[9px] truncate rounded-b"
				style={{
					backgroundColor: 'rgba(0,0,0,0.6)',
					color: 'white',
				}}
			>
				{filename}
			</div>
		</div>
	);
}
