import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HistoryFilterToggle } from '../../../../renderer/components/History';
import type { Theme, HistoryEntryType } from '../../../../renderer/types';

// Create mock theme
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

describe('HistoryFilterToggle', () => {
	it('renders AUTO and USER filter buttons', () => {
		render(
			<HistoryFilterToggle
				activeFilters={new Set<HistoryEntryType>(['AUTO', 'USER'])}
				onToggleFilter={vi.fn()}
				theme={mockTheme}
			/>
		);
		expect(screen.getByText('AUTO')).toBeInTheDocument();
		expect(screen.getByText('USER')).toBeInTheDocument();
	});

	it('calls onToggleFilter with AUTO when AUTO button is clicked', () => {
		const onToggleFilter = vi.fn();
		render(
			<HistoryFilterToggle
				activeFilters={new Set<HistoryEntryType>(['AUTO', 'USER'])}
				onToggleFilter={onToggleFilter}
				theme={mockTheme}
			/>
		);
		fireEvent.click(screen.getByText('AUTO'));
		expect(onToggleFilter).toHaveBeenCalledWith('AUTO');
	});

	it('calls onToggleFilter with USER when USER button is clicked', () => {
		const onToggleFilter = vi.fn();
		render(
			<HistoryFilterToggle
				activeFilters={new Set<HistoryEntryType>(['AUTO', 'USER'])}
				onToggleFilter={onToggleFilter}
				theme={mockTheme}
			/>
		);
		fireEvent.click(screen.getByText('USER'));
		expect(onToggleFilter).toHaveBeenCalledWith('USER');
	});

	it('shows full opacity for active filters', () => {
		render(
			<HistoryFilterToggle
				activeFilters={new Set<HistoryEntryType>(['AUTO', 'USER'])}
				onToggleFilter={vi.fn()}
				theme={mockTheme}
			/>
		);
		const autoButton = screen.getByText('AUTO').closest('button')!;
		const userButton = screen.getByText('USER').closest('button')!;

		expect(autoButton.className).toContain('opacity-100');
		expect(userButton.className).toContain('opacity-100');
	});

	it('shows reduced opacity for inactive filters', () => {
		render(
			<HistoryFilterToggle
				activeFilters={new Set<HistoryEntryType>(['USER'])}
				onToggleFilter={vi.fn()}
				theme={mockTheme}
			/>
		);
		const autoButton = screen.getByText('AUTO').closest('button')!;
		const userButton = screen.getByText('USER').closest('button')!;

		// AUTO should be inactive (opacity-40)
		expect(autoButton.className).toContain('opacity-40');
		// USER should be active (opacity-100)
		expect(userButton.className).toContain('opacity-100');
	});

	it('styles active AUTO button with warning colors', () => {
		render(
			<HistoryFilterToggle
				activeFilters={new Set<HistoryEntryType>(['AUTO'])}
				onToggleFilter={vi.fn()}
				theme={mockTheme}
			/>
		);
		const autoButton = screen.getByText('AUTO').closest('button')!;
		expect(autoButton).toHaveStyle({ color: mockTheme.colors.warning });
	});

	it('styles active USER button with accent colors', () => {
		render(
			<HistoryFilterToggle
				activeFilters={new Set<HistoryEntryType>(['USER'])}
				onToggleFilter={vi.fn()}
				theme={mockTheme}
			/>
		);
		const userButton = screen.getByText('USER').closest('button')!;
		expect(userButton).toHaveStyle({ color: mockTheme.colors.accent });
	});

	it('styles inactive buttons with textDim color', () => {
		render(
			<HistoryFilterToggle
				activeFilters={new Set<HistoryEntryType>([])}
				onToggleFilter={vi.fn()}
				theme={mockTheme}
			/>
		);
		const autoButton = screen.getByText('AUTO').closest('button')!;
		const userButton = screen.getByText('USER').closest('button')!;

		expect(autoButton).toHaveStyle({ color: mockTheme.colors.textDim });
		expect(userButton).toHaveStyle({ color: mockTheme.colors.textDim });
	});

	it('renders both buttons even when no filters are active', () => {
		render(
			<HistoryFilterToggle
				activeFilters={new Set<HistoryEntryType>([])}
				onToggleFilter={vi.fn()}
				theme={mockTheme}
			/>
		);
		expect(screen.getByText('AUTO')).toBeInTheDocument();
		expect(screen.getByText('USER')).toBeInTheDocument();
	});
});
