/**
 * InlineHelp - Small contextual help chip with hover/focus tooltip
 *
 * Renders a "?" icon button. On hover or focus the `children` content
 * appears in a floating tooltip positioned above the trigger. Useful for
 * clarifying field labels, settings options, or complex UI elements without
 * cluttering the layout.
 *
 * Usage:
 * ```tsx
 * <InlineHelp label="What is context grooming?">
 *   Automatically trims old messages to stay within the model context window.
 * </InlineHelp>
 *
 * // Custom trigger label (shown as accessible aria-label):
 * <InlineHelp label="Why is this disabled?">
 *   SSH remote mode is required to use this feature.
 * </InlineHelp>
 * ```
 */

import { useState, useRef, useId } from 'react';
import type { ReactNode } from 'react';
import { HelpCircle } from 'lucide-react';

export interface InlineHelpProps {
	/** Tooltip content (text or JSX) */
	children: ReactNode;
	/** Accessible label for the trigger button. Defaults to "Help" */
	label?: string;
}

export function InlineHelp({ children, label = 'Help' }: InlineHelpProps) {
	const [visible, setVisible] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const tooltipId = useId();

	const show = () => setVisible(true);
	const hide = () => setVisible(false);

	return (
		<span className="relative inline-flex items-center">
			<button
				ref={triggerRef}
				type="button"
				aria-label={label}
				aria-describedby={visible ? tooltipId : undefined}
				onMouseEnter={show}
				onMouseLeave={hide}
				onFocus={show}
				onBlur={hide}
				onClick={() => setVisible((v) => !v)}
				className="inline-flex items-center justify-center w-4 h-4 rounded-full opacity-50 hover:opacity-100 focus:opacity-100 transition-opacity focus:outline-none"
			>
				<HelpCircle className="w-3.5 h-3.5" aria-hidden="true" />
			</button>

			{visible && (
				<span
					id={tooltipId}
					role="tooltip"
					className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 min-w-max max-w-xs px-3 py-2 rounded-md text-xs shadow-lg pointer-events-none"
					style={{
						backgroundColor: 'rgba(0,0,0,0.85)',
						color: '#f8f8f2',
					}}
				>
					{children}
					{/* Arrow */}
					<span
						className="absolute top-full left-1/2 -translate-x-1/2 -mt-px"
						aria-hidden="true"
						style={{
							width: 0,
							height: 0,
							borderLeft: '5px solid transparent',
							borderRight: '5px solid transparent',
							borderTop: '5px solid rgba(0,0,0,0.85)',
						}}
					/>
				</span>
			)}
		</span>
	);
}

export default InlineHelp;
