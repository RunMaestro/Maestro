import { memo } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { ImagePreview } from './AttachmentImage';
import type { Theme } from '../../types';

export interface AutoRunAttachmentsPanelProps {
	theme: Theme;
	attachmentsList: string[];
	attachmentPreviews: Map<string, string>;
	attachmentsExpanded: boolean;
	onToggleExpanded: () => void;
	onRemoveAttachment: (filename: string) => void;
	onImageClick: (filename: string) => void;
	onAnnotateAttachment?: (filename: string) => void;
}

export const AutoRunAttachmentsPanel = memo(function AutoRunAttachmentsPanel({
	theme,
	attachmentsList,
	attachmentPreviews,
	attachmentsExpanded,
	onToggleExpanded,
	onRemoveAttachment,
	onImageClick,
	onAnnotateAttachment,
}: AutoRunAttachmentsPanelProps) {
	if (attachmentsList.length === 0) return null;

	return (
		<div
			className="px-2 py-2 mx-2 mb-2 rounded"
			style={{ backgroundColor: theme.colors.bgActivity }}
		>
			<button
				onClick={onToggleExpanded}
				aria-expanded={attachmentsExpanded}
				aria-controls={attachmentsExpanded ? 'autorun-attachments-panel' : undefined}
				className="w-full flex items-center gap-1 text-[10px] uppercase font-semibold hover:opacity-80 transition-opacity"
				style={{ color: theme.colors.textDim }}
			>
				{attachmentsExpanded ? (
					<ChevronDown className="w-3 h-3" />
				) : (
					<ChevronRight className="w-3 h-3" />
				)}
				Attached Images ({attachmentsList.length})
			</button>
			{attachmentsExpanded && (
				<div id="autorun-attachments-panel" className="flex flex-wrap gap-1 mt-2">
					{attachmentsList.map((filename) => (
						<ImagePreview
							key={filename}
							src={attachmentPreviews.get(filename) || ''}
							filename={filename}
							theme={theme}
							onRemove={() => onRemoveAttachment(filename)}
							onImageClick={onImageClick}
							onAnnotate={onAnnotateAttachment ? () => onAnnotateAttachment(filename) : undefined}
						/>
					))}
				</div>
			)}
		</div>
	);
});
