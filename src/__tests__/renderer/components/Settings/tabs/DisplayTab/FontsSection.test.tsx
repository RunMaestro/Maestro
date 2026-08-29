import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FontsSection } from '../../../../../../renderer/components/Settings/tabs/DisplayTab/components/FontsSection';
import { INHERIT_TERMINAL } from '../../../../../../shared/typography';
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
				fontSize: 15,
				chatFontSize: 0,
				terminalFontSize: 13,
				filePreviewFontSize: 0,
				fileEditorFontSize: 0,
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

	it('puts both roots above the dependent surfaces', () => {
		// Interface and Terminal are not peers of what follows them, so they are
		// not in the grid.
		renderSection();
		const roots = within(screen.getByTestId('font-roots'));

		expect(roots.getByText('Interface')).toBeInTheDocument();
		expect(roots.getByText('Terminal')).toBeInTheDocument();
	});

	it('puts the three dependent surfaces in the grid', () => {
		renderSection();
		const grid = within(screen.getByTestId('font-dependents'));

		expect(grid.getByText('AI Chat')).toBeInTheDocument();
		expect(grid.getByText('File Preview')).toBeInTheDocument();
		expect(grid.getByText('File Editor')).toBeInTheDocument();
	});

	it('renders a size stepper for every surface', () => {
		renderSection();
		for (const surface of ['interface', 'terminal', 'chat', 'filePreview', 'fileEditor']) {
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
			expect(screen.getByTestId('font-dependents')).toHaveAttribute('data-columns', '2');
		});

		it('collapses to one column when the pane is narrow', () => {
			// The Settings content pane is only 424px at the modal's minimum
			// width, which cannot fit two dropdowns plus their steppers.
			mockWidth = 400;
			renderSection();
			expect(screen.getByTestId('font-dependents')).toHaveAttribute('data-columns', '1');
		});

		it('assumes two columns before the first measurement', () => {
			// 0 means "not measured yet". At the default modal width two columns
			// is the right answer, so the common case must not flash one column.
			mockWidth = 0;
			renderSection();
			expect(screen.getByTestId('font-dependents')).toHaveAttribute('data-columns', '2');
		});
	});
});
