import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FontsSection } from '../../../../../../renderer/components/Settings/tabs/DisplayTab/components/FontsSection';
import {
	INHERIT_TERMINAL,
	TYPOGRAPHY_SURFACES,
	TYPOGRAPHY_SURFACE_SPECS,
} from '../../../../../../shared/typography';
import { mockTheme } from '../../../../../helpers/mockTheme';

/** Drives the responsive grid, which reads a measured width. */
let mockWidth = 700;
vi.mock('../../../../../../renderer/hooks/ui/useElementWidth', () => ({
	useElementWidth: () => mockWidth,
}));

const fontConfiguration = {
	systemFonts: ['Menlo'],
	customFonts: ['Georgia'],
	fontLoading: false,
	fontsLoaded: true,
	fontsReliable: true,
	handleFontInteraction: vi.fn(),
	addCustomFont: vi.fn(),
	removeCustomFont: vi.fn(),
};

function renderSection(settingsOverrides: Record<string, unknown> = {}) {
	const setSurfaceFontFamily = vi.fn();
	const setSurfaceFontSize = vi.fn();
	render(
		<FontsSection
			theme={mockTheme}
			settings={{
				fontFamily: 'Inter',
				terminalFontFamily: 'JetBrains Mono',
				chatFontFamily: '',
				filePreviewFontFamily: '',
				fileEditorFontFamily: '',
				documentGraphFontFamily: '',
				fontSize: 15,
				chatFontSize: 0,
				terminalFontSize: 13,
				filePreviewFontSize: 0,
				fileEditorFontSize: 0,
				documentGraphFontSize: 0,
				...settingsOverrides,
			}}
			fontConfiguration={fontConfiguration}
			setSurfaceFontFamily={setSurfaceFontFamily}
			setSurfaceFontSize={setSurfaceFontSize}
		/>
	);
	return { setSurfaceFontFamily, setSurfaceFontSize };
}

beforeEach(() => {
	mockWidth = 700;
	vi.clearAllMocks();
});

afterEach(() => {
	cleanup();
});

describe('FontsSection', () => {
	it('renders one custom-font manager for the whole group', () => {
		// The list is global. Five copies of this control - one per surface - is
		// what made the section read as five separate lists.
		renderSection();
		expect(screen.getAllByTestId('custom-font-input')).toHaveLength(1);
	});

	it('states the custom-font heading once, not again inside its card', () => {
		// The row used to print its own "Custom fonts" title and a restatement of
		// the description, directly under the section heading and description
		// saying the same two things.
		renderSection();

		expect(screen.getAllByText(/custom fonts/i)).toHaveLength(1);
		expect(
			screen.queryByText('Added here, offered in every picker below.')
		).not.toBeInTheDocument();
	});

	it('gives the two consecutive headings different icons', () => {
		// Custom Fonts and Fonts sit one above the other. Under one icon they
		// read as a single section with a stray subheading.
		renderSection();
		// The suite stubs every Lucide icon with an svg whose testid is the icon
		// name, so that attribute is what identifies which icon was passed.
		const iconFor = (settingId: string) =>
			document.querySelector(`[data-setting-id="${settingId}"] svg`)?.getAttribute('data-testid');

		expect(iconFor('display-custom-fonts')).toBeTruthy();
		expect(iconFor('display-custom-fonts')).not.toBe(iconFor('display-fonts'));
	});

	it('renders every surface in one grid', () => {
		// Six surfaces at two across is three even rows, so the roots no longer
		// need a full-width exception.
		renderSection();
		const grid = within(screen.getByTestId('font-surfaces'));

		for (const label of [
			'Interface',
			'Terminal',
			'AI Chat',
			'File Preview',
			'File Editor',
			'Document Graph',
		]) {
			expect(grid.getByText(label)).toBeInTheDocument();
		}
	});

	it('leads with the two roots, so reading order matches inheritance order', () => {
		renderSection();
		const labels = [
			...screen.getByTestId('font-surfaces').querySelectorAll('[data-testid^="font-surface-"]'),
		].map((el) => el.getAttribute('data-testid'));

		expect(labels.slice(0, 2)).toEqual(['font-surface-interface', 'font-surface-terminal']);
	});

	it('renders a size stepper for every surface', () => {
		renderSection();
		for (const surface of [
			'interface',
			'terminal',
			'chat',
			'filePreview',
			'fileEditor',
			'documentGraph',
		]) {
			expect(screen.getByTestId(`font-size-${surface}-value`)).toBeInTheDocument();
		}
	});

	describe('inherit options', () => {
		function optionsFor(surfaceId: string): string[] {
			const block = screen.getByTestId(`font-surface-${surfaceId}`);
			const select = within(block).getByRole('combobox');
			return [...select.querySelectorAll('option')]
				.filter((o) => o.parentElement?.tagName !== 'OPTGROUP')
				.map((o) => o.textContent ?? '');
		}

		it('offers both roots to a dependent surface', () => {
			renderSection();
			expect(optionsFor('chat')).toEqual(['Same as interface font', 'Same as terminal font']);
		});

		it('offers only the interface to the terminal', () => {
			// Terminal is itself a root - letting it follow another surface is what
			// would open the door to a cycle.
			renderSection();
			expect(optionsFor('terminal')).toEqual(['Same as interface font']);
		});

		it('offers no inherit option to the interface', () => {
			renderSection();
			expect(optionsFor('interface')).toEqual([]);
		});

		it('stores the terminal sentinel when that option is chosen', () => {
			const { setSurfaceFontFamily } = renderSection();
			const block = screen.getByTestId('font-surface-fileEditor');
			const select = within(block).getByRole('combobox');

			fireEvent.change(select, { target: { value: INHERIT_TERMINAL } });
			expect(setSurfaceFontFamily).toHaveBeenCalledWith('fileEditor', INHERIT_TERMINAL);
		});
	});

	describe('responsive grid', () => {
		it('uses two columns when there is room', () => {
			mockWidth = 700;
			renderSection();
			expect(screen.getByTestId('font-surfaces')).toHaveAttribute('data-columns', '2');
		});

		it('collapses to one column when the pane is narrow', () => {
			// The Settings content pane is only 424px at the modal's minimum
			// width, which cannot fit two dropdowns plus their steppers.
			mockWidth = 400;
			renderSection();
			expect(screen.getByTestId('font-surfaces')).toHaveAttribute('data-columns', '1');
		});

		it('assumes two columns before the first measurement', () => {
			// 0 means "not measured yet". At the default modal width two columns
			// is the right answer, so the common case must not flash one column.
			mockWidth = 0;
			renderSection();
			expect(screen.getByTestId('font-surfaces')).toHaveAttribute('data-columns', '2');
		});
	});
	describe('row alignment', () => {
		/**
		 * Descriptions differ in length, so two cells in the same row have
		 * different natural heights and their pickers used to sit at different
		 * vertical positions. Grid rows stretch their items to equal height, and
		 * the description claims the slack, so the controls land on one baseline.
		 *
		 * Solved in the layout rather than by measuring text: the descriptions
		 * re-wrap with the pane width, the interface font, and the zoom, so any
		 * padding computed once would be wrong at the next width.
		 */
		it('stretches every cell to the height of its row', () => {
			renderSection();
			expect(screen.getByTestId('font-surfaces').className).toContain('items-stretch');
		});

		it('lays each cell out as a flex column', () => {
			renderSection();
			const cell = screen.getByTestId('font-surface-interface');

			expect(cell.className).toContain('flex');
			expect(cell.className).toContain('flex-col');
		});

		it('lets the description absorb the height difference', () => {
			// This is the piece that does the aligning: without flex-1 the extra
			// height pools below the control instead of above it.
			renderSection();
			const cell = screen.getByTestId('font-surface-interface');
			const description = within(cell).getByText(TYPOGRAPHY_SURFACE_SPECS.interface.description);

			expect(description.className).toContain('flex-1');
		});

		it('gives every cell the same structure, so no row can be a special case', () => {
			renderSection();
			for (const surface of TYPOGRAPHY_SURFACES) {
				const cell = screen.getByTestId(`font-surface-${surface}`);
				expect(cell.className).toContain('flex-col');
				expect(
					within(cell).getByText(TYPOGRAPHY_SURFACE_SPECS[surface].description).className
				).toContain('flex-1');
			}
		});
	});

	describe('picker type scale', () => {
		it('sizes the dropdown down to its own label', () => {
			// The select inherits the interface font size otherwise, so at a 16px
			// setting with a 1.2 zoom it rendered near 19px - larger than the
			// heading above it, and truncating long font stacks that much sooner.
			renderSection();
			const select = within(screen.getByTestId('font-surface-interface')).getByRole('combobox');

			expect(select.className).toContain('text-xs');
		});

		it('exposes the full value as a tooltip, since the control truncates it', () => {
			renderSection({ fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif' });
			const select = within(screen.getByTestId('font-surface-interface')).getByRole('combobox');

			expect(select).toHaveAttribute(
				'title',
				'Inter, -apple-system, BlinkMacSystemFont, sans-serif'
			);
		});

		it('omits the tooltip for a surface that is following a root', () => {
			// "Same as interface font" is already fully visible; a tooltip
			// repeating an empty stored value would be noise.
			renderSection();
			const select = within(screen.getByTestId('font-surface-chat')).getByRole('combobox');

			expect(select).not.toHaveAttribute('title');
		});
	});

	describe('live previews', () => {
		it('draws every sample from the custom properties the app paints with', () => {
			// Reading the published variables rather than re-resolving inheritance
			// here is what stops the sample from drifting from the running app: a
			// surface following the terminal previews whatever the terminal
			// currently resolves to, with no second resolver to disagree.
			renderSection();

			for (const surface of TYPOGRAPHY_SURFACES) {
				const spec = TYPOGRAPHY_SURFACE_SPECS[surface];
				const sample = within(screen.getByTestId(`font-surface-${surface}`))
					.getByTestId('font-preview')
					.querySelector('p');

				expect(sample?.style.fontFamily).toBe(`var(${spec.fontVar})`);
				expect(sample?.style.fontSize).toBe(`var(${spec.sizeVar})`);
			}
		});

		it('gives each surface its own sample rather than one for the section', () => {
			renderSection();
			expect(screen.getAllByTestId('font-preview')).toHaveLength(TYPOGRAPHY_SURFACES.length);
		});
	});
});
