/**
 * QuitWhenIdleIndicator.tsx
 *
 * Small pill shown while a "Quit when idle" is armed. Reassures the user the app
 * will quit once all operations finish, and gives them a Cancel button to back
 * out. Renders in normal flow at the top of the input area, above the thinking
 * pill, so the two stack without overlap. Renders nothing when not armed.
 */

import { Hourglass, X } from 'lucide-react';
import type { Theme } from '../types';
import { useQuitWhenIdleStore } from '../stores/quitWhenIdleStore';

interface QuitWhenIdleIndicatorProps {
	theme: Theme;
}

export function QuitWhenIdleIndicator({ theme }: QuitWhenIdleIndicatorProps): JSX.Element | null {
	const armed = useQuitWhenIdleStore((s) => s.armed);
	const cancel = useQuitWhenIdleStore((s) => s.cancel);

	if (!armed) {
		return null;
	}

	return (
		// Centered container with negative top margin to offset parent padding
		// (matching ThinkingStatusPill). The extra bottom margin keeps a clean gap
		// even when the thinking pill renders directly below with its own -mt-2.
		<div className="relative flex justify-center pb-2 mb-2 -mt-2 min-w-0 px-2">
			{/* `max-w-full min-w-0` bounds the pill to the available width so the label
			    truncates on narrow viewports instead of pushing Cancel off-screen. */}
			<div
				className="flex items-center gap-2.5 pl-4 pr-2 py-1.5 rounded-full max-w-full min-w-0"
				style={{
					backgroundColor: theme.colors.warning + '20',
					border: `1px solid ${theme.colors.border}`,
				}}
			>
				<Hourglass
					className="w-3.5 h-3.5 shrink-0 animate-pulse"
					style={{ color: theme.colors.warning }}
				/>
				<span
					className="text-xs font-medium truncate min-w-0"
					style={{ color: theme.colors.textMain }}
					title="Quitting When All Operations Finish"
				>
					Quitting When All Operations Finish
				</span>
				<button
					onClick={cancel}
					className="flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium outline-none transition-colors hover:opacity-90 shrink-0"
					style={{
						backgroundColor: theme.colors.accent,
						color: theme.colors.accentForeground,
					}}
					title="Cancel quit"
				>
					<X className="w-3 h-3" />
					Cancel
				</button>
			</div>
		</div>
	);
}
