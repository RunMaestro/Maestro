/**
 * ImageAnnotator - Modal root for the freehand image annotator.
 *
 * Self-sources `isOpen`, `imageDataUrl`, `onSave`, and `closeAnnotator` from
 * `useImageAnnotatorStore`, so callers (input area, lightbox, Auto Run
 * thumbnails) just push state into the store and the modal mounts itself. The
 * component renders nothing while `isOpen` is false but stays mounted, so the
 * `useModalLayer` registration stays stable across open/close cycles via the
 * `enabled` flag.
 *
 * Save and copy compositing live here (not in the toolbar) - the toolbar emits
 * `onSave` / `onCopy` callbacks and the parent owns the SVG ref + image data
 * URL needed by `compositeAnnotatedImage`. The drawer body is a placeholder
 * for phase 03.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Theme } from '../../types';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { useEventListener } from '../../hooks/utils/useEventListener';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { safeClipboardWriteImage } from '../../utils/clipboard';
import { notifyToast } from '../../stores/notificationStore';
import { logger } from '../../utils/logger';
import { useImageAnnotatorStore } from './imageAnnotatorStore';
import { useAnnotatorState } from './useAnnotatorState';
import type { AnnotatorTool } from './useAnnotatorState';
import { AnnotatorCanvas } from './AnnotatorCanvas';
import { AnnotatorToolbar } from './AnnotatorToolbar';
import { AnnotatorSettingsDrawer } from './AnnotatorSettingsDrawer';
import compositeAnnotatedImage from './compositeAnnotatedImage';

interface ImageAnnotatorProps {
	theme: Theme;
}

// Single-key tool shortcuts (lowercased). Mnemonic where the tool value differs
// from the key: S = Square (rect), C = Circle (ellipse), A = Arrow.
const TOOL_HOTKEYS: Record<string, AnnotatorTool> = {
	d: 'pen', // Draw
	p: 'pan',
	e: 'eraser',
	s: 'rect', // Square
	c: 'ellipse', // Circle
	t: 'text',
	a: 'arrow',
};

export function ImageAnnotator({ theme }: ImageAnnotatorProps) {
	const isOpen = useImageAnnotatorStore((s) => s.isOpen);
	const imageDataUrl = useImageAnnotatorStore((s) => s.imageDataUrl);
	const onSave = useImageAnnotatorStore((s) => s.onSave);
	const closeAnnotator = useImageAnnotatorStore((s) => s.closeAnnotator);

	const [drawerOpen, setDrawerOpen] = useState(false);

	// Remount canvas + state on each open so a fresh session starts clean.
	const sessionKey = useMemo(() => (isOpen ? imageDataUrl : null), [isOpen, imageDataUrl]);

	// Left arrow opens the settings drawer, Right arrow closes it - but only
	// when focus isn't on a form control (range sliders inside the drawer use
	// Left/Right natively to adjust their value).
	const drawerOpenRef = useRef(drawerOpen);
	drawerOpenRef.current = drawerOpen;
	useEventListener(
		'keydown',
		(event) => {
			const e = event as KeyboardEvent;
			if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
			if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
			const target = e.target as HTMLElement | null;
			const tag = target?.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
				return;
			}
			if (e.key === 'ArrowLeft' && !drawerOpenRef.current) {
				e.preventDefault();
				setDrawerOpen(true);
			} else if (e.key === 'ArrowRight' && drawerOpenRef.current) {
				e.preventDefault();
				setDrawerOpen(false);
			}
		},
		{ target: typeof document !== 'undefined' ? document : null, enabled: isOpen }
	);

	if (!isOpen || !imageDataUrl) {
		return null;
	}

	return (
		<ImageAnnotatorContent
			key={sessionKey ?? 'closed'}
			theme={theme}
			imageDataUrl={imageDataUrl}
			onSave={onSave}
			closeAnnotator={closeAnnotator}
			drawerOpen={drawerOpen}
			setDrawerOpen={setDrawerOpen}
		/>
	);
}

interface ImageAnnotatorContentProps {
	theme: Theme;
	imageDataUrl: string;
	onSave: ((newDataUrl: string) => void) | null;
	closeAnnotator: () => void;
	drawerOpen: boolean;
	setDrawerOpen: Dispatch<SetStateAction<boolean>>;
}

function ImageAnnotatorContent({
	theme,
	imageDataUrl,
	onSave,
	closeAnnotator,
	drawerOpen,
	setDrawerOpen,
}: ImageAnnotatorContentProps) {
	const state = useAnnotatorState();
	const svgRef = useRef<SVGSVGElement>(null);

	// Any committed annotation counts as unsaved work - strokes, geometric
	// shapes, and text labels. An in-progress (uncommitted) freehand stroke
	// or shape doesn't, because it hasn't survived a pointerup yet.
	const hasUnsavedChanges =
		state.strokes.length > 0 || state.shapes.length > 0 || state.texts.length > 0;

	const [confirmingDiscard, setConfirmingDiscard] = useState(false);

	// Escape precedence inside the annotator:
	//   1. If the discard-confirm dialog is up, Escape dismisses it (keep editing).
	//   2. Else if the settings drawer is open, Escape closes the drawer.
	//   3. Else if there are unsaved changes, Escape raises the confirm dialog.
	//   4. Otherwise Escape closes the modal immediately (nothing to lose).
	// Refs let the modal-layer-registered handler read the latest values without
	// re-registering on every render.
	const drawerOpenRef = useRef(drawerOpen);
	drawerOpenRef.current = drawerOpen;
	const hasChangesRef = useRef(hasUnsavedChanges);
	hasChangesRef.current = hasUnsavedChanges;
	const confirmingRef = useRef(confirmingDiscard);
	confirmingRef.current = confirmingDiscard;

	const handleEscape = useCallback(() => {
		if (confirmingRef.current) {
			setConfirmingDiscard(false);
			return;
		}
		if (drawerOpenRef.current) {
			setDrawerOpen(false);
			return;
		}
		if (hasChangesRef.current) {
			setConfirmingDiscard(true);
			return;
		}
		closeAnnotator();
	}, [closeAnnotator, setDrawerOpen]);

	useModalLayer(MODAL_PRIORITIES.IMAGE_ANNOTATOR, 'Image Annotator', handleEscape, {
		focusTrap: 'lenient',
	});

	// X / Cancel button: same guard as Escape - never close out from under the
	// user when there's committed work that hasn't been saved.
	const handleCancel = useCallback(() => {
		if (hasChangesRef.current) {
			setConfirmingDiscard(true);
			return;
		}
		closeAnnotator();
	}, [closeAnnotator]);

	const handleConfirmDiscard = useCallback(() => {
		setConfirmingDiscard(false);
		closeAnnotator();
	}, [closeAnnotator]);

	const handleKeepEditing = useCallback(() => setConfirmingDiscard(false), []);

	// Single-key tool hotkeys. Mnemonic where the tool value diverges from the
	// key: S -> rect (Square), C -> ellipse (Circle). Skipped while a text label
	// is being edited (the textarea must receive the letters) and whenever a
	// modifier is held so app-level shortcuts still work.
	const setTool = state.setTool;
	useEventListener(
		'keydown',
		(event) => {
			const e = event as KeyboardEvent;
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			const target = e.target as HTMLElement | null;
			const tag = target?.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
				return;
			}
			const tool = TOOL_HOTKEYS[e.key.toLowerCase()];
			if (!tool) return;
			e.preventDefault();
			setTool(tool);
		},
		{ target: typeof document !== 'undefined' ? document : null }
	);

	const composite = useCallback(async (): Promise<string | null> => {
		const svg = svgRef.current;
		if (!svg) return null;
		// If a text label is mid-edit, commit it first so the value lands in the
		// SVG `<text>` element before we serialize. Belt-and-suspenders against
		// the textarea's own onBlur (which races with the save click target).
		state.commitTextEditing();
		return compositeAnnotatedImage(imageDataUrl, svg);
	}, [imageDataUrl, state]);

	const handleSave = useCallback(async () => {
		try {
			const dataUrl = await composite();
			if (!dataUrl) return;
			onSave?.(dataUrl);
			closeAnnotator();
			// Best-effort stats recording - never block save on telemetry failure.
			void window.maestro.stats.recordImageAnnotation(Date.now()).catch((err: unknown) => {
				logger.warn('Failed to record image annotation stat', undefined, err);
			});
		} catch (err) {
			logger.error('Failed to save annotated image:', undefined, err);
			notifyToast({
				color: 'red',
				title: 'Save failed',
				message: 'Could not composite the annotated image.',
			});
		}
	}, [composite, onSave, closeAnnotator]);

	const handleCopy = useCallback(async () => {
		const dataUrl = await composite();
		if (!dataUrl) {
			throw new Error('Annotator canvas not ready');
		}
		const ok = await safeClipboardWriteImage(dataUrl);
		if (!ok) {
			throw new Error('Clipboard write rejected');
		}
	}, [composite]);

	const toggleDrawer = useCallback(() => setDrawerOpen((v) => !v), []);

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Image Annotator"
			className="fixed inset-0 z-[160]"
			style={{
				backgroundColor: `${theme.colors.bgMain}f2`,
				color: theme.colors.textMain,
			}}
		>
			<AnnotatorCanvas ref={svgRef} imageDataUrl={imageDataUrl} state={state} />
			<AnnotatorToolbar
				state={state}
				theme={theme}
				drawerOpen={drawerOpen}
				onToggleDrawer={toggleDrawer}
				onSave={handleSave}
				onCopy={handleCopy}
				onCancel={handleCancel}
			/>
			<AnnotatorSettingsDrawer
				open={drawerOpen}
				onClose={() => setDrawerOpen(false)}
				theme={theme}
				state={state}
			/>
			{confirmingDiscard && (
				<DiscardConfirmDialog
					theme={theme}
					onKeepEditing={handleKeepEditing}
					onDiscard={handleConfirmDiscard}
				/>
			)}
		</div>
	);
}

interface DiscardConfirmDialogProps {
	theme: Theme;
	onKeepEditing: () => void;
	onDiscard: () => void;
}

/**
 * Confirms "discard your annotations" before closing the annotator. Default
 * focus lands on `Keep editing` so an accidental space/enter does the safe
 * thing - discarding requires an explicit click on the destructive button.
 */
function DiscardConfirmDialog({ theme, onKeepEditing, onDiscard }: DiscardConfirmDialogProps) {
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Discard annotations?"
			className="fixed inset-0 flex items-center justify-center select-none"
			style={{ zIndex: 180, backgroundColor: 'rgba(0,0,0,0.55)' }}
			// Backdrop click = keep editing (same as Esc) - never silently discard.
			onMouseDown={onKeepEditing}
		>
			<div
				className="rounded-xl p-5 max-w-sm w-full mx-4"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					border: `1px solid ${theme.colors.border}`,
					boxShadow: '0 24px 48px -16px rgba(0,0,0,0.6)',
				}}
				// Stop the backdrop's mousedown from firing when clicking inside.
				onMouseDown={(e) => e.stopPropagation()}
			>
				<div className="text-base font-semibold mb-2" style={{ color: theme.colors.textMain }}>
					Discard your annotations?
				</div>
				<div className="text-sm mb-5" style={{ color: theme.colors.textDim }}>
					You have unsaved drawing, shapes, or text on this image. Closing now will permanently lose
					them.
				</div>
				<div className="flex justify-end gap-2">
					<button
						type="button"
						autoFocus
						onClick={onKeepEditing}
						className="px-3 py-1.5 rounded text-sm transition-colors hover:bg-white/10"
						style={{
							color: theme.colors.textMain,
							border: `1px solid ${theme.colors.border}`,
						}}
					>
						Keep editing
					</button>
					<button
						type="button"
						onClick={onDiscard}
						className="px-3 py-1.5 rounded text-sm transition-opacity hover:opacity-90"
						style={{
							backgroundColor: theme.colors.error,
							color: theme.colors.accentForeground,
						}}
					>
						Discard
					</button>
				</div>
			</div>
		</div>
	);
}

export default ImageAnnotator;
