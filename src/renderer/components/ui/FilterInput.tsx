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
 * `collapsible` shrinks the control to its magnifier until it is focused or
 * holds a query, for a toolbar row that has to stay on one line. The input is
 * squeezed rather than unmounted, so a host hotkey that focuses it by ref keeps
 * working while the box is closed.
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

import React, {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from 'react';
import { Search, X } from 'lucide-react';
import type { Theme } from '../../types';
import { GhostIconButton } from './GhostIconButton';

/** Width of the collapsed control: the magnifier and its padding, nothing else. */
const COLLAPSED_WIDTH = 30;

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
	/**
	 * Shrink to just the magnifier until the box is focused or holds a query.
	 *
	 * For a control sharing a single non-wrapping row with other content (a
	 * stats bar, a toolbar), where a permanently-open 280px box is what forces
	 * everything beside it to wrap. Pair it with `onExpandedChange` so the host
	 * can yield the space it needs.
	 */
	collapsible?: boolean;
	/**
	 * Fired when the collapsed control opens or closes, so the host can hide a
	 * neighbouring control while the box is wide. Only meaningful with
	 * `collapsible`.
	 */
	onExpandedChange?: (expanded: boolean) => void;
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
		collapsible = false,
		onExpandedChange,
	},
	ref
) {
	// The input stays MOUNTED when collapsed, only squeezed to zero width. A
	// host that focuses this control by hotkey holds a ref to the element, and
	// unmounting it would make that ref null - the key would silently do
	// nothing, which reads as the shortcut being broken rather than the box
	// being closed.
	const inputRef = useRef<HTMLInputElement>(null);
	useImperativeHandle(ref, () => inputRef.current as HTMLInputElement, []);

	const [focused, setFocused] = useState(false);
	// A live query keeps the box open even unfocused: collapsing it would hide
	// the reason the list is short.
	const expanded = !collapsible || focused || value.length > 0;

	useEffect(() => {
		if (collapsible) onExpandedChange?.(expanded);
	}, [collapsible, expanded, onExpandedChange]);

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
			className={`flex items-center px-2 py-1 rounded shrink-0 transition-[width] duration-150${
				expanded ? ' gap-1.5' : ''
			}${className ? ` ${className}` : ''}`}
			style={{
				backgroundColor: theme.colors.bgActivity,
				border: `1px solid ${theme.colors.border}`,
				width: expanded ? width : COLLAPSED_WIDTH,
				cursor: expanded ? undefined : 'text',
			}}
			// Clicking the collapsed magnifier opens the box. This is a click on
			// the WRAPPER rather than a button around the icon on purpose: a second
			// focusable element would carry the same accessible name as the input
			// it fronts, so "the filter box" would match two nodes.
			onClick={collapsible ? () => inputRef.current?.focus() : undefined}
			title={collapsible && !expanded ? (title ?? ariaLabel ?? placeholder) : undefined}
		>
			<Search className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
			<input
				ref={inputRef}
				type="text"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onKeyDown={handleKeyDown}
				onFocus={() => setFocused(true)}
				onBlur={() => setFocused(false)}
				placeholder={expanded ? placeholder : ''}
				title={title}
				aria-label={ariaLabel ?? placeholder}
				className={`min-w-0 bg-transparent outline-none text-xs${
					expanded ? ' flex-1' : ' w-0 p-0'
				}`}
				style={{ color: theme.colors.textMain }}
				autoFocus={autoFocus}
				spellCheck={false}
			/>
			{expanded && resultLabel && (
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
