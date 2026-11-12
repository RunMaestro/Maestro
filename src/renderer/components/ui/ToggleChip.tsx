/**
 * ToggleChip - a pill the user switches on and off by clicking it.
 *
 * The control behind a "pick any of these" row: a multiselect input, a filter
 * facet. It is the pressable counterpart to `MiniBadge` (a static state tag) and
 * to `SegmentedControl` (exactly one of several): each chip stands alone, so any
 * mix can be on.
 *
 * Selected is never colour alone. A selected chip also draws a check mark, so
 * the state survives a colour-blind palette and a theme whose accent sits close
 * to its border.
 *
 * Usage:
 * ```tsx
 * <div role="group" aria-label="Severity" className="flex flex-wrap gap-1.5">
 *   {options.map((o) => (
 *     <ToggleChip
 *       key={o.value}
 *       theme={theme}
 *       label={o.label}
 *       selected={picked.has(o.value)}
 *       onToggle={() => toggle(o.value)}
 *     />
 *   ))}
 * </div>
 * ```
 */

import { Check } from 'lucide-react';
import type { Theme } from '../../types';

export interface ToggleChipProps {
	theme: Theme;
	/** Visible text. It is also the chip's accessible name. */
	label: string;
	/** Whether the chip is on. The caller owns the state. */
	selected: boolean;
	/** Called with the NEXT state (the opposite of `selected`). */
	onToggle: (selected: boolean) => void;
	disabled?: boolean;
	/** Hover tooltip, for example a longer description of the option. */
	title?: string;
	testId?: string;
}

export function ToggleChip({
	theme,
	label,
	selected,
	onToggle,
	disabled = false,
	title,
	testId,
}: ToggleChipProps) {
	return (
		<button
			type="button"
			aria-pressed={selected}
			disabled={disabled}
			title={title}
			data-testid={testId}
			onClick={() => onToggle(!selected)}
			className={`focus-ring inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-xs whitespace-nowrap transition-colors ${
				disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
			}`}
			style={{
				borderColor: selected ? theme.colors.accent : theme.colors.border,
				backgroundColor: selected ? theme.colors.accentDim : 'transparent',
				color: selected ? theme.colors.accent : theme.colors.textDim,
			}}
		>
			{selected && <Check className="w-3 h-3" aria-hidden="true" />}
			{label}
		</button>
	);
}

export default ToggleChip;
