import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LookbackSelector, LOOKBACK_OPTIONS } from '../../renderer/components/History';
import type { Theme } from '../../renderer/types';

const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#ffffff',
		textDim: '#808080',
		accent: '#007acc',
		border: '#404040',
		success: '#4ec9b0',
		warning: '#dcdcaa',
		error: '#f14c4c',
		scrollbar: '#404040',
		scrollbarHover: '#808080',
	},
};

describe('LookbackSelector', () => {
	it('renders the selected lookback and calls back with the chosen option', () => {
		const onLookbackChange = vi.fn();

		render(
			<LookbackSelector lookbackHours={168} onLookbackChange={onLookbackChange} theme={mockTheme} />
		);

		const slider = screen.getByRole('slider');
		expect(slider).toHaveValue('2');
		expect(screen.getByText('1 week')).toBeInTheDocument();
		expect(slider).toHaveStyle({
			background: `linear-gradient(to right, ${mockTheme.colors.accent} 0%, ${mockTheme.colors.accent} ${(2 / (LOOKBACK_OPTIONS.length - 1)) * 100}%, ${mockTheme.colors.bgActivity} ${(2 / (LOOKBACK_OPTIONS.length - 1)) * 100}%, ${mockTheme.colors.bgActivity} 100%)`,
			opacity: '1',
		});

		fireEvent.change(slider, { target: { value: String(LOOKBACK_OPTIONS.length - 1) } });

		expect(onLookbackChange).toHaveBeenCalledWith(null);
	});

	it('falls back to the first option when the current lookback is not predefined', () => {
		render(<LookbackSelector lookbackHours={999} onLookbackChange={vi.fn()} theme={mockTheme} />);

		expect(screen.getByRole('slider')).toHaveValue('0');
		expect(screen.getByText('24 hours')).toBeInTheDocument();
	});

	it('disables the slider and dims it when disabled', () => {
		render(
			<LookbackSelector lookbackHours={24} onLookbackChange={vi.fn()} theme={mockTheme} disabled />
		);

		const slider = screen.getByRole('slider');
		expect(slider).toBeDisabled();
		expect(slider).toHaveStyle({ opacity: '0.5' });
	});

	it('ignores changes when the option lookup cannot resolve a value', () => {
		const onLookbackChange = vi.fn();
		const options = [...LOOKBACK_OPTIONS];

		try {
			render(
				<LookbackSelector
					lookbackHours={24}
					onLookbackChange={onLookbackChange}
					theme={mockTheme}
				/>
			);

			LOOKBACK_OPTIONS.splice(0, LOOKBACK_OPTIONS.length);

			fireEvent.change(screen.getByRole('slider'), { target: { value: '1' } });

			expect(onLookbackChange).not.toHaveBeenCalled();
		} finally {
			LOOKBACK_OPTIONS.splice(0, LOOKBACK_OPTIONS.length, ...options);
		}
	});
});
