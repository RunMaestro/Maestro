/**
 * ThemedSelect — Themed custom dropdown replacement for native <select>.
 *
 * Renders a button that opens a positioned dropdown menu matching Maestro's
 * standard context menu aesthetic (bgSidebar, border, hover bgActivity).
 * Supports full keyboard navigation (Arrow keys, Home/End, Enter/Space, Escape).
 *
 * Pass `filterable` to add a search input at the top of the menu — useful when
 * the option list is long enough that scanning visually is painful.
 */

import { useState, useRef, useCallback, useEffect, useId, useMemo } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import type { Theme } from '../../types';
import { useClickOutside } from '../../hooks/ui';

export interface ThemedSelectOption {
	value: string;
	label: string;
}

interface ThemedSelectProps {
	value: string;
	options: ThemedSelectOption[];
	onChange: (value: string) => void;
	theme: Theme;
	style?: React.CSSProperties;
	/** Optional CSS class for the trigger button */
	className?: string;
	/** Accessible label for the trigger button */
	'aria-label'?: string;
	/** id forwarded to the trigger button (enables <label htmlFor>) */
	id?: string;
	/** When true, render a text-search filter at the top of the open menu. */
	filterable?: boolean;
	/** Placeholder for the filter input (defaults to "Filter…"). */
	filterPlaceholder?: string;
}

export function ThemedSelect({
	value,
	options,
	onChange,
	theme,
	style,
	className,
	'aria-label': ariaLabel,
	id,
	filterable = false,
	filterPlaceholder = 'Filter…',
}: ThemedSelectProps) {
	const instanceId = useId();
	const [open, setOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState(-1);
	const [query, setQuery] = useState('');
	const containerRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const [dropUp, setDropUp] = useState(false);

	const filteredOptions = useMemo(() => {
		if (!filterable || !query.trim()) return options;
		const q = query.trim().toLowerCase();
		return options.filter((o) => o.label.toLowerCase().includes(q));
	}, [filterable, query, options]);

	const closeAndRefocus = useCallback(() => {
		setOpen(false);
		setQuery('');
		triggerRef.current?.focus();
	}, []);

	useClickOutside(containerRef, closeAndRefocus, open);

	// On open: reset query, seed active index, focus the right element.
	// With a filter we focus the search input so typing narrows immediately;
	// otherwise we focus the menu so arrow keys work.
	useEffect(() => {
		if (open) {
			setQuery('');
			const idx = options.findIndex((o) => o.value === value);
			setActiveIndex(idx >= 0 ? idx : 0);
			requestAnimationFrame(() => {
				if (filterable) {
					searchRef.current?.focus({ preventScroll: true });
				} else {
					menuRef.current?.focus({ preventScroll: true });
				}
			});
		}
	}, [open, options, value, filterable]);

	// When the user types, the filtered list shrinks. Snap activeIndex to the
	// first match (or -1 if nothing matches). Gated on a non-empty query so
	// this doesn't fight the open-effect's seed-from-`value` on initial open.
	useEffect(() => {
		if (!open || !filterable) return;
		if (query.trim() === '') return;
		setActiveIndex(filteredOptions.length > 0 ? 0 : -1);
	}, [query, open, filterable, filteredOptions.length]);

	const handleOpen = useCallback(() => {
		if (!containerRef.current) {
			setOpen((v) => !v);
			return;
		}
		const rect = containerRef.current.getBoundingClientRect();
		const spaceBelow = window.innerHeight - rect.bottom;
		setDropUp(spaceBelow < 120);
		setOpen((v) => !v);
	}, []);

	const handleSelect = useCallback(
		(optValue: string) => {
			onChange(optValue);
			closeAndRefocus();
		},
		[onChange, closeAndRefocus]
	);

	const handleNavKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			const list = filteredOptions;
			switch (e.key) {
				case 'ArrowDown':
					e.preventDefault();
					if (list.length === 0) return;
					setActiveIndex((prev) => (prev < list.length - 1 ? prev + 1 : 0));
					break;
				case 'ArrowUp':
					e.preventDefault();
					if (list.length === 0) return;
					setActiveIndex((prev) => (prev > 0 ? prev - 1 : list.length - 1));
					break;
				case 'Home':
					e.preventDefault();
					if (list.length === 0) return;
					setActiveIndex(0);
					break;
				case 'End':
					e.preventDefault();
					if (list.length === 0) return;
					setActiveIndex(list.length - 1);
					break;
				case 'Enter':
					e.preventDefault();
					if (activeIndex >= 0 && activeIndex < list.length) {
						handleSelect(list[activeIndex].value);
					}
					break;
				case ' ':
					// Space submits when navigating with the menu, but inside the
					// filter input it must remain a literal space character.
					if (!filterable) {
						e.preventDefault();
						if (activeIndex >= 0 && activeIndex < list.length) {
							handleSelect(list[activeIndex].value);
						}
					}
					break;
				case 'Escape':
					closeAndRefocus();
					break;
			}
		},
		[filteredOptions, activeIndex, handleSelect, closeAndRefocus, filterable]
	);

	const selectedLabel = options.find((o) => o.value === value)?.label ?? value;

	return (
		<div ref={containerRef} style={{ position: 'relative', ...style }}>
			<button
				ref={triggerRef}
				type="button"
				id={id}
				aria-label={ariaLabel}
				aria-expanded={open}
				aria-haspopup="listbox"
				onClick={handleOpen}
				className={`focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-1${className ? ` ${className}` : ''}`}
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					width: '100%',
					backgroundColor: theme.colors.bgActivity,
					border: `1px solid ${theme.colors.border}`,
					borderRadius: 4,
					color: theme.colors.textMain,
					padding: '4px 8px',
					fontSize: 12,
					outline: 'none',
					cursor: 'pointer',
					textAlign: 'left',
					gap: 4,
				}}
			>
				<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
					{selectedLabel}
				</span>
				<ChevronDown
					size={12}
					style={{
						flexShrink: 0,
						color: theme.colors.textDim,
						transform: open ? 'rotate(180deg)' : undefined,
						transition: 'transform 0.15s',
					}}
				/>
			</button>

			{open && (
				<div
					ref={menuRef}
					role="listbox"
					tabIndex={-1}
					aria-activedescendant={activeIndex >= 0 ? `${instanceId}-opt-${activeIndex}` : undefined}
					onKeyDown={filterable ? undefined : handleNavKeyDown}
					style={{
						position: 'absolute',
						left: 0,
						right: 0,
						...(dropUp ? { bottom: '100%', marginBottom: 4 } : { top: '100%', marginTop: 4 }),
						zIndex: 10000,
						backgroundColor: theme.colors.bgSidebar,
						border: `1px solid ${theme.colors.border}`,
						borderRadius: 6,
						boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
						overflow: 'hidden',
						maxHeight: 240,
						display: 'flex',
						flexDirection: 'column',
						outline: 'none',
					}}
				>
					{filterable && (
						<div
							style={{
								display: 'flex',
								alignItems: 'center',
								gap: 6,
								padding: '6px 8px',
								borderBottom: `1px solid ${theme.colors.border}`,
								backgroundColor: theme.colors.bgSidebar,
								flexShrink: 0,
							}}
						>
							<Search size={12} style={{ color: theme.colors.textDim, flexShrink: 0 }} />
							<input
								ref={searchRef}
								type="text"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								onKeyDown={handleNavKeyDown}
								placeholder={filterPlaceholder}
								aria-label={filterPlaceholder}
								style={{
									flex: 1,
									minWidth: 0,
									backgroundColor: 'transparent',
									border: 'none',
									outline: 'none',
									color: theme.colors.textMain,
									fontSize: 12,
									padding: 0,
								}}
							/>
						</div>
					)}
					<div style={{ overflowY: 'auto', minHeight: 0 }}>
						{filteredOptions.length === 0 ? (
							<div
								style={{
									padding: '8px 10px',
									fontSize: 11,
									color: theme.colors.textDim,
									fontStyle: 'italic',
								}}
							>
								No matches
							</div>
						) : (
							filteredOptions.map((opt, i) => (
								<button
									key={opt.value}
									id={`${instanceId}-opt-${i}`}
									type="button"
									role="option"
									aria-selected={opt.value === value}
									onClick={() => handleSelect(opt.value)}
									onMouseEnter={() => setActiveIndex(i)}
									style={{
										display: 'block',
										width: '100%',
										padding: '6px 10px',
										fontSize: 12,
										color: opt.value === value ? theme.colors.textMain : theme.colors.textDim,
										fontWeight: opt.value === value ? 500 : 400,
										backgroundColor: i === activeIndex ? theme.colors.bgActivity : 'transparent',
										border: 'none',
										cursor: 'pointer',
										textAlign: 'left',
										transition: 'background-color 0.1s',
									}}
								>
									{opt.label}
								</button>
							))
						)}
					</div>
				</div>
			)}
		</div>
	);
}
