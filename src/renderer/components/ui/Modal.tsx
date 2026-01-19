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

import React, { useRef, useEffect, ReactNode } from 'react';
import { X } from 'lucide-react';
import type { Theme } from '../../types';
import { useModalLayer, type UseModalLayerOptions } from '../../hooks';

export interface ModalProps {
	/** Theme object for styling */
	theme: Theme;
	/** Modal title displayed in the header */
	title: string;
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
	/** Modal width in pixels. Defaults to 400 */
	width?: number;
	/** Max height as CSS value (e.g., '90vh', '600px'). Defaults to '90vh' */
	maxHeight?: string;
	/** Whether clicking the backdrop closes the modal. Defaults to false */
	closeOnBackdropClick?: boolean;
	/** z-index for the modal. Defaults to 9999 */
	zIndex?: number;
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
}

/**
 * Reusable modal wrapper component that encapsulates common modal patterns
 */
export function Modal({
	theme,
	title,
	priority,
	onClose,
	children,
	footer,
	customHeader,
	headerIcon,
	width = 400,
	maxHeight = '90vh',
	closeOnBackdropClick = false,
	zIndex = 9999,
	showHeader = true,
	showCloseButton = true,
	layerOptions,
	initialFocusRef,
	testId,
}: ModalProps) {
	const containerRef = useRef<HTMLDivElement>(null);

	// Register with layer stack for Escape handling and focus management
	useModalLayer(priority, title, onClose, layerOptions);

	// Auto-focus on mount
	useEffect(() => {
		requestAnimationFrame(() => {
			if (initialFocusRef?.current) {
				initialFocusRef.current.focus();
			} else {
				// Focus the container for keyboard accessibility
				containerRef.current?.focus();
			}
		});
	}, [initialFocusRef]);

	const handleBackdropClick = (e: React.MouseEvent) => {
		// Only close if clicking directly on backdrop, not on modal content
		if (closeOnBackdropClick && e.target === e.currentTarget) {
			onClose();
		}
	};

	return (
		<div
			ref={containerRef}
			className="fixed inset-0 modal-overlay flex items-center justify-center animate-in fade-in duration-200 outline-none"
			style={{ zIndex }}
			role="dialog"
			aria-modal="true"
			aria-label={title}
			tabIndex={-1}
			onClick={handleBackdropClick}
			onKeyDown={(e) => e.stopPropagation()}
			data-testid={testId}
		>
			<div
				className="border rounded-lg shadow-2xl overflow-hidden flex flex-col"
				style={{
					width: `${width}px`,
					maxHeight,
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
				}}
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				{showHeader &&
					(customHeader || (
						<div
							className="p-4 border-b flex items-center justify-between shrink-0"
							style={{ borderColor: theme.colors.border }}
						>
							<div className="flex items-center gap-2">
								{headerIcon}
								<h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
									{title}
								</h2>
							</div>
							{showCloseButton && (
								<button
									type="button"
									onClick={onClose}
									className="p-1 rounded hover:bg-white/10 transition-colors"
									style={{ color: theme.colors.textDim }}
									aria-label="Close modal"
								>
									<X className="w-4 h-4" />
								</button>
							)}
						</div>
					))}

				{/* Content */}
				<div className="p-6 overflow-y-auto flex-1">{children}</div>

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
