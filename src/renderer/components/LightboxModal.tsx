import { useEffect, useRef, useState, useCallback } from 'react';
import { Copy, Check, PenLine, Trash2 } from 'lucide-react';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { ConfirmModal } from './ConfirmModal';
import { useImageAnnotatorStore } from './ImageAnnotator/imageAnnotatorStore';
import type { Theme } from '../types';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import { safeClipboardWriteImage } from '../utils/clipboard';
import { logger } from '../utils/logger';

interface LightboxModalProps {
	image: string;
	stagedImages: string[];
	onClose: () => void;
	onNavigate: (image: string) => void;
	/** Callback to delete the current image from staged images */
	onDelete?: (image: string) => void;
	/** Callback to replace the current image with an annotated version */
	onUpdateImage?: (oldImage: string, newDataUrl: string) => void;
	/** Theme for ConfirmModal styling */
	theme?: Theme;
}

export function LightboxModal({
	image,
	stagedImages,
	onClose,
	onNavigate,
	onDelete,
	onUpdateImage,
	theme,
}: LightboxModalProps) {
	const lightboxRef = useRef<HTMLDivElement>(null);
	const currentIndex = stagedImages.indexOf(image);
	const canNavigate = stagedImages.length > 1;
	const canDelete = Boolean(onDelete);
	const canAnnotate = Boolean(onUpdateImage);
	const layerIdRef = useRef<string>();
	const { registerLayer, unregisterLayer, updateLayerHandler, getTopLayer } = useLayerStack();
	const openAnnotator = useImageAnnotatorStore((state) => state.openAnnotator);
	const [copied, setCopied] = useState(false);
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

	useEffect(() => {
		if (!canDelete && showDeleteConfirm) {
			setShowDeleteConfirm(false);
		}
	}, [canDelete, showDeleteConfirm]);

	const copyImageToClipboard = async () => {
		try {
			const ok = await safeClipboardWriteImage(image);
			if (ok) {
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			}
		} catch (err) {
			logger.error('Failed to copy image to clipboard:', undefined, err);
		}
	};

	// Register layer on mount
	useEffect(() => {
		const layerId = registerLayer({
			type: 'overlay',
			priority: MODAL_PRIORITIES.LIGHTBOX,
			blocksLowerLayers: true,
			capturesFocus: true,
			focusTrap: 'none',
			ariaLabel: 'Image Lightbox',
			onEscape: onClose,
			allowClickOutside: true,
		});
		layerIdRef.current = layerId;

		return () => {
			if (layerIdRef.current) {
				unregisterLayer(layerIdRef.current);
			}
		};
	}, [registerLayer, unregisterLayer]);

	// Update handler when onClose changes
	useEffect(() => {
		if (layerIdRef.current) {
			updateLayerHandler(layerIdRef.current, onClose);
		}
	}, [onClose, updateLayerHandler]);

	useEffect(() => {
		// Focus the lightbox when it opens
		lightboxRef.current?.focus();
	}, []);

	const goToPrev = () => {
		if (canNavigate) {
			const newIndex = currentIndex > 0 ? currentIndex - 1 : stagedImages.length - 1;
			onNavigate(stagedImages[newIndex]);
		}
	};

	const goToNext = () => {
		if (canNavigate) {
			const newIndex = currentIndex < stagedImages.length - 1 ? currentIndex + 1 : 0;
			onNavigate(stagedImages[newIndex]);
		}
	};

	const openAnnotatorFromLightbox = useCallback(() => {
		if (!image || !onUpdateImage) return;
		const oldImage = image;
		openAnnotator(oldImage, (newDataUrl) => {
			onUpdateImage(oldImage, newDataUrl);
			onClose();
		});
	}, [image, onUpdateImage, openAnnotator, onClose]);

	// Show delete confirmation modal
	const promptDelete = useCallback(() => {
		if (!onDelete) return;
		setShowDeleteConfirm(true);
	}, [onDelete]);

	const goToPrevRef = useRef(goToPrev);
	const goToNextRef = useRef(goToNext);
	const promptDeleteRef = useRef(promptDelete);
	const copyImageRef = useRef(copyImageToClipboard);
	const openAnnotatorRef = useRef(openAnnotatorFromLightbox);
	goToPrevRef.current = goToPrev;
	goToNextRef.current = goToNext;
	promptDeleteRef.current = promptDelete;
	copyImageRef.current = copyImageToClipboard;
	openAnnotatorRef.current = openAnnotatorFromLightbox;

	// Window-level keyboard handler. The div-level approach only fires when the
	// lightbox div has focus, which is lost when the annotator (or any other
	// transient modal layered above) closes - that leaked Cmd+E to the chat
	// behind. Capturing on `window` is focus-independent. Guarded by
	// `getTopLayer` so the lightbox doesn't react while a higher-priority
	// layer (annotator, etc.) is on top.
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (showDeleteConfirm) return;
			const top = getTopLayer();
			if (!top || top.id !== layerIdRef.current) return;

			let handled = false;
			if (e.key === 'ArrowLeft') {
				if (canNavigate) {
					goToPrevRef.current();
					handled = true;
				}
			} else if (e.key === 'ArrowRight') {
				if (canNavigate) {
					goToNextRef.current();
					handled = true;
				}
			} else if ((e.key === 'Delete' || e.key === 'Backspace') && canDelete) {
				promptDeleteRef.current();
				handled = true;
			} else if (e.key === 'c' && (e.metaKey || e.ctrlKey)) {
				void copyImageRef.current();
				handled = true;
			} else if ((e.key === 'e' || e.key === 'E') && (e.metaKey || e.ctrlKey) && canAnnotate) {
				openAnnotatorRef.current();
				handled = true;
			}

			if (handled) {
				e.preventDefault();
				e.stopPropagation();
			}
		};

		window.addEventListener('keydown', handler, { capture: true });
		return () => window.removeEventListener('keydown', handler, { capture: true });
	}, [canNavigate, canDelete, canAnnotate, showDeleteConfirm, getTopLayer]);

	// Handle confirmed deletion
	const handleDeleteConfirmed = useCallback(() => {
		if (!onDelete) return;

		const totalImages = stagedImages.length;

		// Call the delete handler
		onDelete(image);

		// Navigate to next/prev image or close lightbox
		if (totalImages <= 1) {
			onClose();
		} else if (currentIndex >= totalImages - 1) {
			// Was last image, go to previous
			const newList = stagedImages.filter((img) => img !== image);
			onNavigate(newList[newList.length - 1]);
		} else {
			// Go to next image (same index in new list)
			const newList = stagedImages.filter((img) => img !== image);
			onNavigate(newList[currentIndex]);
		}

		// Refocus the lightbox after deletion so keyboard navigation continues working
		setTimeout(() => lightboxRef.current?.focus(), 0);
	}, [image, stagedImages, currentIndex, onDelete, onNavigate, onClose]);

	// Default theme for ConfirmModal if not provided
	const defaultTheme: Theme = {
		id: 'dracula',
		name: 'Default',
		mode: 'dark',
		colors: {
			bgMain: '#1a1a1a',
			bgSidebar: '#252525',
			bgActivity: '#333333',
			textMain: '#ffffff',
			textDim: '#888888',
			border: '#444444',
			accent: '#007acc',
			accentDim: 'rgba(0, 122, 204, 0.2)',
			accentText: '#3b82f6',
			accentForeground: '#ffffff',
			success: '#22c55e',
			warning: '#eab308',
			error: '#ef4444',
		},
	};

	return (
		<div
			ref={lightboxRef}
			className="absolute inset-0 z-[100] bg-black/90 flex items-center justify-center"
			onClick={onClose}
			tabIndex={-1}
			role="dialog"
			aria-modal="true"
			aria-label="Image Lightbox"
		>
			{canNavigate && (
				<button
					onClick={(e) => {
						e.stopPropagation();
						goToPrev();
					}}
					className="absolute left-4 top-1/2 -translate-y-1/2 bg-white/10 hover:bg-white/20 text-white rounded-full p-3 backdrop-blur-sm transition-colors"
				>
					←
				</button>
			)}
			<img
				src={image}
				alt="Expanded image preview"
				className="max-w-[90%] max-h-[90%] rounded shadow-2xl"
				onMouseDown={(e) => e.stopPropagation()}
				onClick={(e) => e.stopPropagation()}
			/>

			{/* Top right buttons: Annotate, Copy, Delete (if available) */}
			<div className="absolute top-4 right-4 flex gap-2">
				{/* Annotate button - only if onUpdateImage is provided */}
				{canAnnotate && (
					<button
						onClick={(e) => {
							e.stopPropagation();
							if (image && onUpdateImage) {
								const oldImage = image;
								openAnnotator(oldImage, (newDataUrl) => {
									onUpdateImage(oldImage, newDataUrl);
									onClose();
								});
							}
						}}
						className="bg-white/10 hover:bg-white/20 text-white rounded-full p-3 backdrop-blur-sm transition-colors"
						title={`Annotate image (${formatShortcutKeys(['Meta', 'e'])})`}
					>
						<PenLine className="w-5 h-5" />
					</button>
				)}

				{/* Copy to clipboard button */}
				<button
					onClick={(e) => {
						e.stopPropagation();
						copyImageToClipboard();
					}}
					className="bg-white/10 hover:bg-white/20 text-white rounded-full p-3 backdrop-blur-sm transition-colors flex items-center gap-2"
					title={`Copy image to clipboard (${formatShortcutKeys(['Meta', 'c'])})`}
				>
					{copied ? <Check className="w-5 h-5" /> : <Copy className="w-5 h-5" />}
					{copied && <span className="text-sm">Copied!</span>}
				</button>

				{/* Delete button - only if onDelete is provided */}
				{canDelete && (
					<button
						onClick={(e) => {
							e.stopPropagation();
							promptDelete();
						}}
						className="bg-red-500/80 hover:bg-red-500 text-white rounded-full p-3 backdrop-blur-sm transition-colors"
						title="Delete image (Delete key)"
					>
						<Trash2 className="w-5 h-5" />
					</button>
				)}
			</div>

			{canNavigate && (
				<button
					onClick={(e) => {
						e.stopPropagation();
						goToNext();
					}}
					className="absolute right-4 top-1/2 -translate-y-1/2 bg-white/10 hover:bg-white/20 text-white rounded-full p-3 backdrop-blur-sm transition-colors"
				>
					→
				</button>
			)}

			{/* Bottom info - unified format */}
			<div className="absolute bottom-10 text-white text-sm opacity-70 text-center">
				{canNavigate && (
					<span>
						Image {currentIndex + 1} of {stagedImages.length} • ← → to navigate •{' '}
					</span>
				)}
				{canDelete && <span>Delete to remove • </span>}
				<span>ESC to close</span>
			</div>

			{/* Delete confirmation modal */}
			{showDeleteConfirm && (
				<ConfirmModal
					theme={theme || defaultTheme}
					message="Are you sure you want to remove this image? This will remove it from the staged images."
					onConfirm={handleDeleteConfirmed}
					onClose={() => setShowDeleteConfirm(false)}
				/>
			)}
		</div>
	);
}
