/**
 * Modal - Reusable modal wrapper component
 *
 * This component provides consistent modal UI structure across the application,
 * combining the useModalLayer hook for layer stack management with standardized
 * backdrop, container, header, and footer patterns.
 *
 * Features:
 * - Automatic layer stack registration via useModalLayer
 * - Consistent themed styling (backdrop, borders, colors)
 * - Configurable width and max height
 * - Optional header with title and close button
 * - Optional footer for action buttons
 * - Auto-focus support for initial focus target
 * - Escape key handling via layer stack
 * - Accessible dialog semantics (role, aria-modal, aria-label)
 *
 * Usage:
 * ```tsx
 * <Modal
 *   theme={theme}
 *   title="Confirm Action"
 *   priority={MODAL_PRIORITIES.CONFIRM}
 *   onClose={handleClose}
 *   footer={
 *     <>
 *       <button onClick={handleClose}>Cancel</button>
 *       <button onClick={handleConfirm}>Confirm</button>
 *     </>
 *   }
 * >
 *   <p>Are you sure you want to proceed?</p>
 * </Modal>
 * ```
 */

import React, { useRef, useEffect, ReactNode, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { GhostIconButton } from './GhostIconButton';
import type { Theme } from '../../types';
import { useModalLayer, type UseModalLayerOptions } from '../../hooks';
import { useResizableModal, type ModalResizeDirection } from '../../hooks/ui/useResizableModal';
import type { ModalResizeKey, ModalSize } from '../../utils/modalSizing';
import { ResizeHandles } from './ResizeHandles';

/** Edges a top-left-anchored floating window can resize from without moving. */
const FLOATING_RESIZE_DIRECTIONS: ModalResizeDirection[] = ['e', 'se', 's'];

function getDefaultResizeKey(priority: number, title: string): ModalResizeKey {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
	return `modal-${priority}-${slug || 'dialog'}`;
}

/**
 * Turns a Modal into a free-positioned, non-blocking window.
 *
 * A floating Modal is the SAME element as the docked one, just styled
 * differently - deliberately, so a surface can offer a dock/pop-out toggle
 * without React unmounting the frame's subtree. A dialog that rebuilt itself on
 * every toggle would restart whatever lives inside it (an iframe, a media
 * element, a scroll position).
 *
 * While floating the modal has no backdrop, registers a PASSIVE layer (Escape
 * still closes it at its priority, but it takes no focus and does not blank the
 * app's shortcuts), and resizes from its bottom/right edges only, since its
 * top-left corner is what pins it.
 */
export interface ModalFloatingConfig {
	/** Top-left corner in viewport pixels. */
	position: { x: number; y: number };
	/**
	 * Pointer-down on the header, which doubles as the drag handle. Use
	 * `usePointerDrag` with `ignoreButtons` so the header's own buttons still
	 * click.
	 */
	onMovePointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
}

export interface ModalProps {
	/** Theme object for styling */
	theme: Theme;
	/** Modal title displayed in the header */
	title: string;
	/**
	 * Optional dimmed text rendered after the title, for the subject the modal
	 * is acting on: which agent, which repo, which file. A modal opened from a
	 * right-click menu can target something other than the highlighted agent,
	 * and without this the header gives the user no way to tell.
	 *
	 * Tested for truthiness rather than against `undefined`/`null`/`''`: the
	 * idiomatic `subtitle={agent && agent.name}` yields `false`, which would
	 * otherwise paint the separator with nothing after it.
	 *
	 * Deliberately separate from `title` rather than concatenated into it.
	 * `title` is the `aria-label` and the modal-layer label, and it seeds the
	 * fallback resize key (`getDefaultResizeKey`) - folding a per-agent string
	 * into it would mint a different persisted window size for every agent.
	 */
	subtitle?: ReactNode;
	/** Modal priority from MODAL_PRIORITIES constant */
	priority: number;
	/** Callback when modal should close (via X button, Escape, or backdrop click) */
	onClose: () => void;
	/** Modal content */
	children: ReactNode;
	/** Optional footer content (typically action buttons) */
	footer?: ReactNode;
	/** Optional custom header content (replaces default title + close button) */
	customHeader?: ReactNode;
	/** Optional icon to display before the title */
	headerIcon?: ReactNode;
	/**
	 * Optional content rendered in the header, just before the close button.
	 * For secondary affordances that belong to the modal as a whole (a "View
	 * History" link, a filter toggle) rather than to its body. Use this instead
	 * of `customHeader` when you only want to ADD to the standard header.
	 */
	headerActions?: ReactNode;
	/** Modal width in pixels. Defaults to 400 */
	width?: number;
	/**
	 * Scale the width with the Cmd+= font-size setting via --font-scale (14px
	 * baseline → scale 1). `width` is the baseline and the modal grows/shrinks
	 * proportionally with the font, clamped to 95vw. This is on by default: at
	 * the baseline font it's a no-op, and at larger fonts it keeps button rows
	 * and headers from wrapping/clipping inside a fixed-px shell. Pass `false`
	 * only for a modal that must stay a literal pixel width regardless of font.
	 */
	scaleWidthWithFont?: boolean;
	/**
	 * Upper bound on the modal width as a CSS value, used as the clamp ceiling
	 * for the font-scaled width. Defaults to '95vw'. Pass e.g. '50vw' to keep a
	 * wide modal from dominating large displays.
	 */
	maxWidthCss?: string;
	/** Max height as CSS value (e.g., '90vh', '600px'). Defaults to '90vh' */
	maxHeight?: string;
	/** Whether clicking the backdrop closes the modal. Defaults to false */
	closeOnBackdropClick?: boolean;
	/** z-index for the modal. Defaults to 9999 */
	zIndex?: number;
	/**
	 * Keep the modal mounted but inert and off screen. For a modal whose content
	 * owns live state that must survive being closed - an iframe mid-interaction,
	 * a running media element - where the usual `{isOpen && <Modal/>}` pattern
	 * would destroy it. While hidden the overlay is `display: none`, no layer is
	 * registered (so Escape and the focus trap belong to whatever is underneath),
	 * and the auto-focus does not run. Callers that have nothing to preserve
	 * should keep conditionally rendering instead - it is cheaper.
	 */
	hidden?: boolean;
	/** Whether to show the default header. Defaults to true */
	showHeader?: boolean;
	/** Whether to show the close button in header. Defaults to true */
	showCloseButton?: boolean;
	/** Additional options for useModalLayer hook */
	layerOptions?: Omit<UseModalLayerOptions, 'onEscape'>;
	/** Ref to the element that should receive initial focus */
	initialFocusRef?: React.RefObject<HTMLElement>;
	/** Test ID for the modal container */
	testId?: string;
	/** Override className for the content wrapper (default: 'p-6 overflow-y-auto flex-1') */
	contentClassName?: string;
	/** Allow content to overflow the modal container (e.g., for dropdowns). Defaults to false */
	allowOverflow?: boolean;
	/** Ref to the inner modal card (used by callers that need to animate the card itself) */
	cardRef?: React.Ref<HTMLDivElement>;
	/**
	 * Render into `document.body` instead of in place. Required for any modal
	 * opened from inside the Main Panel: `MainPanel.tsx` wraps the session view
	 * in `isolate` (`isolation: isolate`), which creates a stacking context, so
	 * the backdrop's z-index is scoped to that subtree and the Left Bar
	 * (`relative z-20`) and Right Panel (later in DOM order) paint over it -
	 * the panels stay bright while only the center dims. No z-index can win
	 * across a stacking context; escaping to the body is the fix. Defaults to
	 * false since most modals already mount at the App root.
	 */
	portal?: boolean;
	/** Enable persisted modal resizing. Defaults to true, but has no effect without `resizeKey` (see below). */
	resizable?: boolean;
	/**
	 * Stable settings key used to persist this modal's size. Resizing is only
	 * enabled when this is explicitly provided: a title-derived fallback key
	 * isn't stable across unrelated dialogs (e.g. every default-titled
	 * ConfirmModal would collide on one persisted size), so a Modal without
	 * a `resizeKey` renders with the legacy fixed `width`/`maxHeight` sizing.
	 */
	resizeKey?: ModalResizeKey;
	/** Default resizable frame size in pixels. Width falls back to `width`; height defaults to 320. */
	defaultSize?: Partial<ModalSize>;
	/** Minimum resizable frame size in pixels. */
	minSize?: Partial<ModalSize>;
	/** Maximum resizable frame size in pixels before viewport clamping. */
	maxSize?: Partial<ModalSize>;
	/**
	 * Render as a floating, non-blocking window instead of a centered dialog.
	 * See ModalFloatingConfig. Pass `null`/omit for the normal docked dialog.
	 */
	floating?: ModalFloatingConfig | null;
}

/**
 * The dimmed "which thing is this acting on" text in a modal header.
 *
 * `<Modal>` renders this for you from its `subtitle` prop. Export exists for
 * the modal shells that build their own header - a bespoke `<h2>` layout, or a
 * `customHeader` that replaces `<Modal>`'s header wholesale - so every surface
 * gets the same dim, the same separator, and the same
 * `data-testid="modal-subtitle"` rather than three drifting copies.
 *
 * Guarded on truthiness rather than `undefined`/`null`/`''`: the idiomatic
 * `subtitle={agent && agent.name}` yields `false`, which a three-way check
 * lets through and which would paint the separator with nothing after it.
 */
export function ModalSubtitle({ theme, subtitle }: { theme: Theme; subtitle?: ReactNode }) {
	if (!subtitle) return null;
	return (
		<span
			className="text-sm truncate min-w-0"
			style={{ color: theme.colors.textDim }}
			data-testid="modal-subtitle"
		>
			<span aria-hidden="true">{'\u00b7'} </span>
			{subtitle}
		</span>
	);
}

/**
 * Reusable modal wrapper component that encapsulates common modal patterns
 */
export function Modal({
	theme,
	title,
	subtitle,
	priority,
	onClose,
	children,
	footer,
	customHeader,
	headerIcon,
	headerActions,
	width = 400,
	scaleWidthWithFont = true,
	maxWidthCss = '95vw',
	maxHeight = '90vh',
	closeOnBackdropClick = false,
	zIndex = 9999,
	hidden = false,
	showHeader = true,
	showCloseButton = true,
	layerOptions,
	initialFocusRef,
	testId,
	contentClassName,
	allowOverflow = false,
	cardRef,
	portal = false,
	resizable = true,
	resizeKey,
	defaultSize,
	minSize,
	maxSize,
	floating = null,
}: ModalProps) {
	const isFloating = floating !== null;
	const containerRef = useRef<HTMLDivElement>(null);
	const cardElementRef = useRef<HTMLDivElement | null>(null);
	// Resizing requires a caller-supplied resizeKey. A title-derived fallback key
	// is not stable across unrelated dialogs (e.g. every default-titled ConfirmModal
	// would collide on the same persisted size), so without an explicit key we fall
	// back to the legacy fixed-size rendering below instead of enabling resize.
	const effectiveResizeKey = resizeKey ?? getDefaultResizeKey(priority, title);
	const resizingEnabled = resizable && resizeKey !== undefined;
	const resizableModal = useResizableModal({
		resizeKey: effectiveResizeKey,
		defaultSize: {
			width: defaultSize?.width ?? width,
			height: defaultSize?.height ?? 320,
		},
		minSize,
		maxSize,
		enabled: resizingEnabled,
		externalRef: cardElementRef,
		anchor: isFloating ? 'topLeft' : 'center',
	});

	// Register with layer stack for Escape handling and focus management. A hidden
	// modal registers nothing: it is on screen for nobody, so it must not eat
	// Escape or trap focus away from the app behind it. A floating one registers
	// passively: it sits BESIDE the app rather than over it, so blocking the
	// app's shortcuts or trapping focus would make the rest of Maestro go dead
	// while the window is merely open.
	useModalLayer(priority, title, onClose, {
		...layerOptions,
		enabled: (layerOptions?.enabled ?? true) && !hidden,
		...(isFloating
			? {
					blocksLowerLayers: false,
					capturesFocus: false,
					blocksAppShortcuts: false,
					focusTrap: 'none' as const,
				}
			: null),
	});

	// Auto-focus on mount, and again whenever a hidden modal is shown. A floating
	// window never grabs focus: the point of popping out is to keep working in
	// the app beside it, and stealing the caret out of the composer would undo that.
	useEffect(() => {
		if (hidden || isFloating) return;
		requestAnimationFrame(() => {
			if (initialFocusRef?.current) {
				initialFocusRef.current.focus();
			} else {
				// Focus the container for keyboard accessibility
				containerRef.current?.focus();
			}
		});
	}, [hidden, isFloating, initialFocusRef]);

	const handleBackdropClick = (e: React.MouseEvent) => {
		// Only close if clicking directly on backdrop, not on modal content.
		// Stop propagation so a parent modal's backdrop handler doesn't also
		// fire, which matters when a Modal renders nested inside another modal
		// (e.g. AgentDetailModal inside UsageDashboardModal); without this
		// the outer modal would close too.
		if (closeOnBackdropClick && e.target === e.currentTarget) {
			e.stopPropagation();
			onClose();
		}
	};

	const setCardRef = useCallback(
		(node: HTMLDivElement | null) => {
			cardElementRef.current = node;
			if (typeof cardRef === 'function') {
				cardRef(node);
			} else if (cardRef) {
				(cardRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
			}
		},
		[cardRef]
	);

	const overlay = (
		<div
			ref={containerRef}
			// Floating: no backdrop, and the layer itself is click-through so only
			// the card takes the pointer. Docked: the usual dimmed, centered dialog.
			className={
				isFloating
					? 'fixed inset-0 pointer-events-none outline-none'
					: 'fixed inset-0 modal-overlay flex items-center justify-center animate-in fade-in duration-200 outline-none'
			}
			style={{ zIndex, ...(hidden ? { display: 'none' } : null) }}
			role="dialog"
			aria-modal={isFloating ? undefined : 'true'}
			aria-label={title}
			aria-hidden={hidden || undefined}
			data-floating={isFloating || undefined}
			tabIndex={-1}
			onClick={isFloating ? undefined : handleBackdropClick}
			onKeyDown={(e) => e.stopPropagation()}
			data-testid={testId}
		>
			<div
				ref={setCardRef}
				className={`relative border rounded-lg shadow-2xl flex flex-col ${allowOverflow ? 'overflow-visible' : 'overflow-hidden'} ${
					isFloating ? 'pointer-events-auto absolute' : ''
				}`}
				style={{
					...(resizingEnabled
						? resizableModal.style
						: {
								width: scaleWidthWithFont
									? `min(calc(${width}px * var(--font-scale, 1)), ${maxWidthCss})`
									: `${width}px`,
								maxHeight,
							}),
					...(floating ? { left: floating.position.x, top: floating.position.y } : null),
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
				}}
				onClick={(e) => e.stopPropagation()}
				data-modal-resize-key={resizingEnabled ? effectiveResizeKey : undefined}
			>
				{resizingEnabled && (
					<ResizeHandles
						onResizeStart={resizableModal.onResizeStart}
						accentColor={theme.colors.accent}
						onResetSize={resizableModal.onResetSize}
						canReset={resizableModal.canReset}
						// A top-left-pinned window can only grow down and right without
						// also moving, so it offers exactly those edges.
						directions={isFloating ? FLOATING_RESIZE_DIRECTIONS : undefined}
					/>
				)}

				{/* Header. While floating it doubles as the drag handle - the whole bar,
				    which is the affordance users already expect from a window title. */}
				{showHeader &&
					(customHeader || (
						<div
							className={`p-4 border-b flex items-center justify-between shrink-0 ${
								isFloating ? 'cursor-grab active:cursor-grabbing select-none' : ''
							}`}
							style={{ borderColor: theme.colors.border }}
							onPointerDown={floating?.onMovePointerDown}
							data-testid={isFloating ? 'modal-float-handle' : undefined}
						>
							<div className="flex items-center gap-2 min-w-0">
								{headerIcon}
								<h2 className="text-sm font-bold shrink-0" style={{ color: theme.colors.textMain }}>
									{title}
								</h2>
								<ModalSubtitle theme={theme} subtitle={subtitle} />
							</div>
							<div className="flex items-center gap-2">
								{headerActions}
								{showCloseButton && (
									<GhostIconButton
										onClick={onClose}
										ariaLabel="Close modal"
										color={theme.colors.textDim}
									>
										<X className="w-4 h-4" />
									</GhostIconButton>
								)}
							</div>
						</div>
					))}

				{/* Content */}
				<div className={contentClassName ?? 'p-6 overflow-y-auto flex-1 min-h-0'}>{children}</div>

				{/* Footer */}
				{footer && (
					<div
						className="p-4 border-t flex justify-end gap-2 shrink-0"
						style={{ borderColor: theme.colors.border }}
					>
						{footer}
					</div>
				)}
			</div>
		</div>
	);

	return portal ? createPortal(overlay, document.body) : overlay;
}

/**
 * ModalFooter - Standard footer button layout helper
 *
 * Usage:
 * ```tsx
 * <Modal footer={
 *   <ModalFooter
 *     theme={theme}
 *     onCancel={handleClose}
 *     onConfirm={handleSubmit}
 *     confirmLabel="Save"
 *     confirmDisabled={!isValid}
 *   />
 * }>
 *   ...
 * </Modal>
 * ```
 */
export interface ModalFooterProps {
	theme: Theme;
	/** Cancel button click handler */
	onCancel: () => void;
	/** Confirm button click handler */
	onConfirm: () => void;
	/** Cancel button label. Defaults to 'Cancel' */
	cancelLabel?: string;
	/** Confirm button label. Defaults to 'Confirm' */
	confirmLabel?: string;
	/** Whether confirm button is disabled */
	confirmDisabled?: boolean;
	/** Whether confirm button uses destructive (error) color. Defaults to false */
	destructive?: boolean;
	/** Whether to show cancel button. Defaults to true */
	showCancel?: boolean;
	/** Additional class name for confirm button */
	confirmClassName?: string;
	/** Ref to attach to confirm button for focus management */
	confirmButtonRef?: React.RefObject<HTMLButtonElement>;
	/** Ref to attach to cancel button for focus management */
	cancelButtonRef?: React.RefObject<HTMLButtonElement>;
}

export function ModalFooter({
	theme,
	onCancel,
	onConfirm,
	cancelLabel = 'Cancel',
	confirmLabel = 'Confirm',
	confirmDisabled = false,
	destructive = false,
	showCancel = true,
	confirmClassName = '',
	confirmButtonRef,
	cancelButtonRef,
}: ModalFooterProps) {
	// Stop Enter key propagation to prevent parent handlers from triggering after modal closes
	const handleKeyDown = (e: React.KeyboardEvent, action: () => void) => {
		if (e.key === 'Enter') {
			e.stopPropagation();
			action();
		}
	};

	return (
		<>
			{showCancel && (
				<button
					ref={cancelButtonRef}
					type="button"
					onClick={onCancel}
					onKeyDown={(e) => handleKeyDown(e, onCancel)}
					className="px-4 py-2 rounded border hover:bg-white/5 transition-colors outline-none focus:ring-2 focus:ring-offset-1"
					style={{
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
					}}
				>
					{cancelLabel}
				</button>
			)}
			<button
				ref={confirmButtonRef}
				type="button"
				onClick={onConfirm}
				onKeyDown={(e) => !confirmDisabled && handleKeyDown(e, onConfirm)}
				disabled={confirmDisabled}
				className={`px-4 py-2 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed outline-none focus:ring-2 focus:ring-offset-1 ${confirmClassName}`}
				style={{
					backgroundColor: destructive ? theme.colors.error : theme.colors.accent,
					color: destructive ? '#ffffff' : theme.colors.accentForeground,
				}}
			>
				{confirmLabel}
			</button>
		</>
	);
}

export default Modal;
