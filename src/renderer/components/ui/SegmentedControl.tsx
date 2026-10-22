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
 *
 * Two looks over one set of semantics, picked with `appearance`:
 *
 * - **`bar`** (the default): the joined toolbar bar above, with seam borders. A
 *   quiet control for a row that has other things in it.
 * - **`pills`**: a recessed track holding rounded pills, the active one filled
 *   with the accent. For a switch that IS the row, where which option is on is
 *   the thing the user came to read (the voice HUD's Tab / Agent / Conductor).
 *
 * `stretch` fills the row instead of hugging the labels, and an option's `icon`
 * is drawn before its label. Both work with either look. Keyboard handling, radio semantics and test ids are
 * the same in every combination, which is the reason this is one component.
 */

import { useCallback } from 'react';
import type { LucideIcon } from 'lucide-react';
import { readableTextOn } from '../../../shared/colorContrast';
import type { Theme } from '../../types';

export interface SegmentedOption<T extends string> {
	value: T;
	label: string;
	/**
	 * Abbreviated label for a cramped bar. Both forms render: the short one is
	 * `hidden` by default, and the host's container query swaps them by targeting
	 * `.segmented-label-full` / `.segmented-label-short`. The control does not
	 * decide when space is short, because only the host knows what else shares
	 * its row.
	 */
	shortLabel?: string;
	/** Tooltip text. Useful when the label is abbreviated to fit the bar. */
	title?: string;
	/** Drawn before the label. Decorative: the label stays the accessible name. */
	icon?: LucideIcon;
}

/** See the file comment. */
export type SegmentedAppearance = 'bar' | 'pills';

export interface SegmentedControlProps<T extends string> {
	value: T;
	onChange: (value: T) => void;
	options: ReadonlyArray<SegmentedOption<T>>;
	theme: Theme;
	/** Accessible label for the group. */
	ariaLabel: string;
	/** Test id for the container. Each segment gets `${testId}-${option.value}`. */
	testId?: string;
	/** `bar` (default) is the joined toolbar bar; `pills` is a track of filled pills. */
	appearance?: SegmentedAppearance;
	/**
	 * Fill the row: the segments share its width equally.
	 *
	 * Equal only while every label fits its share. A segment is never narrower
	 * than its own label, so a long one ("Conductor" beside "Tab") takes what it
	 * needs and the rest split what is left, and a row too narrow for all of
	 * them scrolls exactly as the hugging bar does. Equal shares enforced
	 * regardless would clip the longest label first, and which label that is
	 * depends on the user's font.
	 */
	stretch?: boolean;
}

export function SegmentedControl<T extends string>({
	value,
	onChange,
	options,
	theme,
	ariaLabel,
	testId,
	appearance = 'bar',
	stretch = false,
}: SegmentedControlProps<T>) {
	const pills = appearance === 'pills';
	// The active pill is a solid accent fill, so its text is checked against the
	// accent rather than assumed readable on it.
	const onAccent = readableTextOn(theme.colors.accentForeground, [theme.colors.accent]);
	// A value that names none of the options is legal: a state the bar can show
	// but not select (the Delegation Graph's `manual` layout). The first segment
	// then takes the tab stop, so the bar stays reachable from the keyboard.
	const noneActive = !options.some((o) => o.value === value);

	// Arrow keys move between segments, matching how a native radio group
	// behaves - the bar is one tab stop, not one per option.
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>) => {
			if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
			if (options.length === 0) return;
			const index = options.findIndex((o) => o.value === value);
			e.preventDefault();
			// No segment is on: Right enters at the first one and Left at the last.
			const delta = e.key === 'ArrowRight' ? 1 : index === -1 ? 0 : -1;
			const next = options[(index + delta + options.length) % options.length];
			onChange(next.value);
		},
		[options, value, onChange]
	);

	return (
		<div
			// Scrolls sideways when the row cannot hold every segment, rather
			// than clipping. `overflow-hidden` is what rounds the corners, and it
			// used to mean a bar wider than its row simply lost its last options:
			// invisible AND unclickable, with no scrollbar to hint they were
			// there. On a phone the five-way sort bar lost two of them.
			// `overflow-y-hidden` is required beside it - `overflow-x: auto`
			// alone computes `overflow-y` to `auto` and adds a vertical bar.
			className={`min-w-0 max-w-full border overflow-x-auto overflow-y-hidden no-scrollbar ${
				// A grid when stretched: `minmax(max-content, 1fr)` is "an equal share,
				// but never less than the label", which flexbox cannot say.
				stretch ? 'grid grid-flow-col auto-cols-[minmax(max-content,1fr)]' : 'flex'
			} ${pills ? 'rounded-full p-0.5 gap-0.5' : 'rounded'}`}
			style={{
				borderColor: theme.colors.border,
				// The track sits a step below the surface it is on, so the filled pill
				// reads as raised out of it.
				backgroundColor: pills ? theme.colors.bgMain : undefined,
			}}
			role="radiogroup"
			aria-label={ariaLabel}
			data-testid={testId}
			data-appearance={appearance}
			onKeyDown={handleKeyDown}
		>
			{options.map((opt, i) => {
				const isActive = value === opt.value;
				const Icon = opt.icon;
				return (
					<button
						key={opt.value}
						type="button"
						onClick={() => onChange(opt.value)}
						className={`shrink-0 flex items-center justify-center gap-1.5 text-xs transition-colors whitespace-nowrap ${
							pills
								? `px-2.5 py-1 rounded-full font-medium focus:outline-none focus-visible:ring-2${
										isActive ? ' shadow-sm' : ' hover:bg-white/10'
									}`
								: 'px-2 py-1'
						}`}
						style={
							pills
								? {
										backgroundColor: isActive ? theme.colors.accent : 'transparent',
										color: isActive ? onAccent : theme.colors.textDim,
									}
								: {
										backgroundColor: isActive ? `${theme.colors.accent}20` : 'transparent',
										color: isActive ? theme.colors.accent : theme.colors.textDim,
										borderLeft: i === 0 ? undefined : `1px solid ${theme.colors.border}`,
									}
						}
						role="radio"
						aria-checked={isActive}
						aria-pressed={isActive}
						title={opt.title}
						tabIndex={isActive || (noneActive && i === 0) ? 0 : -1}
						data-testid={testId ? `${testId}-${opt.value}` : undefined}
					>
						{Icon && <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
						{opt.shortLabel ? (
							<>
								<span className="segmented-label-full">{opt.label}</span>
								<span className="segmented-label-short hidden">{opt.shortLabel}</span>
							</>
						) : (
							opt.label
						)}
					</button>
				);
			})}
		</div>
	);
}

export default SegmentedControl;
