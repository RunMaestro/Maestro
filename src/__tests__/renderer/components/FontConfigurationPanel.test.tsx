import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FontConfigurationPanel } from '../../../renderer/components/FontConfigurationPanel';
import { mockTheme } from '../../helpers/mockTheme';

function renderPanel(overrides: Partial<React.ComponentProps<typeof FontConfigurationPanel>> = {}) {
	return render(
		<FontConfigurationPanel
			fontFamily="Roboto Mono"
			setFontFamily={vi.fn()}
			systemFonts={[]}
			fontsLoaded={false}
			fontLoading={false}
			customFonts={[]}
			onAddCustomFont={vi.fn()}
			onRemoveCustomFont={vi.fn()}
			onFontInteraction={vi.fn()}
			theme={mockTheme}
			{...overrides}
		/>
	);
}

describe('FontConfigurationPanel', () => {
	it('reports the saved font even when it is in no font group', () => {
		renderPanel({ fontFamily: 'Berkeley Mono' });

		// A <select> with no matching option silently shows its first entry, so
		// the dropdown claimed Roboto Mono while the app rendered Berkeley Mono.
		expect(screen.getByRole('combobox')).toHaveValue('Berkeley Mono');
		expect(screen.getByRole('group', { name: 'Current' })).toBeInTheDocument();
	});

	it('does not duplicate a font that is already listed', () => {
		renderPanel({ fontFamily: 'Berkeley Mono', customFonts: ['Berkeley Mono'] });

		expect(screen.getByRole('combobox')).toHaveValue('Berkeley Mono');
		expect(screen.queryByRole('group', { name: 'Current' })).not.toBeInTheDocument();
		expect(screen.getAllByRole('option', { name: 'Berkeley Mono' })).toHaveLength(1);
	});

	it('offers proportional faces alongside the monospace ones', () => {
		// Maestro was fixed width everywhere before per-surface fonts, so a
		// reading face had to be typed in by hand to be reachable at all.
		renderPanel();

		expect(screen.getByRole('group', { name: 'Common Proportional Fonts' })).toBeInTheDocument();
		for (const font of ['Arial', 'Helvetica', 'Verdana', 'Avenir Next']) {
			expect(screen.getByRole('option', { name: font })).toBeInTheDocument();
		}
	});

	it('leaves the inherit option selectable without a Current group', () => {
		renderPanel({
			fontFamily: '',
			inheritOption: { value: '', label: 'Same as interface font' },
		});

		expect(screen.getByRole('combobox')).toHaveValue('');
		expect(screen.queryByRole('group', { name: 'Current' })).not.toBeInTheDocument();
	});

	it('renders a removable pill for each custom font', () => {
		const onRemoveCustomFont = vi.fn();
		renderPanel({ customFonts: ['Verdana', 'Helvetica'], onRemoveCustomFont });

		const removeButtons = screen.getAllByRole('button', { name: '\u00d7' });
		expect(removeButtons).toHaveLength(2);

		fireEvent.click(removeButtons[0]);
		expect(onRemoveCustomFont).toHaveBeenCalledWith('Verdana');
	});
	describe('arrow-key preview', () => {
		it('steps to the next and previous font without opening the dropdown', () => {
			const setFontFamily = vi.fn();
			renderPanel({ fontFamily: 'JetBrains Mono', setFontFamily });
			const select = screen.getByRole('combobox');

			fireEvent.keyDown(select, { key: 'ArrowDown' });
			expect(setFontFamily).toHaveBeenLastCalledWith('Fira Code');

			fireEvent.keyDown(select, { key: 'ArrowUp' });
			expect(setFontFamily).toHaveBeenLastCalledWith('Roboto Mono');
		});

		it('walks out of one group and into the next', () => {
			const setFontFamily = vi.fn();
			renderPanel({
				fontFamily: 'Source Code Pro', // last common monospace font
				setFontFamily,
			});

			fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
			expect(setFontFamily).toHaveBeenCalledWith('Arial'); // first proportional font
		});

		it('reaches the installed fonts once the system sweep has run', () => {
			const setFontFamily = vi.fn();
			renderPanel({
				fontFamily: 'Iosevka',
				setFontFamily,
				customFonts: ['Iosevka'],
				systemFonts: ['Zapfino'],
				fontsLoaded: true,
			});

			fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
			expect(setFontFamily).toHaveBeenCalledWith('Zapfino');
		});

		it('stops at the ends instead of wrapping', () => {
			const setFontFamily = vi.fn();
			const { rerender } = renderPanel({ fontFamily: 'Roboto Mono', setFontFamily });

			fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowUp' });
			expect(setFontFamily).not.toHaveBeenCalled();

			rerender(
				<FontConfigurationPanel
					fontFamily="Georgia"
					setFontFamily={setFontFamily}
					systemFonts={[]}
					fontsLoaded={false}
					fontLoading={false}
					customFonts={[]}
					onAddCustomFont={vi.fn()}
					onRemoveCustomFont={vi.fn()}
					onFontInteraction={vi.fn()}
					theme={mockTheme}
				/>
			);
			fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
			expect(setFontFamily).not.toHaveBeenCalled();
		});

		it('starts from the inherit entry when the terminal font inherits', () => {
			const setFontFamily = vi.fn();
			renderPanel({
				fontFamily: '',
				setFontFamily,
				inheritOption: { value: '', label: 'Same as interface font' },
			});

			fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
			expect(setFontFamily).toHaveBeenCalledWith('Roboto Mono');
		});

		it('leaves other keys to the browser', () => {
			const setFontFamily = vi.fn();
			renderPanel({ fontFamily: 'Roboto Mono', setFontFamily });

			fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
			fireEvent.keyDown(screen.getByRole('combobox'), { key: 'a' });
			expect(setFontFamily).not.toHaveBeenCalled();
		});
	});
});
