import React, { useEffect, useRef, useState } from 'react';
import { ImagePlus, PenLine, X } from 'lucide-react';
import type { Theme, QueuedItem } from '../types';
import { Modal, ModalFooter } from './ui/Modal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useImageAnnotatorStore } from './ImageAnnotator/imageAnnotatorStore';
import { addStagedImageIfUnique } from './InputArea/utils/stagedImages';
import { notifyCenterFlash } from '../stores/centerFlashStore';
import { captureException } from '../utils/sentry';

interface QueuedItemEditModalProps {
	item: QueuedItem;
	theme: Theme;
	onClose: () => void;
	onSave: (patch: { text: string; images: string[] }) => void;
	// Opens the shared full-screen carousel. Passed 'history' source so the lightbox
	// is read-only (no delete wired to the composer's staged images).
	onOpenLightbox?: (image: string, contextImages?: string[], source?: 'staged' | 'history') => void;
}

/**
 * QueuedItemEditModal — edit a queued message's prompt text and attached images
 * before it is sent. Add images via the file picker or paste, edit them in the
 * shared annotator, or remove them. Reuses the same image primitives as the
 * composer (annotator store, dedupe helper, FileReader flow) and the shared
 * lightbox for full-size viewing.
 */
export function QueuedItemEditModal({
	item,
	theme,
	onClose,
	onSave,
	onOpenLightbox,
}: QueuedItemEditModalProps) {
	const [text, setText] = useState(item.text ?? '');
	const [images, setImages] = useState<string[]>(item.images ?? []);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const openAnnotator = useImageAnnotatorStore((s) => s.openAnnotator);

	// Focus the textarea on open, cursor at end.
	useEffect(() => {
		const el = textareaRef.current;
		if (el) {
			el.focus();
			el.selectionStart = el.value.length;
			el.selectionEnd = el.value.length;
		}
	}, []);

	const addImageFromDataUrl = (dataUrl: string) => {
		setImages((prev) =>
			addStagedImageIfUnique(prev, dataUrl, (m) =>
				notifyCenterFlash({ message: m, color: 'yellow' })
			)
		);
	};

	const readFilesAsImages = (files: File[]) => {
		files
			.filter((file) => file.type.startsWith('image/'))
			.forEach((file) => {
				const reader = new FileReader();
				reader.onload = (event) => {
					if (event.target?.result) addImageFromDataUrl(event.target.result as string);
				};
				reader.onerror = (event) => {
					captureException(reader.error ?? event, {
						extra: {
							component: 'QueuedItemEditModal',
							action: 'attachImage.readError',
							fileName: file.name,
						},
					});
					notifyCenterFlash({ message: 'Failed to attach image', color: 'red' });
				};
				reader.readAsDataURL(file);
			});
	};

	const handlePaste = (e: React.ClipboardEvent) => {
		const imageFiles = Array.from(e.clipboardData.items)
			.filter((it) => it.type.startsWith('image/'))
			.map((it) => it.getAsFile())
			.filter((f): f is File => f != null);
		if (imageFiles.length > 0) {
			e.preventDefault();
			readFilesAsImages(imageFiles);
		}
	};

	const trimmed = text.trim();
	const canSave = trimmed.length > 0 || images.length > 0;

	const handleSave = () => {
		if (!canSave) return;
		onSave({ text, images });
		onClose();
	};

	return (
		<Modal
			theme={theme}
			title="Edit Queued Message"
			priority={MODAL_PRIORITIES.QUEUED_ITEM_EDIT}
			zIndex={95}
			width={560}
			onClose={onClose}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleSave}
					confirmLabel="Save"
					confirmDisabled={!canSave}
				/>
			}
		>
			<div onPaste={handlePaste}>
				<textarea
					ref={textareaRef}
					value={text}
					onChange={(e) => setText(e.target.value)}
					rows={6}
					placeholder="Message to send…"
					className="w-full rounded-md border p-3 text-sm resize-y outline-none scrollbar-thin focus:ring-1"
					style={{
						backgroundColor: theme.colors.bgMain,
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
					}}
				/>

				{/* Image strip: annotate / remove / click-to-view */}
				{images.length > 0 && (
					<div className="flex gap-2 mt-3 pb-2 overflow-x-auto overflow-y-visible scrollbar-thin">
						{images.map((img, idx) => (
							<div
								key={img}
								className="relative group shrink-0 flex items-center justify-center"
								style={{ minWidth: '64px' }}
							>
								<button
									type="button"
									className="p-0 bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
									onClick={() => onOpenLightbox?.(img, images, 'history')}
									title="Click to view full size"
								>
									<img
										src={img}
										alt={`Attachment ${idx + 1}`}
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
											setImages((prev) => prev.map((s) => (s === img ? newDataUrl : s)))
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
										setImages((prev) => prev.filter((x) => x !== img));
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
				)}

				{/* Add image */}
				<button
					type="button"
					onClick={() => fileInputRef.current?.click()}
					className="flex items-center gap-1.5 mt-3 px-2.5 py-1.5 rounded text-xs font-medium hover:opacity-80 transition-opacity"
					style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
				>
					<ImagePlus className="w-4 h-4" />
					Add image
				</button>
				<input
					ref={fileInputRef}
					type="file"
					accept="image/*"
					multiple
					className="hidden"
					onChange={(e) => {
						readFilesAsImages(Array.from(e.target.files || []));
						e.target.value = '';
					}}
				/>
			</div>
		</Modal>
	);
}
