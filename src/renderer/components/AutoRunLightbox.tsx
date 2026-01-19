import React, { useState, useCallback, memo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight, Copy, Check, Trash2, FileText } from 'lucide-react';
import type { Theme } from '../types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { ConfirmModal } from './ConfirmModal';

// ============================================================================
// AutoRunLightbox - Full-screen image viewer with navigation, copy, delete
// ============================================================================

interface AutoRunLightboxProps {
	/** Theme for styling */
	theme: Theme;
	/** List of attachment relative paths (e.g., "images/{docName}-{timestamp}.{ext}") */
	attachmentsList: string[];
	/** Map of attachment paths to data URLs for display */
	attachmentPreviews: Map<string, string>;
	/** Currently displayed image filename/URL (null = lightbox closed) */
	lightboxFilename: string | null;
	/** External URL when viewing non-attachment images (http/https/data:) */
	lightboxExternalUrl: string | null;
	/** Callback to close the lightbox */
	onClose: () => void;
	/** Callback when navigating to a different image */
	onNavigate: (filename: string | null) => void;
	/** Callback to delete an attachment image (only for local attachments) */
	onDelete?: (relativePath: string) => void;
}

/**
 * AutoRunLightbox displays images in a full-screen overlay with:
 * - Image carousel navigation (left/right arrows, keyboard)
 * - Copy to clipboard functionality
 * - Delete button for local attachments
 * - Keyboard shortcuts: Escape (close), Arrow keys (navigate), Delete (remove)
 */
export const AutoRunLightbox = memo(
	({
		theme,
		attachmentsList,
		attachmentPreviews,
		lightboxFilename,
		lightboxExternalUrl,
		onClose,
		onNavigate,
		onDelete,
	}: AutoRunLightboxProps) => {
		const [copied, setCopied] = useState(false);
		const [copiedMarkdown, setCopiedMarkdown] = useState(false);
		const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
		const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
		const layerIdRef = useRef<string>();
		const onCloseRef = useRef(onClose);
		onCloseRef.current = onClose;

		// Determine if lightbox is visible
		const isVisible = Boolean(lightboxFilename);

		// Register with layer stack when lightbox is visible
		// This ensures Escape closes the lightbox first before the expanded modal
		useEffect(() => {
			if (isVisible) {
				const id = registerLayer({
					type: 'modal',
					priority: MODAL_PRIORITIES.AUTORUN_LIGHTBOX,
					blocksLowerLayers: true,
					capturesFocus: true,
					focusTrap: 'lenient',
					onEscape: () => {
						onCloseRef.current();
					},
				});
				layerIdRef.current = id;

				return () => {
					if (layerIdRef.current) {
						unregisterLayer(layerIdRef.current);
					}
				};
			}
		}, [isVisible, registerLayer, unregisterLayer]);

		// Keep escape handler up to date
		useEffect(() => {
			if (layerIdRef.current) {
				updateLayerHandler(layerIdRef.current, () => {
					onCloseRef.current();
				});
			}
		}, [onClose, updateLayerHandler]);

		// Calculate current index and navigation availability
		const currentIndex = lightboxFilename ? attachmentsList.indexOf(lightboxFilename) : -1;
		const canNavigate = attachmentsList.length > 1 && !lightboxExternalUrl;

		// Navigate to previous image
		const goToPrevImage = useCallback(() => {
			if (!canNavigate) return;
			const newIndex = currentIndex > 0 ? currentIndex - 1 : attachmentsList.length - 1;
			onNavigate(attachmentsList[newIndex]);
		}, [canNavigate, currentIndex, attachmentsList, onNavigate]);

		// Navigate to next image
		const goToNextImage = useCallback(() => {
			if (!canNavigate) return;
			const newIndex = currentIndex < attachmentsList.length - 1 ? currentIndex + 1 : 0;
			onNavigate(attachmentsList[newIndex]);
		}, [canNavigate, currentIndex, attachmentsList, onNavigate]);

		// Copy image to clipboard
		const copyToClipboard = useCallback(async () => {
			if (!lightboxFilename) return;

			const imageUrl = lightboxExternalUrl || attachmentPreviews.get(lightboxFilename);
			if (!imageUrl) return;

			try {
				const response = await fetch(imageUrl);
				const blob = await response.blob();
				await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			} catch (err) {
				console.error('Failed to copy image to clipboard:', err);
			}
		}, [lightboxFilename, lightboxExternalUrl, attachmentPreviews]);

		// Copy markdown reference to clipboard
		const copyMarkdownReference = useCallback(async () => {
			if (!lightboxFilename) return;

			// For external URLs, use the URL directly; for local images, URL-encode the path
			const imagePath =
				lightboxExternalUrl ||
				lightboxFilename
					.split('/')
					.map((part) => encodeURIComponent(part))
					.join('/');
			// Extract just the filename for the alt text
			const altText =
				lightboxFilename
					.split('/')
					.pop()
					?.replace(/\.[^.]+$/, '') || 'image';
			const markdownString = `![${altText}](${imagePath})`;

			try {
				await navigator.clipboard.writeText(markdownString);
				setCopiedMarkdown(true);
				setTimeout(() => setCopiedMarkdown(false), 2000);
			} catch (err) {
				console.error('Failed to copy markdown reference:', err);
			}
		}, [lightboxFilename, lightboxExternalUrl]);

		// Show delete confirmation modal
		const promptDelete = useCallback(() => {
			if (!lightboxFilename || !onDelete || lightboxExternalUrl) return;
			setShowDeleteConfirm(true);
		}, [lightboxFilename, lightboxExternalUrl, onDelete]);

		// Actually delete the current image (called after confirmation)
		const handleDeleteConfirmed = useCallback(() => {
			if (!lightboxFilename || !onDelete || lightboxExternalUrl) return;

			const totalImages = attachmentsList.length;

			// Call the delete handler
			onDelete(lightboxFilename);

			// Navigate to next/prev image or close lightbox
			if (totalImages <= 1) {
				onClose();
			} else if (currentIndex >= totalImages - 1) {
				// Was last image, go to previous
				const newList = attachmentsList.filter((f) => f !== lightboxFilename);
				onNavigate(newList[newList.length - 1] || null);
			} else {
				// Go to next image (same index in new list)
				const newList = attachmentsList.filter((f) => f !== lightboxFilename);
				onNavigate(newList[currentIndex] || null);
			}
		}, [
			lightboxFilename,
			lightboxExternalUrl,
			attachmentsList,
			currentIndex,
			onDelete,
			onNavigate,
			onClose,
		]);

		// Handle keyboard events
		// Note: Escape is handled by the LayerStack system to ensure proper priority
		// over the expanded modal - don't handle it here
		const handleKeyDown = useCallback(
			(e: React.KeyboardEvent) => {
				e.stopPropagation();
				if (e.key === 'ArrowLeft') {
					e.preventDefault();
					goToPrevImage();
				} else if (e.key === 'ArrowRight') {
					e.preventDefault();
					goToNextImage();
				} else if (e.key === 'Delete' || e.key === 'Backspace') {
					e.preventDefault();
					if (!lightboxExternalUrl && onDelete) {
						promptDelete();
					}
				} else if (e.key === 'c' && (e.metaKey || e.ctrlKey)) {
					e.preventDefault();
					copyToClipboard();
				}
			},
			[goToPrevImage, goToNextImage, lightboxExternalUrl, onDelete, promptDelete, copyToClipboard]
		);

		// Don't render if no image is selected
		const imageUrl =
			lightboxExternalUrl ||
			(lightboxFilename ? attachmentPreviews.get(lightboxFilename) : undefined);
		if (!lightboxFilename || !imageUrl) {
			return null;
		}

		return createPortal(
			<div
				className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/90"
				onClick={onClose}
				onKeyDown={handleKeyDown}
				tabIndex={-1}
				ref={(el) => el?.focus()}
			>
				{/* Previous button - only for attachments carousel */}
				{canNavigate && (
					<button
						onClick={(e) => {
							e.stopPropagation();
							goToPrevImage();
						}}
						className="absolute left-4 top-1/2 -translate-y-1/2 bg-white/10 hover:bg-white/20 text-white rounded-full p-3 backdrop-blur-sm transition-colors"
						title="Previous image (←)"
					>
						<ChevronLeft className="w-6 h-6" />
					</button>
				)}

				{/* Image */}
				<img
					src={imageUrl}
					alt={lightboxFilename}
					className="max-w-[90%] max-h-[90%] rounded shadow-2xl"
					onClick={(e) => e.stopPropagation()}
				/>

				{/* Top right buttons: Copy Markdown, Copy Image, Delete, Close */}
				<div className="absolute top-4 right-4 flex gap-2">
					{/* Copy markdown reference to clipboard */}
					<button
						onClick={(e) => {
							e.stopPropagation();
							copyMarkdownReference();
						}}
						className="bg-white/10 hover:bg-white/20 text-white rounded-full p-3 backdrop-blur-sm transition-colors flex items-center gap-2"
						title="Copy markdown reference (e.g., ![alt](path))"
					>
						{copiedMarkdown ? <Check className="w-5 h-5" /> : <FileText className="w-5 h-5" />}
						{copiedMarkdown && <span className="text-sm">Copied!</span>}
					</button>

					{/* Copy image to clipboard */}
					<button
						onClick={(e) => {
							e.stopPropagation();
							copyToClipboard();
						}}
						className="bg-white/10 hover:bg-white/20 text-white rounded-full p-3 backdrop-blur-sm transition-colors flex items-center gap-2"
						title="Copy image to clipboard (⌘C)"
					>
						{copied ? <Check className="w-5 h-5" /> : <Copy className="w-5 h-5" />}
						{copied && <span className="text-sm">Copied!</span>}
					</button>

					{/* Delete image - only for attachments, not external URLs */}
					{!lightboxExternalUrl && onDelete && (
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

					{/* Close button */}
					<button
						onClick={(e) => {
							e.stopPropagation();
							onClose();
						}}
						className="bg-white/10 hover:bg-white/20 text-white rounded-full p-3 backdrop-blur-sm transition-colors"
						title="Close (ESC)"
					>
						<X className="w-5 h-5" />
					</button>
				</div>

				{/* Next button - only for attachments carousel */}
				{canNavigate && (
					<button
						onClick={(e) => {
							e.stopPropagation();
							goToNextImage();
						}}
						className="absolute right-4 top-1/2 -translate-y-1/2 bg-white/10 hover:bg-white/20 text-white rounded-full p-3 backdrop-blur-sm transition-colors"
						title="Next image (→)"
					>
						<ChevronRight className="w-6 h-6" />
					</button>
				)}

				{/* Bottom info - unified format matching LightboxModal */}
				<div className="absolute bottom-10 text-white text-sm opacity-70 text-center max-w-[80%]">
					<div className="truncate">{lightboxFilename}</div>
					<div className="mt-1">
						{canNavigate && (
							<span>
								Image {currentIndex + 1} of {attachmentsList.length} • ← → to navigate •{' '}
							</span>
						)}
						{!lightboxExternalUrl && onDelete && <span>Delete to remove • </span>}
						<span>ESC to close</span>
					</div>
				</div>

				{/* Delete confirmation modal */}
				{showDeleteConfirm && (
					<ConfirmModal
						theme={theme}
						message={`Are you sure you want to delete "${lightboxFilename?.split('/').pop() || 'this image'}"? This action cannot be undone.`}
						onConfirm={handleDeleteConfirmed}
						onClose={() => setShowDeleteConfirm(false)}
					/>
				)}
			</div>,
			document.body
		);
	}
);

AutoRunLightbox.displayName = 'AutoRunLightbox';
