/**
 * Tests for ProviderAvailabilityBar - the shared count + "Show All" toggle that
 * sits above both provider pickers.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProviderAvailabilityBar } from '../../../../renderer/components/ui/ProviderAvailabilityBar';
import { mockTheme } from '../../../helpers/mockTheme';

function renderBar(props: Partial<React.ComponentProps<typeof ProviderAvailabilityBar>> = {}): {
	onShowAllChange: ReturnType<typeof vi.fn>;
} {
	const onShowAllChange = vi.fn();
	render(
		<ProviderAvailabilityBar
			theme={mockTheme}
			availableCount={4}
			totalCount={11}
			locationLabel="locally"
			showAll={false}
			onShowAllChange={onShowAllChange}
			{...props}
		/>
	);
	return { onShowAllChange };
}

describe('ProviderAvailabilityBar', () => {
	it('reads as a sentence in the full variant', () => {
		renderBar();
		expect(screen.getByText('4 providers available locally of 11 supported')).toBeInTheDocument();
		expect(screen.getByText('Show All Supported')).toBeInTheDocument();
	});

	it('drops to bare counts in the compact variant', () => {
		// The full sentence wraps the New Agent modal's section heading onto a
		// second line, which costs a row in a modal that already scrolls.
		renderBar({ variant: 'compact' });
		expect(screen.getByText('4 of 11 locally')).toBeInTheDocument();
		expect(screen.getByText('Show All')).toBeInTheDocument();
	});

	it('names the remote host instead of claiming "locally"', () => {
		// The counts describe whichever machine detection probed.
		renderBar({ locationLabel: 'on build-box' });
		expect(
			screen.getByText('4 providers available on build-box of 11 supported')
		).toBeInTheDocument();
	});

	it('reports the total, not the filtered row count', () => {
		// A count that shrank with the list would read "4 of 4" and answer nothing.
		renderBar({ availableCount: 4, totalCount: 11 });
		expect(screen.queryByText('4 providers available locally of 4 supported')).toBeNull();
	});

	it('toggles and reflects its state', () => {
		const { onShowAllChange } = renderBar();
		const toggle = screen.getByRole('switch', { name: 'Show all supported providers' });

		expect(toggle).toHaveAttribute('aria-checked', 'false');
		fireEvent.click(toggle);
		expect(onShowAllChange).toHaveBeenCalledWith(true);
	});

	it('marks itself exempt so a container keyboard handler leaves its keys alone', () => {
		renderBar();
		const toggle = screen.getByRole('switch', { name: 'Show all supported providers' });
		expect(toggle.closest('[data-provider-bar-nav-exempt]')).not.toBeNull();
	});
});
