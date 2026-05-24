import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FontConfigurationPanel } from '../../../renderer/components/FontConfigurationPanel';
import type { Theme } from '../../../renderer/types';

const theme: Theme = {
	id: 'test',
	name: 'Test',
	mode: 'dark',
	colors: {
		bgMain: '#000000',
		bgSidebar: '#111111',
		bgActivity: '#222222',
		border: '#333333',
		textMain: '#ffffff',
		textDim: '#cccccc',
		textFaint: '#999999',
		accent: '#4f46e5',
		accentForeground: '#ffffff',
		buttonBg: '#222222',
		buttonHover: '#333333',
		headerBg: '#111111',
		scrollbarTrack: '#111111',
		scrollbarThumb: '#444444',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

function renderPanel(overrides = {}) {
	const props = {
		fontFamily: 'Monaco',
		setFontFamily: vi.fn(),
		systemFonts: [],
		fontsLoaded: true,
		fontLoading: false,
		customFonts: [],
		onAddCustomFont: vi.fn(),
		onRemoveCustomFont: vi.fn(),
		onFontInteraction: vi.fn(),
		theme,
		...overrides,
	};

	render(<FontConfigurationPanel {...props} />);
	return props;
}

describe('FontConfigurationPanel', () => {
	it('marks exact system-font matches as available and reports selection changes', () => {
		const setFontFamily = vi.fn();
		renderPanel({ setFontFamily, systemFonts: ['Monaco'] });

		expect(screen.getByRole('option', { name: /^Monaco$/ })).not.toHaveTextContent('(Not Found)');

		fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Menlo' } });

		expect(setFontFamily).toHaveBeenCalledWith('Menlo');
	});

	it('treats substring system-font matches as available', () => {
		renderPanel({ systemFonts: ['Monaco Nerd Font'] });

		expect(screen.getByRole('option', { name: /^Monaco$/ })).not.toHaveTextContent('(Not Found)');
		expect(screen.getByRole('option', { name: /Menlo \(Not Found\)/ })).toBeInTheDocument();
	});

	it('ignores non-Enter keys while preserving the custom font input', () => {
		const onAddCustomFont = vi.fn();
		renderPanel({ onAddCustomFont });

		const input = screen.getByPlaceholderText('Add custom font name...');
		fireEvent.change(input, { target: { value: '  Display Mono  ' } });
		fireEvent.keyDown(input, { key: 'Escape' });

		expect(onAddCustomFont).not.toHaveBeenCalled();
		expect(input).toHaveValue('  Display Mono  ');

		fireEvent.keyDown(input, { key: 'Enter' });

		expect(onAddCustomFont).toHaveBeenCalledWith('Display Mono');
		expect(input).toHaveValue('');
	});

	it('renders custom fonts and removes them through the chip action', () => {
		const onRemoveCustomFont = vi.fn();
		renderPanel({ customFonts: ['Display Mono'], onRemoveCustomFont });

		expect(screen.getByRole('option', { name: 'Display Mono' })).toBeInTheDocument();
		expect(screen.getAllByText('Display Mono')).not.toHaveLength(0);

		fireEvent.click(screen.getByRole('button', { name: '×' }));

		expect(onRemoveCustomFont).toHaveBeenCalledWith('Display Mono');
	});

	it('does not add duplicate custom fonts', () => {
		const onAddCustomFont = vi.fn();
		renderPanel({ customFonts: ['Display Mono'], onAddCustomFont });

		const input = screen.getByPlaceholderText('Add custom font name...');
		fireEvent.change(input, { target: { value: 'Display Mono' } });
		fireEvent.click(screen.getByRole('button', { name: 'Add' }));

		expect(onAddCustomFont).not.toHaveBeenCalled();
		expect(input).toHaveValue('Display Mono');
	});
});
