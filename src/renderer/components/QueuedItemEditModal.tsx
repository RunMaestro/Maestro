import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ImagePlus, PenLine, X } from 'lucide-react';
import type { Theme, QueuedItem } from '../types';
import { Modal, ModalFooter } from './ui/Modal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useImageAnnotatorStore } from './ImageAnnotator/imageAnnotatorStore';
import { addStagedImageIfUnique } from './InputArea/utils/stagedImages';
import { notifyCenterFlash } from '../stores/centerFlashStore';
import { captureException } from '../utils/sentry';
import { useSettingsStore } from '../stores/settingsStore';
import { useKeyboardShortcutHelpers } from '../hooks/keyboard';
import { useResizableTextarea } from '../hooks/ui/useResizableTextarea';
import { LightboxModal } from './LightboxModal';

interface QueuedItemEditModalProps {
	item: QueuedItem;
	theme: Theme;
	onClose: () => void;
	onSave: (patch: { text: string; images: string[] }) => void;
}

/**
 * QueuedItemEditModal - edit a queued message's prompt text and attached images
 * before it is sent. Add images via the file picker or paste, edit them in the
 * shared annotator, or remove them. Reuses the same image primitives as the
 * composer (annotator store, dedupe helper, FileReader flow) and renders its own
 * LightboxModal so the in-carousel hotkeys (Cmd+E annotate, Cmd+C copy, Delete,
 * arrow nav) operate on THIS modal's images rather than the composer's staged set.
 */
export function QueuedItemEditModal({ item, theme, onClose, onSave }: QueuedItemEditModalProps) {
	const [text, setText] = useState(item.text ?? '');
	const [images, setImages] = useState<string[]>(item.images ?? []);
	// Currently-viewed image in the local carousel; null when the carousel is closed.
	const [lightboxImage, setLightboxImage] = useState<string | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const openAnnotator = useImageAnnotatorStore((s) => s.openAnnotator);

	// Reuse the app's shortcut matcher so Cmd+Y honors the user's binding. The
	// Modal root stops keydown propagation to the window-level global handler, so
	// this fires only while the modal is focused and never triggers background
	// state behind it. In-carousel keys (Cmd+E etc.) are owned by LightboxModal.
	const shortcuts = useSettingsStore((s) => s.shortcuts);
	const tabShortcuts = useSettingsStore((s) => s.tabShortcuts);
	const { isShortcut } = useKeyboardShortcutHelpers({ shortcuts, tabShortcuts });

	const resize = useResizableTextarea({
		sizeKey: 'queued-item-edit',
		minHeight: 80,
		externalRef: textareaRef,
	});

	// Put the caret at the end on open. The FOCUS itself is Modal's job via
	// initialFocusRef below: Modal auto-focuses on mount inside a
	// requestAnimationFrame, and with no initialFocusRef it focuses its own
	// overlay container. That frame lands after this effect, so focusing here
	// as well would be silently undone one frame later and the user would be
	// typing into a div - the whole point of this modal is the text box.
	useEffect(() => {
		const el = textareaRef.current;
		if (el) {
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

	// Open the annotator on a specific image; the edited PNG replaces it in place.
	const annotateImage = (img: string) => {
		openAnnotator(img, (newDataUrl) =>
			setImages((prev) => prev.map((s) => (s === img ? newDataUrl : s)))
		);
	};

	// Cmd/Ctrl+Enter saves from anywhere in the body, including the textarea where
	// plain Enter has to stay a newline. Parity with the composer: Cmd+Y opens the
	// carousel on the first image; once inside, LightboxModal owns the in-carousel
	// keys (Cmd+E annotate, Cmd+C copy, Delete/Backspace remove, arrows navigate).
	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			e.stopPropagation();
			handleSave();
			return;
		}
		if (images.length === 0) return;
		if (isShortcut(e.nativeEvent, 'openImageCarousel')) {
			e.preventDefault();
			setLightboxImage(images[0]);
		}
	};

	// Portal to document.body so the Modal's `fixed inset-0` backdrop resolves
	// against the viewport, not the transformed/`contain`-ing main-panel ancestor
	// this modal is mounted under (the transcript row uses content-visibility and
	// the panel chain applies filters, both of which create a containing block for
	// fixed descendants). Without the portal the backdrop is clipped to the center
	// column - the left/right bars stay bright and the card is cut off at the
	// right-panel edge. Same pattern as CueHelpModal and other portaled modals.
	return createPortal(
		<>
			<Modal
				theme={theme}
				title="Edit Queued Message"
				priority={MODAL_PRIORITIES.QUEUED_ITEM_EDIT}
				zIndex={95}
				width={560}
				initialFocusRef={textareaRef}
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
				<div onPaste={handlePaste} onKeyDown={handleKeyDown}>
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
							...resize.style,
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
										onClick={() => setLightboxImage(img)}
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
											annotateImage(img);
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

			{/* Local carousel: renders above the edit modal (zIndex 95) and below the
		    annotator (zIndex 160+). Wrapped in a fixed layer so LightboxModal's
		    `absolute inset-0` fills the viewport regardless of ancestor positioning.
		    Its onDelete/onUpdateImage mutate THIS modal's images, and it brings the
		    in-carousel hotkeys (Cmd+E annotate, Cmd+C copy, Delete, arrows) for free. */}
			{lightboxImage && (
				<div className="fixed inset-0" style={{ zIndex: 100 }}>
					<LightboxModal
						image={lightboxImage}
						stagedImages={images}
						theme={theme}
						onClose={() => setLightboxImage(null)}
						onNavigate={(img) => setLightboxImage(img)}
						onDelete={(img) => setImages((prev) => prev.filter((x) => x !== img))}
						onUpdateImage={(oldImg, newDataUrl) =>
							setImages((prev) => prev.map((x) => (x === oldImg ? newDataUrl : x)))
						}
					/>
				</div>
			)}
		</>,
		document.body
	);
}
