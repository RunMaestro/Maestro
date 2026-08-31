import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HistoryFilterToggle } from '../../../../renderer/components/History';
import type { HistoryEntryType } from '../../../../renderer/types';
import { ALL_HISTORY_ENTRY_TYPES } from '../../../../shared/history';
import {
	RIGHT_PANEL_PILL_FONT_SIZE,
	RIGHT_PANEL_TAB_FONT_SIZE,
} from '../../../../renderer/constants/rightPanel';

import { mockTheme } from '../../../helpers/mockTheme';
// Create mock theme

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

	it('renders all three buttons even when no filters are active', () => {
		render(
			<HistoryFilterToggle
				activeFilters={new Set<HistoryEntryType>([])}
				onToggleFilter={vi.fn()}
				theme={mockTheme}
			/>
		);
		expect(screen.getByText('AUTO')).toBeInTheDocument();
		expect(screen.getByText('USER')).toBeInTheDocument();
		expect(screen.getByText('CUE')).toBeInTheDocument();
	});

	it('hides CUE button when visibleTypes excludes it', () => {
		render(
			<HistoryFilterToggle
				activeFilters={new Set<HistoryEntryType>(['AUTO', 'USER'])}
				onToggleFilter={vi.fn()}
				theme={mockTheme}
				visibleTypes={['AUTO', 'USER']}
			/>
		);
		expect(screen.getByText('AUTO')).toBeInTheDocument();
		expect(screen.getByText('USER')).toBeInTheDocument();
		expect(screen.queryByText('CUE')).not.toBeInTheDocument();
	});

	it('shows CUE button when visibleTypes includes it', () => {
		render(
			<HistoryFilterToggle
				activeFilters={new Set<HistoryEntryType>(['AUTO', 'USER', 'CUE'])}
				onToggleFilter={vi.fn()}
				theme={mockTheme}
				visibleTypes={['AUTO', 'USER', 'CUE']}
			/>
		);
		expect(screen.getByText('AUTO')).toBeInTheDocument();
		expect(screen.getByText('USER')).toBeInTheDocument();
		expect(screen.getByText('CUE')).toBeInTheDocument();
	});

	it('renders CUE filter button', () => {
		render(
			<HistoryFilterToggle
				activeFilters={new Set<HistoryEntryType>(['AUTO', 'USER', 'CUE'])}
				onToggleFilter={vi.fn()}
				theme={mockTheme}
			/>
		);
		expect(screen.getByText('CUE')).toBeInTheDocument();
	});

	it('calls onToggleFilter with CUE when CUE button is clicked', () => {
		const onToggleFilter = vi.fn();
		render(
			<HistoryFilterToggle
				activeFilters={new Set<HistoryEntryType>(['AUTO', 'USER', 'CUE'])}
				onToggleFilter={onToggleFilter}
				theme={mockTheme}
			/>
		);
		fireEvent.click(screen.getByText('CUE'));
		expect(onToggleFilter).toHaveBeenCalledWith('CUE');
	});

	it('styles active CUE button with teal colors', () => {
		render(
			<HistoryFilterToggle
				activeFilters={new Set<HistoryEntryType>(['CUE'])}
				onToggleFilter={vi.fn()}
				theme={mockTheme}
			/>
		);
		const cueButton = screen.getByText('CUE').closest('button')!;
		expect(cueButton).toHaveStyle({ color: '#06b6d4' });
	});

	it('shows CUE button as inactive when not in active filters', () => {
		render(
			<HistoryFilterToggle
				activeFilters={new Set<HistoryEntryType>(['AUTO', 'USER'])}
				onToggleFilter={vi.fn()}
				theme={mockTheme}
			/>
		);
		const cueButton = screen.getByText('CUE').closest('button')!;
		expect(cueButton.className).toContain('opacity-40');
	});

	it('renders pill icons by default', () => {
		const { container } = render(
			<HistoryFilterToggle
				activeFilters={new Set<HistoryEntryType>(['AUTO', 'USER', 'CUE', 'AGENT'])}
				onToggleFilter={vi.fn()}
				theme={mockTheme}
			/>
		);
		// One pill per entry type, each with an SVG icon when not compact.
		expect(container.querySelectorAll('button svg').length).toBe(ALL_HISTORY_ENTRY_TYPES.length);
	});

	it('renders a pill for the AGENT type', () => {
		const onToggleFilter = vi.fn();
		render(
			<HistoryFilterToggle
				activeFilters={new Set<HistoryEntryType>(['AGENT'])}
				onToggleFilter={onToggleFilter}
				theme={mockTheme}
			/>
		);
		expect(screen.getByText('AGENT')).toBeInTheDocument();
		fireEvent.click(screen.getByText('AGENT'));
		expect(onToggleFilter).toHaveBeenCalledWith('AGENT');
	});

	it('hides pill icons when compact', () => {
		const { container } = render(
			<HistoryFilterToggle
				activeFilters={new Set<HistoryEntryType>(['AUTO', 'USER', 'CUE', 'AGENT'])}
				onToggleFilter={vi.fn()}
				theme={mockTheme}
				compact
			/>
		);
		expect(container.querySelectorAll('button svg').length).toBe(0);
		// Labels still render so the controls remain usable in narrow panels.
		expect(screen.getByText('AUTO')).toBeInTheDocument();
		expect(screen.getByText('USER')).toBeInTheDocument();
		expect(screen.getByText('CUE')).toBeInTheDocument();
	});
	describe('type scale', () => {
		/**
		 * These pills sit beside the search button and the activity graph as
		 * secondary chrome. `text-xs` was tuned when the root font was always 14px
		 * monospace; the root is now the interface font size, which under the
		 * Default preset is a proportional face at 15px - bigger, and with much
		 * wider uppercase glyphs per em. Left alone they read as a headline in a
		 * row of controls.
		 */
		function pill(): HTMLElement {
			render(
				<HistoryFilterToggle
					activeFilters={new Set<HistoryEntryType>(['AUTO'])}
					onToggleFilter={vi.fn()}
					theme={mockTheme}
				/>
			);
			return screen.getByText('AUTO');
		}

		it('uses the pill size', () => {
			expect(pill().style.fontSize).toBe(RIGHT_PANEL_PILL_FONT_SIZE);
		});

		it('stays smaller than the tab heading above it', () => {
			// These are controls labelling the rows beneath them, not a heading.
			expect(parseFloat(RIGHT_PANEL_PILL_FONT_SIZE)).toBeLessThan(
				parseFloat(RIGHT_PANEL_TAB_FONT_SIZE)
			);
		});

		it('stays below the 10px entry rows it labels', () => {
			// The pills are rem-based and grow with the interface font and zoom,
			// while the History entries beneath them are pinned at an absolute
			// text-[10px]. At a 16px interface font with a 1.2 zoom the chrome was
			// rendering near 14px against 10px content.
			const rem = parseFloat(RIGHT_PANEL_PILL_FONT_SIZE);
			expect(rem).toBeLessThan(0.625); // 10px at a 16px root
		});

		it('sizes in rem, so the pills still scale with Cmd+=', () => {
			// A pixel literal would freeze them at one zoom level while everything
			// around them grew, which is the same class of bug in reverse.
			const style = pill().style;
			expect(style.fontSize).toBeTruthy();
			expect(style.fontSize.endsWith('rem')).toBe(true);
			expect(style.lineHeight.endsWith('rem')).toBe(true);
		});

		it('restates the line-height text-xs used to supply', () => {
			// Dropping the class drops its line-height too; without this the pill
			// would resize to whatever line-height it happened to inherit.
			expect(pill().style.lineHeight).toBe('1rem');
		});

		it('keeps the uppercase bold treatment', () => {
			const button = pill();
			expect(button.className).toContain('uppercase');
			expect(button.className).toContain('font-bold');
		});
	});
});
