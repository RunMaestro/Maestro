import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Copy, Check, Trash2 } from 'lucide-react';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { ConfirmModal } from './ConfirmModal';
import type { Theme } from '../types';

interface LightboxModalProps {
	image: string;
	stagedImages: string[];
	onClose: () => void;
	onNavigate: (image: string) => void;
	/** Callback to delete the current image from staged images */
	onDelete?: (image: string) => void;
	/** Theme for ConfirmModal styling */
	theme?: Theme;
}

export function LightboxModal({
	image,
	stagedImages,
	onClose,
	onNavigate,
	onDelete,
	theme,
}: LightboxModalProps) {
	const lightboxRef = useRef<HTMLDivElement>(null);
	const currentIndex = stagedImages.indexOf(image);
	const canNavigate = stagedImages.length > 1;
	const canDelete = Boolean(onDelete);
	const layerIdRef = useRef<string>();
	const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
	const [copied, setCopied] = useState(false);
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

	const copyImageToClipboard = async () => {
		try {
			// Convert data URL to blob
			const response = await fetch(image);
			const blob = await response.blob();

			// Write to clipboard
			await navigator.clipboard.write([
				new ClipboardItem({
					[blob.type]: blob,
				}),
			]);

			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch (err) {
			console.error('Failed to copy image to clipboard:', err);
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

	// Show delete confirmation modal
	const promptDelete = useCallback(() => {
		if (!onDelete) return;
		setShowDeleteConfirm(true);
	}, [onDelete]);

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
			onKeyDown={(e) => {
				e.stopPropagation();
				if (e.key === 'ArrowLeft') {
					e.preventDefault();
					goToPrev();
				} else if (e.key === 'ArrowRight') {
					e.preventDefault();
					goToNext();
				} else if ((e.key === 'Delete' || e.key === 'Backspace') && canDelete) {
					e.preventDefault();
					promptDelete();
				} else if (e.key === 'c' && (e.metaKey || e.ctrlKey)) {
					e.preventDefault();
					copyImageToClipboard();
				}
			}}
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
				className="max-w-[90%] max-h-[90%] rounded shadow-2xl"
				onClick={(e) => e.stopPropagation()}
			/>

			{/* Top right buttons: Copy, Delete (if available) */}
			<div className="absolute top-4 right-4 flex gap-2">
				{/* Copy to clipboard button */}
				<button
					onClick={(e) => {
						e.stopPropagation();
						copyImageToClipboard();
					}}
					className="bg-white/10 hover:bg-white/20 text-white rounded-full p-3 backdrop-blur-sm transition-colors flex items-center gap-2"
					title="Copy image to clipboard (⌘C)"
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
