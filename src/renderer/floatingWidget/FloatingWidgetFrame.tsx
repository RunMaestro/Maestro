/**
 * FloatingWidgetFrame - the card every desktop-level widget window draws.
 *
 * The window is frameless and transparent, so this card IS the window as the
 * user sees it: a rounded, bordered panel that fills it edge to edge. The
 * 32px title strip is the OS drag region (`WebkitAppRegion: 'drag'`), which
 * moves the real window; every control inside the strip opts out with
 * `no-drag`, or the OS would swallow its clicks. The OS resizes the window,
 * so there is no in-card resize grip.
 *
 * Two ways out: the X in the strip, and Escape anywhere in the window. A
 * nested surface that already used the Escape (a popover closing) marks it
 * `defaultPrevented`, and the frame leaves it alone.
 */

import { useCallback } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { X } from 'lucide-react';
import type { Theme } from '../types';
import { GhostIconButton } from '../components/ui/GhostIconButton';
import { useEventListener } from '../hooks/utils/useEventListener';

const DRAG_REGION = { WebkitAppRegion: 'drag' } as CSSProperties;
const NO_DRAG_REGION = { WebkitAppRegion: 'no-drag' } as CSSProperties;

export interface FloatingWidgetFrameProps {
	theme: Theme;
	/** Leading icon in the title strip, already sized (e.g. `w-3.5 h-3.5`). */
	icon: ReactNode;
	title: string;
	/** Secondary text after the title; truncates before the title does. */
	subtitle?: string;
	/** Extra strip controls, drawn before the close button. Always `no-drag`. */
	actions?: ReactNode;
	onClose: () => void;
	/** Override Escape when hiding and closing have different meanings. */
	onEscape?: () => void;
	/** Accessible label and tooltip for the close button. */
	closeLabel: string;
	children: ReactNode;
}

export function FloatingWidgetFrame({
	theme,
	icon,
	title,
	subtitle,
	actions,
	onClose,
	onEscape = onClose,
	closeLabel,
	children,
}: FloatingWidgetFrameProps) {
	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (e.key !== 'Escape' || e.defaultPrevented) return;
			if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
			e.preventDefault();
			onEscape();
		},
		[onEscape]
	);
	useEventListener('keydown', handleKeyDown as (e: Event) => void);

	return (
		<div
			data-testid="floating-widget-frame"
			className="fixed inset-0 flex flex-col rounded-lg border overflow-hidden select-none"
			style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
		>
			<div
				data-testid="floating-widget-title-strip"
				className="shrink-0 flex items-center gap-1.5 pl-2 pr-1.5 h-8 border-b"
				style={{ ...DRAG_REGION, borderColor: theme.colors.border }}
			>
				<span
					className="shrink-0 flex items-center"
					style={{ color: theme.colors.accent }}
					aria-hidden
				>
					{icon}
				</span>
				<span
					className="text-xs font-medium truncate shrink"
					style={{ color: theme.colors.textMain }}
					title={title}
				>
					{title}
				</span>
				{subtitle && (
					<span
						className="text-xs truncate shrink-[2] min-w-0"
						style={{ color: theme.colors.textDim }}
						title={subtitle}
					>
						{subtitle}
					</span>
				)}
				<span className="flex-1" />
				{actions && (
					<div className="shrink-0 flex items-center gap-0.5" style={NO_DRAG_REGION}>
						{actions}
					</div>
				)}
				<GhostIconButton
					onClick={onClose}
					title={closeLabel}
					ariaLabel={closeLabel}
					color={theme.colors.textDim}
					style={NO_DRAG_REGION}
					testId="floating-widget-close"
				>
					<X className="w-3.5 h-3.5" />
				</GhostIconButton>
			</div>

			<div className="flex-1 min-h-0 flex flex-col">{children}</div>
		</div>
	);
}
