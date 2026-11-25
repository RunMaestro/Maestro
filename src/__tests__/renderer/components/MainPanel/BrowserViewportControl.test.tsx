/**
 * The browser toolbar's viewport picker: one icon per preset, in the order the
 * palette lists them, with the width in the tooltip.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BrowserViewportControl } from '../../../../renderer/components/MainPanel/BrowserViewportControl';
import { BROWSER_VIEWPORT_PRESETS } from '../../../../shared/browserViewport';
import { mockTheme } from '../../../helpers/mockTheme';

function renderControl(value: (typeof BROWSER_VIEWPORT_PRESETS)[number], onChange = vi.fn()) {
	render(<BrowserViewportControl theme={mockTheme} value={value} onChange={onChange} />);
	return onChange;
}

describe('BrowserViewportControl', () => {
	it('offers every preset as an icon, in order, named for assistive tech', () => {
		renderControl('fit');

		expect(screen.getByRole('radiogroup', { name: 'Viewport width' })).toBeInTheDocument();
		expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('aria-label'))).toEqual([
			'Fit',
			'Desktop',
			'Laptop',
			'Tablet',
			'Phone',
		]);
		for (const radio of screen.getAllByRole('radio')) {
			// An icon and no words: the bar shares a row with the address field.
			expect(radio.querySelector('svg')).not.toBeNull();
			expect(radio).toHaveTextContent('');
		}
	});

	it('says how wide each preset is in its tooltip', () => {
		renderControl('fit');

		expect(screen.getByTestId('browser-tab-viewport-fit')).toHaveAttribute(
			'title',
			"Viewport: Fit (the tab's width)"
		);
		expect(screen.getByTestId('browser-tab-viewport-desktop')).toHaveAttribute(
			'title',
			'Viewport: Desktop (1440 px wide)'
		);
		expect(screen.getByTestId('browser-tab-viewport-phone')).toHaveAttribute(
			'title',
			'Viewport: Phone (390 px wide)'
		);
	});

	it('marks the tab’s own preset as the chosen one', () => {
		renderControl('tablet');

		for (const preset of BROWSER_VIEWPORT_PRESETS) {
			expect(screen.getByTestId(`browser-tab-viewport-${preset}`)).toHaveAttribute(
				'aria-checked',
				String(preset === 'tablet')
			);
		}
	});

	it('reports the preset that was clicked', () => {
		const onChange = renderControl('fit');

		fireEvent.click(screen.getByTestId('browser-tab-viewport-phone'));

		expect(onChange).toHaveBeenCalledWith('phone');
	});

	it('steps through the presets with the arrow keys', () => {
		const onChange = renderControl('laptop');
		const group = screen.getByRole('radiogroup', { name: 'Viewport width' });

		fireEvent.keyDown(group, { key: 'ArrowRight' });
		expect(onChange).toHaveBeenLastCalledWith('tablet');

		fireEvent.keyDown(group, { key: 'ArrowLeft' });
		expect(onChange).toHaveBeenLastCalledWith('desktop');
	});
});
