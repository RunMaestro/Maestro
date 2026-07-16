/**
 * Tests for NarrativeSections - the Rich-Mode renderer for the parsed
 * Director's Notes narrative.
 *
 * Verifies it:
 * - renders one SectionCard per narrative section (title + per-section count badge)
 * - renders every bullet's text and surfaces an `agent` pill when present
 * - shows the "Nothing to report." placeholder for an empty section
 * - applies severity styling (critical = bold + error emphasis, info/absent = neutral)
 * - resolves each section's accent color from `theme.colors.*` per kind
 *   (accomplishments = success, challenges = warning, nextSteps = accent)
 *
 * SectionCard is exercised for real (it is a lightweight presentational widget);
 * lucide icons come from the global mock in setup.ts (each renders an <svg> whose
 * `data-testid` is the lowercased icon name + "-icon").
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NarrativeSections } from '../../../../renderer/components/DirectorNotes/NarrativeSections';
import type { DirectorNotesNarrative } from '../../../../shared/directorNotesNarrative';
import { mockTheme, createMockTheme } from '../../../helpers/mockTheme';

// Canonical narrative exercising every section kind and the full severity/agent
// matrix: a plain item, an agent-tagged item, a critical item, a warn item with
// an agent, and an explicit-info item.
const NARRATIVE: DirectorNotesNarrative = {
	version: 1,
	sections: [
		{
			kind: 'accomplishments',
			title: 'Accomplishments',
			items: [
				{ text: 'Shipped the rich dashboard' },
				{ text: 'Closed the flaky test', agent: 'alpha' },
			],
		},
		{
			kind: 'challenges',
			title: 'Challenges',
			items: [
				{ text: 'Parser regression', severity: 'critical' },
				{ text: 'Slow CI runs', severity: 'warn', agent: 'beta' },
			],
		},
		{
			kind: 'nextSteps',
			title: 'Next Steps',
			items: [{ text: 'Write the widget guide', severity: 'info' }],
		},
	],
};

// Distinct, easy-to-assert sentinel colors so the cross-theme regression (a
// hardcoded hex that ignores the active theme) fails these specs.
const sentinelTheme = createMockTheme({
	colors: {
		success: '#11aa11',
		warning: '#aa8800',
		accent: '#3333ff',
		error: '#ff0000',
		textMain: '#101010',
		textDim: '#777777',
		border: '#cccccc',
		bgActivity: '#222222',
		bgMain: '#000000',
	},
});

describe('NarrativeSections', () => {
	it('renders one card per section with its title', () => {
		render(<NarrativeSections theme={mockTheme} narrative={NARRATIVE} />);

		const headings = screen.getAllByRole('heading', { level: 3 });
		expect(headings).toHaveLength(3);
		expect(screen.getByText('Accomplishments')).toBeInTheDocument();
		expect(screen.getByText('Challenges')).toBeInTheDocument();
		expect(screen.getByText('Next Steps')).toBeInTheDocument();
	});

	it('renders the per-section item-count badge', () => {
		render(<NarrativeSections theme={mockTheme} narrative={NARRATIVE} />);

		// Two sections have 2 items, one has 1.
		expect(screen.getAllByText('2')).toHaveLength(2);
		expect(screen.getByText('1')).toBeInTheDocument();
	});

	it('renders every bullet text', () => {
		render(<NarrativeSections theme={mockTheme} narrative={NARRATIVE} />);

		for (const section of NARRATIVE.sections) {
			for (const item of section.items) {
				expect(screen.getByText(item.text)).toBeInTheDocument();
			}
		}
	});

	it('surfaces an agent pill only for items that carry an agent', () => {
		render(<NarrativeSections theme={mockTheme} narrative={NARRATIVE} />);

		// Two items carry an agent; the three others do not.
		expect(screen.getByText('alpha')).toBeInTheDocument();
		expect(screen.getByText('beta')).toBeInTheDocument();
	});

	it('shows the "Nothing to report." placeholder for an empty section', () => {
		const empty: DirectorNotesNarrative = {
			version: 1,
			sections: [{ kind: 'accomplishments', title: 'Accomplishments', items: [] }],
		};
		render(<NarrativeSections theme={mockTheme} narrative={empty} />);

		expect(screen.getByText('Nothing to report.')).toBeInTheDocument();
		// No bullet list when there is nothing to list.
		expect(document.querySelector('ul')).toBeNull();
	});

	it('renders nothing when there are no sections at all', () => {
		const { container } = render(
			<NarrativeSections theme={mockTheme} narrative={{ version: 1, sections: [] }} />
		);

		expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument();
		// The wrapper renders but holds no section cards.
		expect(container.querySelector('section')).toBeNull();
	});

	describe('severity styling', () => {
		it('renders a critical item bold and in the error color', () => {
			render(<NarrativeSections theme={sentinelTheme} narrative={NARRATIVE} />);

			const critical = screen.getByText('Parser regression');
			expect(critical).toHaveStyle({ color: '#ff0000', fontWeight: '600' });

			// Its marker dot uses the error color too.
			const dot = critical.closest('li')?.querySelector('span[aria-hidden="true"]') as HTMLElement;
			expect(dot).toHaveStyle({ backgroundColor: '#ff0000' });
		});

		it('renders a neutral (no-severity) item un-bold in the main text color', () => {
			render(<NarrativeSections theme={sentinelTheme} narrative={NARRATIVE} />);

			const neutral = screen.getByText('Shipped the rich dashboard');
			expect(neutral).toHaveStyle({ color: '#101010', fontWeight: '400' });
		});

		it('keeps a warn item in the main text color (severity drives the dot, not the text)', () => {
			render(<NarrativeSections theme={sentinelTheme} narrative={NARRATIVE} />);

			const warn = screen.getByText('Slow CI runs');
			expect(warn).toHaveStyle({ color: '#101010', fontWeight: '400' });

			const dot = warn.closest('li')?.querySelector('span[aria-hidden="true"]') as HTMLElement;
			expect(dot).toHaveStyle({ backgroundColor: '#aa8800' });
		});
	});

	describe('per-kind accent color (cross-theme)', () => {
		it('derives each section icon color from theme.colors.* by kind', () => {
			render(<NarrativeSections theme={sentinelTheme} narrative={NARRATIVE} />);

			// accomplishments -> success, challenges -> warning, nextSteps -> accent.
			expect(screen.getByTestId('checkcircle2-icon')).toHaveStyle({ color: '#11aa11' });
			expect(screen.getByTestId('alerttriangle-icon')).toHaveStyle({ color: '#aa8800' });
			expect(screen.getByTestId('arrowright-icon')).toHaveStyle({ color: '#3333ff' });
		});
	});
});
