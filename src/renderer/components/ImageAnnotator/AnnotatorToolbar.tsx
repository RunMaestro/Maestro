/**
 * AnnotatorToolbar — Top-center floating toolbar for the image annotator.
 *
 * Pure UI: tool selection (pen / eraser / pan), undo, clear-with-inline-confirm,
 * settings drawer toggle, copy-to-clipboard, save, and cancel. Compositing and
 * clipboard writes are owned by the parent (`onSave` / `onCopy`); the toolbar
 * fires the "Copied annotated image to clipboard" Center Flash when `onCopy`
 * resolves so the success ack stays attached to the actual user click.
 *
 * Cmd/Ctrl+Z is bound at the window level so undo works regardless of which
 * subtree of the modal currently owns focus.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
	ArrowUpRight,
	Check,
	Circle,
	Copy,
	Eraser,
	Move,
	PenLine,
	Square,
	SlidersHorizontal,
	Trash2,
	Undo2,
	X,
	type LucideIcon,
} from 'lucide-react';
import type { Theme } from '../../../shared/theme-types';
import { GhostIconButton } from '../ui/GhostIconButton';
import { notifyCenterFlash } from '../../stores/centerFlashStore';
import type { AnnotatorTool, UseAnnotatorStateReturn } from './useAnnotatorState';

interface AnnotatorToolbarProps {
	state: UseAnnotatorStateReturn;
	theme: Theme;
	drawerOpen: boolean;
	onToggleDrawer: () => void;
	/** Composite + persist. Parent handles the actual save flow. */
	onSave: () => void | Promise<void>;
	/** Composite + write to clipboard. Toolbar shows the success flash. */
	onCopy: () => Promise<void>;
	onCancel: () => void;
}

export const AnnotatorToolbar = memo(function AnnotatorToolbar({
	state,
	theme,
	drawerOpen,
	onToggleDrawer,
	onSave,
	onCopy,
	onCancel,
}: AnnotatorToolbarProps) {
	const { tool, setTool, strokes, shapes, undo, clear } = state;
	const [confirmingClear, setConfirmingClear] = useState(false);
	const confirmWrapRef = useRef<HTMLDivElement>(null);
	const hasContent = strokes.length > 0 || shapes.length > 0;

	// Cmd/Ctrl+Z (undo) and Cmd/Ctrl+S (save+exit) for the annotator.
	//
	// Attached at the *capture* phase on `window`, with `stopImmediatePropagation`
	// after we handle the event, so our handler always wins regardless of how
	// many other window-level keydown listeners (App's main keyboard handler,
	// other modals' useEventListener hooks, etc.) are registered. This is
	// defensive: the main keyboard handler already early-returns when the
	// annotator's modal layer is open, but we don't want to depend on that
	// invariant — annotator shortcuts should be self-contained.
	const undoRef = useRef(undo);
	undoRef.current = undo;
	const onSaveRef = useRef(onSave);
	onSaveRef.current = onSave;
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				event.target instanceof HTMLInputElement ||
				event.target instanceof HTMLTextAreaElement ||
				(event.target instanceof HTMLElement && event.target.isContentEditable)
			) {
				return;
			}
			const cmd = event.metaKey || event.ctrlKey;
			if (!cmd || event.shiftKey || event.altKey) return;
			const key = event.key.toLowerCase();
			if (key === 'z') {
				event.preventDefault();
				event.stopImmediatePropagation();
				undoRef.current();
			} else if (key === 's') {
				event.preventDefault();
				event.stopImmediatePropagation();
				void onSaveRef.current();
			}
		};
		window.addEventListener('keydown', onKeyDown, { capture: true });
		return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
	}, []);

	useEffect(() => {
		if (!confirmingClear) return;
		const onMouseDown = (e: MouseEvent) => {
			if (confirmWrapRef.current && !confirmWrapRef.current.contains(e.target as Node)) {
				setConfirmingClear(false);
			}
		};
		document.addEventListener('mousedown', onMouseDown);
		return () => document.removeEventListener('mousedown', onMouseDown);
	}, [confirmingClear]);

	useEffect(() => {
		if (!hasContent && confirmingClear) setConfirmingClear(false);
	}, [hasContent, confirmingClear]);

	const handleConfirmClear = useCallback(() => {
		clear();
		setConfirmingClear(false);
	}, [clear]);

	const handleCopy = useCallback(async () => {
		try {
			await onCopy();
			notifyCenterFlash({ message: 'Copied annotated image to clipboard', color: 'green' });
		} catch {
			// Parent surfaces explicit copy errors; toolbar only confirms success.
		}
	}, [onCopy]);

	const handleSave = useCallback(() => {
		void onSave();
	}, [onSave]);

	const ICON_CLASS = 'w-5 h-5';
	const BUTTON_PADDING = 'p-2';

	const renderToolButton = (value: AnnotatorTool, Icon: LucideIcon, label: string) => {
		const active = tool === value;
		return (
			<GhostIconButton
				onClick={() => setTool(value)}
				ariaLabel={label}
				title={label}
				padding={BUTTON_PADDING}
				color={active ? theme.colors.accent : theme.colors.textMain}
				style={active ? { backgroundColor: `${theme.colors.accent}26` } : undefined}
			>
				<Icon className={ICON_CLASS} />
			</GhostIconButton>
		);
	};

	// Horizontal divider for the vertical toolbar layout.
	const divider = (
		<div
			aria-hidden
			style={{
				width: 22,
				height: 1,
				backgroundColor: theme.colors.border,
				margin: '4px 0',
			}}
		/>
	);

	const canUndo = hasContent;

	// Slide the toolbar left when the settings drawer opens, so the drawer
	// can take the right edge without occluding the buttons. The drawer
	// itself is 320px wide; we leave a 24px gap on either side.
	const DRAWER_WIDTH = 320;
	const EDGE_GAP = 24;
	const rightOffset = drawerOpen ? DRAWER_WIDTH + EDGE_GAP : EDGE_GAP;

	return createPortal(
		<div
			role="toolbar"
			aria-label="Image annotator toolbar"
			aria-orientation="vertical"
			className="fixed top-1/2 flex flex-col items-center gap-1 rounded-xl px-1.5 py-2"
			style={
				{
					zIndex: 170,
					right: rightOffset,
					transform: 'translateY(-50%)',
					transition: 'right 200ms ease-out',
					backgroundColor: `${theme.colors.bgSidebar}d9`,
					backdropFilter: 'blur(12px) saturate(150%)',
					WebkitBackdropFilter: 'blur(12px) saturate(150%)',
					border: `1px solid ${theme.colors.border}`,
					boxShadow: '0 8px 24px -8px rgba(0, 0, 0, 0.5)',
					pointerEvents: 'auto',
					// Electron has a 40px draggable title bar (`-webkit-app-region:
					// drag`) at the top of the window. App-region hijacks clicks
					// before they reach React, regardless of z-index. We're well
					// clear of it on the right edge, but `no-drag` is belt-and-
					// suspenders so this can never bite again.
					WebkitAppRegion: 'no-drag',
				} as React.CSSProperties
			}
			onPointerDown={(e) => e.stopPropagation()}
			onWheel={(e) => e.stopPropagation()}
		>
			{renderToolButton('pen', PenLine, 'Pen')}
			{renderToolButton('eraser', Eraser, 'Eraser')}
			{renderToolButton('pan', Move, 'Pan (or hold Shift / Space)')}

			{divider}

			{renderToolButton('rect', Square, 'Rectangle')}
			{renderToolButton('ellipse', Circle, 'Ellipse')}
			{renderToolButton('arrow', ArrowUpRight, 'Arrow')}

			{divider}

			<GhostIconButton
				onClick={undo}
				ariaLabel="Undo"
				title="Undo (⌘Z)"
				padding={BUTTON_PADDING}
				disabled={!canUndo}
				color={theme.colors.textMain}
			>
				<Undo2 className={ICON_CLASS} />
			</GhostIconButton>

			<div ref={confirmWrapRef} style={{ position: 'relative' }}>
				<GhostIconButton
					onClick={() => {
						if (!canUndo) return;
						setConfirmingClear((v) => !v);
					}}
					ariaLabel="Clear all strokes"
					title="Clear all strokes"
					padding={BUTTON_PADDING}
					disabled={!canUndo}
					color={theme.colors.error}
				>
					<Trash2 className={ICON_CLASS} />
				</GhostIconButton>
				{confirmingClear && (
					<div
						role="dialog"
						aria-label="Clear all strokes?"
						className="absolute mr-2 flex flex-col gap-2 rounded-md p-3 text-sm"
						style={{
							right: '100%',
							top: '50%',
							transform: 'translateY(-50%)',
							minWidth: 200,
							backgroundColor: theme.colors.bgMain,
							border: `1px solid ${theme.colors.border}`,
							boxShadow: '0 8px 24px -8px rgba(0, 0, 0, 0.5)',
							color: theme.colors.textMain,
							zIndex: 1,
						}}
					>
						<div>Clear all strokes?</div>
						<div className="flex justify-end gap-2">
							<button
								type="button"
								onClick={() => setConfirmingClear(false)}
								className="px-2 py-1 rounded hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textDim }}
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={handleConfirmClear}
								className="px-2 py-1 rounded transition-opacity hover:opacity-90"
								style={{
									backgroundColor: theme.colors.error,
									color: theme.colors.accentForeground,
								}}
							>
								Clear
							</button>
						</div>
					</div>
				)}
			</div>

			{divider}

			<GhostIconButton
				onClick={onToggleDrawer}
				ariaLabel="Drawing settings"
				title="Drawing settings"
				padding={BUTTON_PADDING}
				color={drawerOpen ? theme.colors.accent : theme.colors.textMain}
				style={drawerOpen ? { backgroundColor: `${theme.colors.accent}26` } : undefined}
			>
				<SlidersHorizontal className={ICON_CLASS} />
			</GhostIconButton>

			<GhostIconButton
				onClick={() => void handleCopy()}
				ariaLabel="Copy to clipboard"
				title="Copy to clipboard"
				padding={BUTTON_PADDING}
				color={theme.colors.textMain}
			>
				<Copy className={ICON_CLASS} />
			</GhostIconButton>

			<GhostIconButton
				onClick={handleSave}
				ariaLabel="Save"
				title="Save (⌘S)"
				padding={BUTTON_PADDING}
				color={theme.colors.success}
			>
				<Check className={ICON_CLASS} />
			</GhostIconButton>

			<GhostIconButton
				onClick={onCancel}
				ariaLabel="Cancel"
				title="Cancel (Esc)"
				padding={BUTTON_PADDING}
				color={theme.colors.textDim}
			>
				<X className={ICON_CLASS} />
			</GhostIconButton>
		</div>,
		document.body
	);
});

export default AnnotatorToolbar;
