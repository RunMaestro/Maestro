/**
 * AgentStatusDot - the small status dot the Left Bar draws for an agent.
 *
 * Presentational only. Color, pulse, label, and the hollow signal come from
 * `useAgentStatusIndicator()` (`SessionItem.tsx`), which wraps the one status
 * resolver `getEnhancedStatusColor()`. Never derive a status color here or at
 * a call site.
 *
 * Children render inside the dot's box, for a corner badge (the Left Bar's
 * unread mark).
 */

import type { ReactNode } from 'react';
import type { Theme } from '../../types';

export interface AgentStatusDotProps {
	theme: Theme;
	color: string;
	/** Pulse ring plus glow, for working states. */
	animate: boolean;
	/** An outline instead of a fill: a Claude agent with no provider session yet. */
	hollow: boolean;
	/** Tooltip text. */
	title: string;
	/** Extra classes on the outer box (positioning). */
	className?: string;
	children?: ReactNode;
}

export function AgentStatusDot({
	theme,
	color,
	animate,
	hollow,
	title,
	className,
	children,
}: AgentStatusDotProps) {
	return (
		<div className={`relative w-2 h-2${className ? ` ${className}` : ''}`}>
			{/* Pulse ring: only renders for animated states, sits behind the dot */}
			{animate && (
				<span
					className="absolute inset-0 rounded-full animate-ping"
					style={{ backgroundColor: color, opacity: 0.3 }}
					aria-hidden="true"
				/>
			)}
			{/* Core status dot: filled by default, hollow when Claude has no provider session */}
			<div
				className="relative w-2 h-2 rounded-full"
				style={
					hollow
						? {
								border: `1.5px solid ${theme.colors.textDim}`,
								backgroundColor: 'transparent',
							}
						: {
								backgroundColor: color,
								boxShadow: animate ? `0 0 6px ${color}60` : undefined,
							}
				}
				title={title}
				data-testid="agent-status-dot"
			/>
			{children}
		</div>
	);
}
