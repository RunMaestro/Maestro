/**
 * SegmentedControl - a horizontal row of mutually exclusive options rendered as
 * one joined pill bar (the "Sort by: [Name][Created][Queries]" control).
 *
 * Distinct from `RadioGroup`, which renders the same semantics as stacked list
 * rows for settings panes. This is the compact toolbar form: it belongs above a
 * grid or chart where the options are short words and vertical space is scarce.
 *
 * Usage:
 * ```tsx
 * <SegmentedControl
 *   value={sortMode}
 *   onChange={setSortMode}
 *   options={[{ value: 'name', label: 'Name' }, { value: 'queries', label: 'Queries' }]}
 *   theme={theme}
 *   ariaLabel="Sort agents"
 *   testId="agent-overview-sort"
 * />
 * ```
 */

import { useCallback } from 'react';
import type { Theme } from '../../types';

export interface SegmentedOption<T extends string> {
	value: T;
	label: string;
	/** Tooltip text. Useful when the label is abbreviated to fit the bar. */
	title?: string;
}

export interface SegmentedControlProps<T extends string> {
	value: T;
	onChange: (value: T) => void;
	options: ReadonlyArray<SegmentedOption<T>>;
	theme: Theme;
	/** Accessible label for the group. */
	ariaLabel: string;
	/** Test id for the container. Each segment gets `${testId}-${option.value}`. */
	testId?: string;
}

export function SegmentedControl<T extends string>({
	value,
	onChange,
	options,
	theme,
	ariaLabel,
	testId,
}: SegmentedControlProps<T>) {
	// Arrow keys move between segments, matching how a native radio group
	// behaves - the bar is one tab stop, not one per option.
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>) => {
			if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
			const index = options.findIndex((o) => o.value === value);
			if (index === -1) return;
			e.preventDefault();
			const delta = e.key === 'ArrowRight' ? 1 : -1;
			const next = options[(index + delta + options.length) % options.length];
			onChange(next.value);
		},
		[options, value, onChange]
	);

	return (
		<div
			className="flex rounded overflow-hidden border"
			style={{ borderColor: theme.colors.border }}
			role="radiogroup"
			aria-label={ariaLabel}
			data-testid={testId}
			onKeyDown={handleKeyDown}
		>
			{options.map((opt, i) => {
				const isActive = value === opt.value;
				return (
					<button
						key={opt.value}
						type="button"
						onClick={() => onChange(opt.value)}
						className="px-2 py-1 text-xs transition-colors whitespace-nowrap"
						style={{
							backgroundColor: isActive ? `${theme.colors.accent}20` : 'transparent',
							color: isActive ? theme.colors.accent : theme.colors.textDim,
							borderLeft: i === 0 ? undefined : `1px solid ${theme.colors.border}`,
						}}
						role="radio"
						aria-checked={isActive}
						aria-pressed={isActive}
						title={opt.title}
						tabIndex={isActive ? 0 : -1}
						data-testid={testId ? `${testId}-${opt.value}` : undefined}
					>
						{opt.label}
					</button>
				);
			})}
		</div>
	);
}

export default SegmentedControl;
