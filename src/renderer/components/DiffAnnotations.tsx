/**
 * The review half of the Git Diff viewer: the inline editor and comment card
 * drawn under an annotated diff line, and the tray that batches every pending
 * annotation and sends them to the agent as one prompt.
 *
 * The model and the prompt serializer live in `utils/diffAnnotations.ts`.
 */
import { memo, useRef, useState } from 'react';
import { MessageSquarePlus, Pencil, Send, Trash2 } from 'lucide-react';
import type { Theme } from '../types';
import type { DiffAnnotation } from '../utils/diffAnnotations';
import { formatAnnotationLocation } from '../utils/diffAnnotations';
import { useFocusOnMount } from '../hooks/utils/useFocusAfterRender';
import { HeaderActionButton } from './ui/HeaderActionButton';
import { formatMetaKey } from '../utils/shortcutFormatter';

interface DiffAnnotationEditorProps {
	theme: Theme;
	initialBody: string;
	isNew: boolean;
	onSave: (body: string) => void;
	onCancel: () => void;
}

/** Textarea for writing or editing one annotation, rendered under its line. */
export const DiffAnnotationEditor = memo(function DiffAnnotationEditor({
	theme,
	initialBody,
	isNew,
	onSave,
	onCancel,
}: DiffAnnotationEditorProps) {
	const [body, setBody] = useState(initialBody);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	useFocusOnMount(textareaRef, 0);
	const canSave = body.trim().length > 0;

	return (
		<div
			className="p-2 flex flex-col gap-2 font-sans"
			style={{ backgroundColor: theme.colors.bgSidebar }}
			data-testid="diff-annotation-editor"
		>
			<textarea
				ref={textareaRef}
				value={body}
				onChange={(e) => setBody(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						if (canSave) onSave(body);
					}
				}}
				rows={3}
				placeholder="Leave a comment for the agent on this line (markdown allowed)"
				aria-label="Annotation"
				className="w-full rounded p-2 text-sm outline-none resize-y"
				style={{
					backgroundColor: theme.colors.bgMain,
					color: theme.colors.textMain,
					border: `1px solid ${theme.colors.border}`,
				}}
			/>
			<div className="flex items-center justify-end gap-2 text-xs">
				<span style={{ color: theme.colors.textDim }}>{formatMetaKey()}+Enter to save</span>
				<button
					type="button"
					onClick={onCancel}
					className="px-2.5 py-1 rounded hover:bg-white/10 transition-colors"
					style={{ color: theme.colors.textDim }}
				>
					Cancel
				</button>
				<button
					type="button"
					onClick={() => onSave(body)}
					disabled={!canSave}
					className="px-2.5 py-1 rounded font-medium disabled:opacity-50"
					style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
				>
					{isNew ? 'Add annotation' : 'Save'}
				</button>
			</div>
		</div>
	);
});

interface DiffAnnotationCardProps {
	theme: Theme;
	annotation: DiffAnnotation;
	onEdit: () => void;
	onRemove: () => void;
}

/** A saved annotation, rendered under the line it was left on. */
export const DiffAnnotationCard = memo(function DiffAnnotationCard({
	theme,
	annotation,
	onEdit,
	onRemove,
}: DiffAnnotationCardProps) {
	return (
		<div
			className="px-3 py-2 flex items-start gap-2 font-sans text-sm"
			style={{
				backgroundColor: theme.colors.bgSidebar,
				borderLeft: `3px solid ${theme.colors.accent}`,
			}}
			data-testid="diff-annotation-card"
		>
			<MessageSquarePlus
				className="w-3.5 h-3.5 mt-0.5 shrink-0"
				style={{ color: theme.colors.accent }}
			/>
			<p
				className="flex-1 whitespace-pre-wrap break-words select-text"
				style={{ color: theme.colors.textMain }}
			>
				{annotation.body}
			</p>
			<button
				type="button"
				onClick={onEdit}
				className="p-1 rounded hover:bg-white/10"
				style={{ color: theme.colors.textDim }}
				aria-label="Edit annotation"
				title="Edit annotation"
			>
				<Pencil className="w-3.5 h-3.5" />
			</button>
			<button
				type="button"
				onClick={onRemove}
				className="p-1 rounded hover:bg-white/10"
				style={{ color: theme.colors.textDim }}
				aria-label="Remove annotation"
				title="Remove annotation"
			>
				<Trash2 className="w-3.5 h-3.5" />
			</button>
		</div>
	);
});

interface DiffReviewTrayProps {
	theme: Theme;
	annotations: DiffAnnotation[];
	/** Agent the review will be sent to, for the button label. */
	targetName?: string;
	onEdit: (annotation: DiffAnnotation) => void;
	onRemove: (id: string) => void;
	onClear: () => void;
	onSend: () => void;
}

/** Pending annotations across every file in the diff, plus the send action. */
export const DiffReviewTray = memo(function DiffReviewTray({
	theme,
	annotations,
	targetName,
	onEdit,
	onRemove,
	onClear,
	onSend,
}: DiffReviewTrayProps) {
	const count = annotations.length === 1 ? '1 annotation' : `${annotations.length} annotations`;
	return (
		<div
			className="border-t flex flex-col"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
			data-testid="diff-review-tray"
		>
			<div className="flex items-center justify-between px-6 py-2">
				<span className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
					Review: {count}
				</span>
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={onClear}
						className="px-2.5 py-1 rounded text-xs hover:bg-white/10 transition-colors"
						style={{ color: theme.colors.textDim }}
					>
						Clear
					</button>
					<HeaderActionButton
						theme={theme}
						onClick={onSend}
						icon={<Send />}
						testId="diff-review-send"
						title="Send every annotation to the agent as one prompt"
					>
						{targetName ? `Send review to ${targetName}` : 'Send review to agent'}
					</HeaderActionButton>
				</div>
			</div>
			<ul className="max-h-36 overflow-y-auto px-6 pb-2 flex flex-col gap-1">
				{annotations.map((annotation) => (
					<li key={annotation.id} className="flex items-center gap-2 text-xs">
						<button
							type="button"
							onClick={() => onEdit(annotation)}
							className="flex-1 min-w-0 flex items-center gap-2 text-left rounded px-1 py-0.5 hover:bg-white/5"
							title="Edit annotation"
						>
							<span className="font-mono shrink-0" style={{ color: theme.colors.accent }}>
								{formatAnnotationLocation(annotation)}
							</span>
							<span className="truncate" style={{ color: theme.colors.textDim }}>
								{annotation.body}
							</span>
						</button>
						<button
							type="button"
							onClick={() => onRemove(annotation.id)}
							className="p-1 rounded hover:bg-white/10 shrink-0"
							style={{ color: theme.colors.textDim }}
							aria-label={`Remove annotation on ${formatAnnotationLocation(annotation)}`}
							title="Remove annotation"
						>
							<Trash2 className="w-3 h-3" />
						</button>
					</li>
				))}
			</ul>
		</div>
	);
});
