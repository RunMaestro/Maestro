/**
 * HeaderActionButton - the labeled action button in a full-panel header.
 *
 * The "+ New Memory" / "+ New Session" / "Resume" class of button: an icon, a
 * short label, and an accent fill. It was hand-rolled in five files with the
 * same `px-3 py-1.5 rounded-lg text-sm font-medium` string, so they could only
 * ever drift apart.
 *
 * Sizing is deliberately one step below the header title rather than equal to
 * it. The copies used `text-sm`, which is exactly the title's size, so the
 * button read as heavy as the thing it sits next to and dominated a header it
 * is subordinate to. `text-xs` restores that hierarchy, and the icon drops to
 * match - an icon sized for the larger text looks oversized against the
 * smaller.
 *
 * Usage:
 * ```tsx
 * <HeaderActionButton theme={theme} onClick={handleCreate} icon={<Plus />}>
 *   New Memory
 * </HeaderActionButton>
 * ```
 */

import React from 'react';
import type { Theme } from '../../types';

export interface HeaderActionButtonProps {
	theme: Theme;
	onClick: () => void;
	/** Icon element. Sized by this component, so pass it without size classes. */
	icon?: React.ReactNode;
	/** Button label. */
	children: React.ReactNode;
	/**
	 * `primary` fills with the accent color (the default - these buttons are the
	 * one affirmative action in their header). `ghost` is dim text with a hover
	 * wash, for a secondary action sitting beside a primary one.
	 */
	variant?: 'primary' | 'ghost';
	title?: string;
	ariaLabel?: string;
	disabled?: boolean;
	className?: string;
	testId?: string;
}

export function HeaderActionButton({
	theme,
	onClick,
	icon,
	children,
	variant = 'primary',
	title,
	ariaLabel,
	disabled,
	className,
	testId,
}: HeaderActionButtonProps): JSX.Element {
	const isPrimary = variant === 'primary';
	return (
		<button
			onClick={onClick}
			disabled={disabled}
			title={title}
			aria-label={ariaLabel}
			data-testid={testId}
			className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed ${
				isPrimary ? 'hover:opacity-80' : 'hover:bg-white/10'
			}${className ? ` ${className}` : ''}`}
			style={
				isPrimary
					? { backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }
					: { color: theme.colors.textDim }
			}
		>
			{icon && <span className="shrink-0 [&>svg]:w-3.5 [&>svg]:h-3.5">{icon}</span>}
			{children}
		</button>
	);
}
