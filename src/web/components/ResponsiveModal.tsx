/**
 * ResponsiveModal component for Maestro web interface
 *
 * Mirrors the desktop `src/renderer/components/ui/Modal.tsx` API shape at wide
 * viewports while rendering as a bottom sheet on phones. The prop surface is a
 * pared-down subset of the desktop Modal's (see Phase 4 Task 4.1 notes): the
 * web UI has no modal-layer stack, so Escape and focus trap are handled
 * locally instead of through `useModalLayer`.
 *
 * Responsive behaviour:
 * - Phone (< 600px — see `BREAKPOINTS.tablet`): full-width, bottom-anchored
 *   sheet with slide-up animation, rounded top corners, `env(safe-area-inset-bottom)`.
 * - Tablet/desktop (>= 600px): centered card with dim backdrop and fade+scale
 *   animation. Width caps at `min(width, calc(100vw - 32px))`.
 *
 * Always:
 * - Backdrop click closes (no `closeOnBackdropClick` escape hatch — per Phase 4 spec).
 * - Escape closes.
 * - The dialog container receives focus on open (matches the desktop Modal);
 *   a first Tab press routes focus to the first focusable element inside.
 * - Tab/Shift+Tab wraps within the modal (focus trap).
 */

import React, { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useBreakpoint } from '../hooks/useBreakpoint';

export interface ResponsiveModalProps {
	/** Whether the modal is visible */
	isOpen: boolean;
	/** Callback invoked when the modal should close (X button, Escape, or backdrop click) */
	onClose: () => void;
	/** Modal title — displayed in the header and announced via `aria-label` */
	title: string;
	/** Optional icon rendered before the title */
	headerIcon?: ReactNode;
	/**
	 * Modal width in pixels at tablet+. Capped to `min(width, calc(100vw - 32px))`.
	 * Ignored at phone tier (which always uses full viewport width).
	 * Defaults to 480.
	 */
	width?: number;
	/** z-index of the modal overlay. Defaults to 400 (matches `--z-modal`). */
	zIndex?: number;
	/** Modal body content */
	children: ReactNode;
	/** Optional footer content (typically action buttons) */
	footer?: ReactNode;
}

/** Selectors for elements considered focusable for the focus-trap cycle. */
const FOCUSABLE_SELECTOR = [
	'a[href]',
	'area[href]',
	'button:not([disabled])',
	'input:not([disabled]):not([type="hidden"])',
	'select:not([disabled])',
	'textarea:not([disabled])',
	'iframe',
	'object',
	'embed',
	'[contenteditable="true"]',
	'[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
	if (!root) return [];
	return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
		(el) => !el.hasAttribute('disabled') && el.tabIndex !== -1
	);
}

export function ResponsiveModal({
	isOpen,
	onClose,
	title,
	headerIcon,
	width = 480,
	zIndex = 400,
	children,
	footer,
}: ResponsiveModalProps) {
	const { isPhone, isShortViewport } = useBreakpoint();
	const containerRef = useRef<HTMLDivElement>(null);
	// Short viewport (landscape phone, <500px tall) squeezes the default
	// `max-h-[90vh]` cap too aggressively. Task 5.5 spec: cap at
	// `calc(100vh - 24px)` so the modal can claim all vertical real estate
	// except a 12px gutter on each side. The body stays scrollable via
	// `overflow-y-auto flex-1`, keeping the header/footer pinned.
	const maxHeightClass = isShortViewport ? 'max-h-[calc(100vh-24px)]' : 'max-h-[90vh]';

	// Auto-focus the dialog container on open. Matches the desktop Modal
	// behaviour — keyboard users can Tab into content, and screen readers
	// anchor announcements on the dialog role. Tab-from-container is then
	// routed to the first focusable element by `handleKeyDown` below.
	useEffect(() => {
		if (!isOpen) return;
		const frame = requestAnimationFrame(() => {
			containerRef.current?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [isOpen]);

	// Lock background scroll while the modal is visible. The desktop
	// `Modal.tsx` gets this for free via the renderer's `LayerStack`; the
	// web variant uses local Escape/focus handling, so we manage
	// `document.body.style.overflow` ourselves. Restore the previous value
	// on close so we play nicely with stacked modals.
	useEffect(() => {
		if (!isOpen) return;
		if (typeof document === 'undefined') return;
		const previous = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => {
			document.body.style.overflow = previous;
		};
	}, [isOpen]);

	// Escape-to-close, attached globally while open so it works regardless of focus location.
	useEffect(() => {
		if (!isOpen) return;
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [isOpen, onClose]);

	// Focus-trap: cycle Tab/Shift+Tab at the first/last focusable element.
	// When focus is on the dialog container itself (the initial state), route
	// to the first/last focusable so users can tab into content without falling
	// out of the modal.
	const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.key !== 'Tab') return;
		const container = containerRef.current;
		if (!container) return;
		const focusables = getFocusableElements(container);
		if (focusables.length === 0) {
			e.preventDefault();
			container.focus();
			return;
		}
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		const active = document.activeElement as HTMLElement | null;
		const outsideContent = active === container || !container.contains(active);
		if (e.shiftKey && (active === first || outsideContent)) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && (active === last || outsideContent)) {
			e.preventDefault();
			first.focus();
		}
	}, []);

	const handleBackdropClick = useCallback(
		(e: React.MouseEvent<HTMLDivElement>) => {
			if (e.target === e.currentTarget) {
				onClose();
			}
		},
		[onClose]
	);

	// Cap width at the viewport edge minus 32px (16px gutter per side) on
	// tablet+. Using `maxWidth: calc(100vw - 32px)` + fixed `width` is
	// equivalent to `width: min(...)` and is tractable in jsdom's CSS parser.
	const capStyle = useMemo(
		() => ({
			width: `${width}px`,
			maxWidth: 'calc(100vw - 32px)',
		}),
		[width]
	);

	if (!isOpen) return null;

	if (isPhone) {
		return (
			<div
				className="fixed inset-0 flex items-end bg-black/50 animate-fadeIn"
				style={{ zIndex }}
				onClick={handleBackdropClick}
				role="presentation"
			>
				<div
					ref={containerRef}
					role="dialog"
					aria-modal="true"
					aria-label={title}
					tabIndex={-1}
					onKeyDown={handleKeyDown}
					className={`w-full ${maxHeightClass} flex flex-col bg-bg-sidebar border-t border-border rounded-t-2xl shadow-2xl outline-none animate-slideUp safe-area-bottom`}
				>
					<header className="p-4 border-b border-border flex items-center justify-between shrink-0">
						<div className="flex items-center gap-2 min-w-0">
							{headerIcon}
							<h2 className="text-sm font-bold text-text-main truncate">{title}</h2>
						</div>
						<button
							type="button"
							onClick={onClose}
							aria-label="Close modal"
							className="shrink-0 inline-flex items-center justify-center min-w-[32px] min-h-[32px] rounded text-text-dim hover:bg-white/5 hover:text-text-main transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent"
						>
							<X className="w-4 h-4" />
						</button>
					</header>
					<div className="p-4 overflow-y-auto flex-1">{children}</div>
					{footer && (
						<div className="p-4 border-t border-border flex flex-col gap-2 shrink-0">{footer}</div>
					)}
				</div>
			</div>
		);
	}

	return (
		<div
			className="fixed inset-0 flex items-center justify-center bg-black/50 animate-fadeIn"
			style={{ zIndex }}
			onClick={handleBackdropClick}
			role="presentation"
		>
			<div
				ref={containerRef}
				role="dialog"
				aria-modal="true"
				aria-label={title}
				tabIndex={-1}
				onKeyDown={handleKeyDown}
				className={`${maxHeightClass} flex flex-col bg-bg-sidebar border border-border rounded-lg shadow-2xl outline-none animate-modalIn`}
				style={capStyle}
			>
				<header className="p-4 border-b border-border flex items-center justify-between shrink-0">
					<div className="flex items-center gap-2 min-w-0">
						{headerIcon}
						<h2 className="text-sm font-bold text-text-main truncate">{title}</h2>
					</div>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close modal"
						className="shrink-0 inline-flex items-center justify-center min-w-[32px] min-h-[32px] rounded text-text-dim hover:bg-white/5 hover:text-text-main transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent"
					>
						<X className="w-4 h-4" />
					</button>
				</header>
				<div className="p-6 overflow-y-auto flex-1">{children}</div>
				{footer && (
					<div className="p-4 border-t border-border flex justify-end gap-2 shrink-0">{footer}</div>
				)}
			</div>
		</div>
	);
}

export default ResponsiveModal;
