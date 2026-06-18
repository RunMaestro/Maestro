import { ChevronDown, ChevronRight } from 'lucide-react';
import type { Theme } from '../../../../../types';
import type { DocumentAttachment } from '../types';
import { ImagePreview } from './ImagePreview';

interface AttachmentStripProps {
	attachments: DocumentAttachment[];
	attachmentsExpanded: boolean;
	setAttachmentsExpanded: (expanded: boolean) => void;
	theme: Theme;
	onRemoveAttachment: (filename: string) => void;
}

export function AttachmentStrip({
	attachments,
	attachmentsExpanded,
	setAttachmentsExpanded,
	theme,
	onRemoveAttachment,
}: AttachmentStripProps): JSX.Element | null {
	if (attachments.length === 0) return null;

	return (
		<div className="px-2 py-2 mb-2 rounded" style={{ backgroundColor: theme.colors.bgActivity }}>
			<button
				onClick={() => setAttachmentsExpanded(!attachmentsExpanded)}
				className="w-full flex items-center gap-1 text-[10px] uppercase font-semibold hover:opacity-80 transition-opacity"
				style={{ color: theme.colors.textDim }}
			>
				{attachmentsExpanded ? (
					<ChevronDown className="w-3 h-3" />
				) : (
					<ChevronRight className="w-3 h-3" />
				)}
				Attached Images ({attachments.length})
			</button>
			{attachmentsExpanded && (
				<div className="flex flex-wrap gap-1 mt-2">
					{attachments.map((attachment) => (
						<ImagePreview
							key={attachment.filename}
							src={attachment.dataUrl}
							filename={attachment.filename}
							theme={theme}
							onRemove={() => onRemoveAttachment(attachment.filename)}
						/>
					))}
				</div>
			)}
		</div>
	);
}
