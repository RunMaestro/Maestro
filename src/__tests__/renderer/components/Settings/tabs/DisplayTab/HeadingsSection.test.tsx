import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeadingsSection } from '../../../../../../renderer/components/Settings/tabs/DisplayTab/components/HeadingsSection';
import { HEADING_LEVELS, type HeadingTypography } from '../../../../../../shared/typography';
import { mockTheme } from '../../../../../helpers/mockTheme';

vi.mock('../../../../../../renderer/hooks/ui/useElementWidth', () => ({
	useElementWidth: () => 700,
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

function renderSection(headingTypography: HeadingTypography = {}) {
	const handlers = {
		setHeadingFontFamily: vi.fn(),
		setHeadingFontSize: vi.fn(),
		resetHeadingTypography: vi.fn(),
	};
	render(
		<HeadingsSection
			theme={mockTheme}
			headingTypography={headingTypography}
			chatFontSize={0}
			baseFontSize={14}
			fontConfiguration={fontConfiguration}
			{...handlers}
		/>
	);
	return handlers;
}

afterEach(cleanup);

describe('HeadingsSection', () => {
	it('renders one font and size control per heading level', () => {
		renderSection();
		for (const level of HEADING_LEVELS) {
			const cell = screen.getByTestId(`heading-${level}`);
			expect(within(cell).getByRole('combobox')).toBeTruthy();
			expect(screen.getByTestId(`heading-size-${level}-value`)).toBeTruthy();
		}
	});

	it('shows the default size and steps away from it', () => {
		const { setHeadingFontSize } = renderSection();
		// 14px base at the 2x H1 scale.
		expect(screen.getByTestId('heading-size-h1-value').textContent).toBe('28px');
		expect(screen.getByTestId('heading-size-h1-inheriting').textContent).toBe('Default');
		fireEvent.click(screen.getByTestId('heading-size-h1-increase'));
		expect(setHeadingFontSize).toHaveBeenCalledWith('h1', 29);
	});

	it('writes a picked font to that level only', () => {
		const { setHeadingFontFamily } = renderSection();
		const select = within(screen.getByTestId('heading-h2')).getByRole('combobox');
		fireEvent.change(select, { target: { value: 'Georgia' } });
		expect(setHeadingFontFamily).toHaveBeenCalledWith('h2', 'Georgia');
	});

	it('enables Restore Default Headings only when something is customized', () => {
		renderSection();
		expect((screen.getByTestId('heading-typography-reset') as HTMLButtonElement).disabled).toBe(
			true
		);
		cleanup();

		const { resetHeadingTypography } = renderSection({ h3: { fontFamily: '', fontSize: 20 } });
		const button = screen.getByTestId('heading-typography-reset') as HTMLButtonElement;
		expect(button.disabled).toBe(false);
		fireEvent.click(button);
		expect(resetHeadingTypography).toHaveBeenCalledTimes(1);
	});
});
