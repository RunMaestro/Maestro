/**
 * GhostIconButton - Icon-only button with hover background
 *
 * Encapsulates the common "p-X rounded hover:bg-white/10 transition-colors" pattern
 * used throughout the app for toolbar-style icon buttons.
 *
 * Usage:
 * ```tsx
 * <GhostIconButton
 *   onClick={handleClose}
 *   ariaLabel="Close"
 *   title="Close"
 *   color={theme.colors.textDim}
 * >
 *   <X className="w-4 h-4" />
 * </GhostIconButton>
 * ```
 */

import React, { forwardRef } from 'react';
import type { CSSProperties, ReactNode, MouseEvent } from 'react';

export interface GhostIconButtonProps {
	/** Icon (or any) content inside the button */
	children: ReactNode;
	/** Click handler */
	onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
	/** Native tooltip */
	title?: string;
	/** Accessible label (recommended for icon-only buttons) */
	ariaLabel?: string;
	/** Padding tailwind utility. Defaults to 'p-1' */
	padding?: string;
	/** Icon/text color applied via inline style */
	color?: string;
	/** Extra class names appended after the default hover treatment */
	className?: string;
	/** Inline style overrides (merged after `color`) */
	style?: CSSProperties;
	/** Disabled state */
	disabled?: boolean;
	/** Button type. Defaults to 'button' */
	type?: 'button' | 'submit' | 'reset';
	/** Test id for automated tests */
	testId?: string;
	/** tabIndex override */
	tabIndex?: number;
	/** Keydown handler (e.g. custom focus handling) */
	onKeyDown?: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
	/** Whether to stop propagation on click. Defaults to false */
	stopPropagation?: boolean;
}

/**
 * Standard ghost-styled icon button.
 */
export const GhostIconButton = forwardRef<HTMLButtonElement, GhostIconButtonProps>(
	function GhostIconButton(
		{
			children,
			onClick,
			title,
			ariaLabel,
			padding = 'p-1',
			color,
			className = '',
			style,
			disabled = false,
			type = 'button',
			testId,
			tabIndex,
			onKeyDown,
			stopPropagation = false,
		},
		ref
	) {
		const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
			if (stopPropagation) {
				e.stopPropagation();
			}
			onClick?.(e);
		};

		return (
			<button
				ref={ref}
				type={type}
				onClick={handleClick}
				onKeyDown={onKeyDown}
				disabled={disabled}
				title={title}
				aria-label={ariaLabel}
				tabIndex={tabIndex}
				data-testid={testId}
				className={`${padding} rounded hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${className}`.trim()}
				style={{ color, ...style }}
			>
				{children}
			</button>
		);
	}
);

export default GhostIconButton;
