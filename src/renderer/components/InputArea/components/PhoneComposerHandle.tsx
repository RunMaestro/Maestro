/**
 * PhoneComposerHandle - the grip that folds the composer away on a phone.
 *
 * On a handheld the composer (thinking pill, queue indicator, textarea, toolbar)
 * takes a third of the screen before the keyboard even opens, and most of the
 * time the user is READING, not typing. So on the phone layout the whole
 * composer collapses behind this slim bar; a tap or an upward swipe brings it
 * back, a tap or a downward swipe on the expanded bar folds it again.
 *
 * The bar carries the two things a collapsed composer must not hide: a pulsing
 * dot while the agent (or Auto Run) is working, since Stop lives in the folded
 * thinking pill, and a pencil when unsent text or staged images are waiting.
 */

import { ChevronDown, ChevronUp, Pencil } from 'lucide-react';
import type { Theme } from '../../../types';
import { useSwipeGestures } from '../../../hooks/utils/useSwipeGestures';

export interface PhoneComposerHandleProps {
	theme: Theme;
	/** True when the composer is folded away and this bar is all that shows. */
	collapsed: boolean;
	onToggle: () => void;
	/** The agent or Auto Run is working. */
	busy?: boolean;
	/** Unsent text or staged images are waiting behind the fold. */
	hasDraft?: boolean;
}

export function PhoneComposerHandle({
	theme,
	collapsed,
	onToggle,
	busy = false,
	hasDraft = false,
}: PhoneComposerHandleProps) {
	// Swipe in the direction the composer would move: up to reveal, down to fold.
	const swipe = useSwipeGestures({
		onSwipeUp: collapsed ? onToggle : undefined,
		onSwipeDown: collapsed ? undefined : onToggle,
	});
	const Chevron = collapsed ? ChevronUp : ChevronDown;

	return (
		<button
			type="button"
			onClick={onToggle}
			{...swipe.handlers}
			aria-expanded={!collapsed}
			aria-label={collapsed ? 'Show composer' : 'Hide composer'}
			data-testid="phone-composer-handle"
			className="w-full flex items-center justify-center gap-2 py-2 select-none outline-none"
			style={{
				backgroundColor: theme.colors.bgSidebar,
				color: theme.colors.textDim,
				borderTop: collapsed ? `1px solid ${theme.colors.border}` : undefined,
			}}
		>
			{busy && (
				<span
					className="w-2 h-2 rounded-full animate-pulse shrink-0"
					style={{ backgroundColor: theme.colors.warning }}
					title="Working"
					data-testid="phone-composer-handle-busy"
				/>
			)}
			<span
				className="h-1 w-10 rounded-full shrink-0"
				style={{ backgroundColor: theme.colors.border }}
				aria-hidden="true"
			/>
			{hasDraft && collapsed && (
				<Pencil
					className="w-3 h-3 shrink-0"
					style={{ color: theme.colors.warning }}
					aria-hidden="true"
					data-testid="phone-composer-handle-draft"
				/>
			)}
			<Chevron className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
		</button>
	);
}
