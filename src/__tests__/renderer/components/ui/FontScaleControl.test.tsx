/**
 * Tests for FontScaleControl - the shared decrease / reset / increase cluster
 * used by the Director's Notes stats bar and the file preview's floating pill.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FontScaleControl } from '../../../../renderer/components/ui/FontScaleControl';
import type { UseFontScaleReturn } from '../../../../renderer/hooks/ui/useFontScale';
import { mockTheme } from '../../../helpers/mockTheme';

function makeControl(overrides: Partial<UseFontScaleReturn> = {}): UseFontScaleReturn {
	return {
		fontScale: 1,
		adjustFontScale: vi.fn(),
		resetFontScale: vi.fn(),
		canDecrease: true,
		canIncrease: true,
		...overrides,
	};
}

describe('FontScaleControl', () => {
	it('steps the scale in both directions', () => {
		const control = makeControl();
		render(<FontScaleControl theme={mockTheme} control={control} />);

		fireEvent.click(screen.getByLabelText('Increase font size'));
		expect(control.adjustFontScale).toHaveBeenCalledWith(1);

		fireEvent.click(screen.getByLabelText('Decrease font size'));
		expect(control.adjustFontScale).toHaveBeenCalledWith(-1);
	});

	it('disables the button that would leave the supported range', () => {
		const { rerender } = render(
			<FontScaleControl theme={mockTheme} control={makeControl({ canIncrease: false })} />
		);
		expect(screen.getByLabelText('Increase font size')).toBeDisabled();
		expect(screen.getByLabelText('Decrease font size')).not.toBeDisabled();

		rerender(<FontScaleControl theme={mockTheme} control={makeControl({ canDecrease: false })} />);
		expect(screen.getByLabelText('Decrease font size')).toBeDisabled();
		expect(screen.getByLabelText('Increase font size')).not.toBeDisabled();
	});

	// The percentage doubles as the reset affordance, so it only earns its space
	// once the user has actually zoomed.
	it('hides the percentage at 100% and shows it once zoomed', () => {
		const { rerender } = render(<FontScaleControl theme={mockTheme} control={makeControl()} />);
		expect(screen.queryByText('100%')).toBeNull();

		const zoomed = makeControl({ fontScale: 1.3 });
		rerender(<FontScaleControl theme={mockTheme} control={zoomed} />);

		fireEvent.click(screen.getByText('130%'));
		expect(zoomed.resetFontScale).toHaveBeenCalledTimes(1);
	});

	// Collapsed, the pill rests as a circle. The buttons must stay MOUNTED (they
	// are only clipped by CSS) so a Tab into them expands it - unmounting them
	// would make the control unreachable from the keyboard.
	it('keeps the buttons mounted behind the collapsed circle', () => {
		render(
			<FontScaleControl
				theme={mockTheme}
				control={makeControl()}
				variant="floating"
				collapsible
				testId="font-scale"
			/>
		);

		expect(screen.getByTestId('font-scale-handle')).toBeInTheDocument();
		expect(screen.getByLabelText('Increase font size')).toBeInTheDocument();
		expect(screen.getByLabelText('Decrease font size')).toBeInTheDocument();
	});

	it('draws no collapsed circle for the inline variant', () => {
		render(<FontScaleControl theme={mockTheme} control={makeControl()} testId="font-scale" />);

		expect(screen.queryByTestId('font-scale-handle')).toBeNull();
	});

	it('names the pane it zooms in its labels', () => {
		render(<FontScaleControl theme={mockTheme} control={makeControl()} target="preview" />);

		expect(screen.getByLabelText('Increase preview font size')).toBeInTheDocument();
		expect(screen.getByLabelText('Decrease preview font size')).toBeInTheDocument();
	});
});
