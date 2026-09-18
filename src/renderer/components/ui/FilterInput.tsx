/**
 * FilterInput - the "narrow this list" text box.
 *
 * A search icon, a borderless input, an optional result count, and a clear
 * button that only exists once there is something to clear. Escape clears the
 * query when there is one, so the key does not close the surrounding surface
 * out from under a user who was only trying to reset the filter.
 *
 * That local Escape only reaches an UNLAYERED surface. Inside a modal or an
 * overlay registered with the layer stack, the stack handles Escape at capture
 * on `window` and the input never sees the key - so the host's own `onEscape`
 * has to clear the filter first (see `MemoryViewer`). The clear button is the
 * always-available path either way.
 *
 * Reach for it whenever a pane filters a list it already holds. It is NOT a
 * find bar: a find bar walks matches inside one document and owns next/prev
 * plus a match index (see `AutoRunSearchBar`, `TerminalSearchBar`). This one
 * has no cursor into the results, it just narrows them.
 *
 * Usage:
 * ```tsx
 * <FilterInput
 *   theme={theme}
 *   value={filter}
 *   onChange={setFilter}
 *   placeholder="Filter memories..."
 *   resultLabel={`${shown} of ${total}`}
 * />
 * ```
 */

import React, { forwardRef, useCallback } from 'react';
import { Search, X } from 'lucide-react';
import type { Theme } from '../../types';
import { GhostIconButton } from './GhostIconButton';

export interface FilterInputProps {
	theme: Theme;
	/** Current query text (controlled). */
	value: string;
	/** Fired on every keystroke and when the clear button empties the box. */
	onChange: (value: string) => void;
	placeholder?: string;
	/** Short count shown to the right of the input, e.g. "12 of 77". */
	resultLabel?: string;
	/** Native tooltip / accessible label for the input. */
	title?: string;
	ariaLabel?: string;
	/** Width of the whole control in px. Defaults to 200. */
	width?: number;
	/** Focus the input on mount. */
	autoFocus?: boolean;
	className?: string;
	/** Extra key handling (e.g. ArrowDown to move into the list). */
	onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

export const FilterInput = forwardRef<HTMLInputElement, FilterInputProps>(function FilterInput(
	{
		theme,
		value,
		onChange,
		placeholder = 'Filter...',
		resultLabel,
		title,
		ariaLabel,
		width = 200,
		autoFocus,
		className,
		onKeyDown,
	},
	ref
) {
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			// Escape clears the filter first; only an already-empty box lets the
			// key through to whatever layer owns the surface.
			if (e.key === 'Escape' && value) {
				e.preventDefault();
				e.stopPropagation();
				onChange('');
				return;
			}
			onKeyDown?.(e);
		},
		[value, onChange, onKeyDown]
	);

	return (
		<div
			className={`flex items-center gap-1.5 px-2 py-1 rounded${className ? ` ${className}` : ''}`}
			style={{
				backgroundColor: theme.colors.bgActivity,
				border: `1px solid ${theme.colors.border}`,
				width,
			}}
		>
			<Search className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
			<input
				ref={ref}
				type="text"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onKeyDown={handleKeyDown}
				placeholder={placeholder}
				title={title}
				aria-label={ariaLabel ?? placeholder}
				className="flex-1 min-w-0 bg-transparent outline-none text-xs"
				style={{ color: theme.colors.textMain }}
				autoFocus={autoFocus}
				spellCheck={false}
			/>
			{resultLabel && (
				<span
					className="text-xs whitespace-nowrap shrink-0"
					style={{ color: theme.colors.textDim }}
				>
					{resultLabel}
				</span>
			)}
			{value && (
				<GhostIconButton
					onClick={() => onChange('')}
					title="Clear filter (Esc)"
					ariaLabel="Clear filter"
					padding="p-0.5"
					color={theme.colors.textDim}
				>
					<X className="w-3 h-3" />
				</GhostIconButton>
			)}
		</div>
	);
});
