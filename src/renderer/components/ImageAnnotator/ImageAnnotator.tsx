/**
 * ImageAnnotator — Modal root for the freehand image annotator.
 *
 * Self-sources `isOpen`, `imageDataUrl`, `onSave`, and `closeAnnotator` from
 * `useImageAnnotatorStore`, so callers (input area, lightbox, Auto Run
 * thumbnails) just push state into the store and the modal mounts itself. The
 * component renders nothing while `isOpen` is false but stays mounted, so the
 * `useModalLayer` registration stays stable across open/close cycles via the
 * `enabled` flag.
 *
 * Save and copy compositing live here (not in the toolbar) — the toolbar emits
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
import { AnnotatorCanvas } from './AnnotatorCanvas';
import { AnnotatorToolbar } from './AnnotatorToolbar';
import { AnnotatorSettingsDrawer } from './AnnotatorSettingsDrawer';
import compositeAnnotatedImage from './compositeAnnotatedImage';

interface ImageAnnotatorProps {
	theme: Theme;
}

export function ImageAnnotator({ theme }: ImageAnnotatorProps) {
	const isOpen = useImageAnnotatorStore((s) => s.isOpen);
	const imageDataUrl = useImageAnnotatorStore((s) => s.imageDataUrl);
	const onSave = useImageAnnotatorStore((s) => s.onSave);
	const closeAnnotator = useImageAnnotatorStore((s) => s.closeAnnotator);

	const [drawerOpen, setDrawerOpen] = useState(false);

	// Remount canvas + state on each open so a fresh session starts clean.
	const sessionKey = useMemo(() => (isOpen ? imageDataUrl : null), [isOpen, imageDataUrl]);

	// Escape closes the settings drawer first if it's open, then the modal.
	const drawerOpenRef = useRef(drawerOpen);
	drawerOpenRef.current = drawerOpen;
	const handleEscape = useCallback(() => {
		if (drawerOpenRef.current) {
			setDrawerOpen(false);
			return;
		}
		closeAnnotator();
	}, [closeAnnotator, setDrawerOpen]);

	useModalLayer(MODAL_PRIORITIES.IMAGE_ANNOTATOR, 'Image Annotator', handleEscape, {
		focusTrap: 'lenient',
		enabled: isOpen,
	});

	// Left arrow opens the settings drawer, Right arrow closes it — but only
	// when focus isn't on a form control (range sliders inside the drawer use
	// Left/Right natively to adjust their value).
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
			// Best-effort stats recording — never block save on telemetry failure.
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
				onCancel={closeAnnotator}
			/>
			<AnnotatorSettingsDrawer
				open={drawerOpen}
				onClose={() => setDrawerOpen(false)}
				theme={theme}
				state={state}
			/>
		</div>
	);
}

export default ImageAnnotator;
