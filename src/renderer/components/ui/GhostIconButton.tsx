/**
 * GhostIconButton - Icon-only button with hover background
 *
 * Encapsulates the common "p-X rounded hover:bg-white/10 transition-colors" pattern
 * used throughout the app for toolbar-style icon buttons.
 *
 * The button is a centering flex container, and must stay one. Without it the
 * icon is inline content sitting on the line box's BASELINE, so the button's
 * height comes from the inherited line-height rather than the icon: a 16px icon
 * with `p-1` produced a 27.5px-tall button with the icon riding 1.75px above its
 * own center, which is where the hover pill and the focus ring are drawn. It
 * also made the row fragile - anything that changed a button's inherited
 * font-size moved that icon relative to its neighbours, since baseline position
 * depends on font metrics but icon size does not.
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
	/**
	 * Mark the button as a two-state toggle and say which state it is in.
	 * Renders `aria-pressed`, so a screen reader announces "pressed"/"not
	 * pressed" instead of a plain button whose effect is invisible. Leave it
	 * undefined for an ordinary action button - `aria-pressed="false"` on a
	 * button that does not toggle is a lie about what it does.
	 */
	pressed?: boolean;
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
	/**
	 * Mousedown handler. Needed when the button sits inside a drag handle: the
	 * parent starts a drag on mousedown, so the button must stop propagation
	 * there (stopping it on click is too late to prevent the drag).
	 */
	onMouseDown?: (e: MouseEvent<HTMLButtonElement>) => void;
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
			pressed,
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
			onMouseDown,
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
				onMouseDown={onMouseDown}
				onKeyDown={onKeyDown}
				disabled={disabled}
				title={title}
				aria-label={ariaLabel}
				aria-pressed={pressed}
				tabIndex={tabIndex}
				data-testid={testId}
				className={`inline-flex items-center justify-center ${padding} rounded hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${className}`.trim()}
				style={{ color, ...style }}
			>
				{children}
			</button>
		);
	}
);

export default GhostIconButton;
