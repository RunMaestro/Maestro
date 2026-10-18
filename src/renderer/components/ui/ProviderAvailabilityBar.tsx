import type { Theme } from '../../types';
import { ToggleSwitch } from './ToggleSwitch';

/**
 * Marks a subtree whose own keyboard handling wins over its container's.
 *
 * The wizard runs one keydown handler across its whole screen to drive the
 * provider strip, so without this the toggle would lose its own Tab and arrow
 * keys to tile navigation the moment it took focus.
 */
export const PROVIDER_BAR_NAV_EXEMPT_ATTR = 'data-provider-bar-nav-exempt';

export interface ProviderAvailabilityBarProps {
	theme: Theme;
	/** Providers detected on the target machine. */
	availableCount: number;
	/** Providers Maestro supports at all. */
	totalCount: number;
	/** Follows "available" - see `providerLocationLabel`. */
	locationLabel: string;
	showAll: boolean;
	onShowAllChange: (showAll: boolean) => void;
	/**
	 * `full` for a picker with a row to itself, `compact` to sit on a section
	 * heading beside a label. Compact drops to the counts alone: the same sentence
	 * would wrap the heading onto two lines in the New Agent modal.
	 */
	variant?: 'full' | 'compact';
}

/**
 * "4 providers available locally of 11 supported" plus the toggle that brings
 * the other 7 back.
 *
 * Both provider pickers show this, so the count and the toggle cannot disagree
 * about what is being filtered. The count always describes ALL supported
 * providers, never the filtered list - a count that shrank along with the rows
 * would report "4 of 4" and answer nothing.
 */
export function ProviderAvailabilityBar({
	theme,
	availableCount,
	totalCount,
	locationLabel,
	showAll,
	onShowAllChange,
	variant = 'full',
}: ProviderAvailabilityBarProps): JSX.Element {
	const isCompact = variant === 'compact';
	// Nothing detected: `filterToAvailableProviders` already shows every row, so a
	// toggle drawn OFF beside a full list reads as a filter that does not work.
	// Draw it on and locked, and say why the list is full.
	const isFallback = availableCount === 0;
	const fallbackHint = `No providers detected ${locationLabel}. Showing all ${totalCount} so you can set a custom path.`;
	const summary = isCompact
		? `${availableCount} of ${totalCount} ${locationLabel}`
		: isFallback
			? `No providers detected ${locationLabel}, showing all ${totalCount} supported`
			: `${availableCount} providers available ${locationLabel} of ${totalCount} supported`;

	return (
		<div
			className={`flex items-center text-xs ${isCompact ? 'gap-2' : 'justify-center gap-3'}`}
			style={{ color: theme.colors.textDim }}
		>
			<span title={isFallback ? fallbackHint : undefined}>{summary}</span>

			<label
				{...{ [PROVIDER_BAR_NAV_EXEMPT_ATTR]: true }}
				className={`flex items-center gap-2 select-none ${isFallback ? 'cursor-not-allowed' : 'cursor-pointer'}`}
				title={isFallback ? fallbackHint : undefined}
			>
				<ToggleSwitch
					theme={theme}
					checked={showAll || isFallback}
					onChange={onShowAllChange}
					disabled={isFallback}
					ariaLabel="Show all supported providers"
				/>
				{isCompact ? 'Show All' : 'Show All Supported'}
			</label>
		</div>
	);
}
