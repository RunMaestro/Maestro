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
	Check,
	Copy,
	Eraser,
	Move,
	PenLine,
	SlidersHorizontal,
	Trash2,
	Undo2,
	X,
	type LucideIcon,
} from 'lucide-react';
import type { Theme } from '../../../shared/theme-types';
import { GhostIconButton } from '../ui/GhostIconButton';
import { useEventListener } from '../../hooks/utils/useEventListener';
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
	const { tool, setTool, strokes, undo, clear } = state;
	const [confirmingClear, setConfirmingClear] = useState(false);
	const confirmWrapRef = useRef<HTMLDivElement>(null);

	useEventListener('keydown', (event: Event) => {
		const e = event as KeyboardEvent;
		if (
			e.target instanceof HTMLInputElement ||
			e.target instanceof HTMLTextAreaElement ||
			(e.target instanceof HTMLElement && e.target.isContentEditable)
		) {
			return;
		}
		if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
			e.preventDefault();
			undo();
		}
	});

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
		if (strokes.length === 0 && confirmingClear) setConfirmingClear(false);
	}, [strokes.length, confirmingClear]);

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

	const renderToolButton = (value: AnnotatorTool, Icon: LucideIcon, label: string) => {
		const active = tool === value;
		return (
			<GhostIconButton
				onClick={() => setTool(value)}
				ariaLabel={label}
				title={label}
				color={active ? theme.colors.accent : theme.colors.textMain}
				style={active ? { backgroundColor: `${theme.colors.accent}26` } : undefined}
			>
				<Icon className="w-4 h-4" />
			</GhostIconButton>
		);
	};

	const divider = (
		<div
			aria-hidden
			style={{
				width: 1,
				height: 18,
				backgroundColor: theme.colors.border,
				margin: '0 4px',
			}}
		/>
	);

	const canUndo = strokes.length > 0;

	return createPortal(
		<div
			role="toolbar"
			aria-label="Image annotator toolbar"
			className="fixed top-4 left-1/2 flex items-center gap-1 rounded-lg px-2 py-1.5"
			style={{
				zIndex: 170,
				transform: 'translateX(-50%)',
				backgroundColor: `${theme.colors.bgSidebar}d9`,
				backdropFilter: 'blur(12px) saturate(150%)',
				WebkitBackdropFilter: 'blur(12px) saturate(150%)',
				border: `1px solid ${theme.colors.border}`,
				boxShadow: '0 8px 24px -8px rgba(0, 0, 0, 0.5)',
				pointerEvents: 'auto',
			}}
			onPointerDown={(e) => e.stopPropagation()}
			onWheel={(e) => e.stopPropagation()}
		>
			{renderToolButton('pen', PenLine, 'Pen')}
			{renderToolButton('eraser', Eraser, 'Eraser')}
			{renderToolButton('pan', Move, 'Pan')}

			{divider}

			<GhostIconButton
				onClick={undo}
				ariaLabel="Undo"
				title="Undo (⌘Z)"
				disabled={!canUndo}
				color={theme.colors.textMain}
			>
				<Undo2 className="w-4 h-4" />
			</GhostIconButton>

			<div ref={confirmWrapRef} style={{ position: 'relative' }}>
				<GhostIconButton
					onClick={() => {
						if (!canUndo) return;
						setConfirmingClear((v) => !v);
					}}
					ariaLabel="Clear all strokes"
					title="Clear all strokes"
					disabled={!canUndo}
					color={theme.colors.error}
				>
					<Trash2 className="w-4 h-4" />
				</GhostIconButton>
				{confirmingClear && (
					<div
						role="dialog"
						aria-label="Clear all strokes?"
						className="absolute left-1/2 mt-2 flex flex-col gap-2 rounded-md p-3 text-sm"
						style={{
							top: '100%',
							transform: 'translateX(-50%)',
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
				color={drawerOpen ? theme.colors.accent : theme.colors.textMain}
				style={drawerOpen ? { backgroundColor: `${theme.colors.accent}26` } : undefined}
			>
				<SlidersHorizontal className="w-4 h-4" />
			</GhostIconButton>

			<GhostIconButton
				onClick={() => void handleCopy()}
				ariaLabel="Copy to clipboard"
				title="Copy to clipboard"
				color={theme.colors.textMain}
			>
				<Copy className="w-4 h-4" />
			</GhostIconButton>

			<GhostIconButton
				onClick={handleSave}
				ariaLabel="Save"
				title="Save"
				color={theme.colors.success}
			>
				<Check className="w-4 h-4" />
			</GhostIconButton>

			<GhostIconButton
				onClick={onCancel}
				ariaLabel="Cancel"
				title="Cancel (Esc)"
				color={theme.colors.textDim}
			>
				<X className="w-4 h-4" />
			</GhostIconButton>
		</div>,
		document.body
	);
});

export default AnnotatorToolbar;
