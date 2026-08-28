import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
		renderPanel({ fontFamily: 'Verdana' });

		// A <select> with no matching option silently shows its first entry, so
		// the dropdown claimed Roboto Mono while the app rendered Verdana.
		expect(screen.getByRole('combobox')).toHaveValue('Verdana');
		expect(screen.getByRole('group', { name: 'Current' })).toBeInTheDocument();
	});

	it('does not duplicate a font that is already listed', () => {
		renderPanel({ fontFamily: 'Verdana', customFonts: ['Verdana'] });

		expect(screen.getByRole('combobox')).toHaveValue('Verdana');
		expect(screen.queryByRole('group', { name: 'Current' })).not.toBeInTheDocument();
		expect(screen.getAllByRole('option', { name: 'Verdana' })).toHaveLength(1);
	});

	it('renders a removable pill for each custom font', () => {
		const onRemoveCustomFont = vi.fn();
		renderPanel({ customFonts: ['Verdana', 'Helvetica'], onRemoveCustomFont });

		const removeButtons = screen.getAllByRole('button', { name: '×' });
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
				customFonts: ['Verdana'],
			});

			fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
			expect(setFontFamily).toHaveBeenCalledWith('Verdana');
		});

		it('stops at the ends instead of wrapping', () => {
			const setFontFamily = vi.fn();
			renderPanel({ fontFamily: 'Roboto Mono', setFontFamily });
			fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowUp' });
			expect(setFontFamily).not.toHaveBeenCalled();

			cleanup();
			renderPanel({ fontFamily: 'Source Code Pro', setFontFamily });
			fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
			expect(setFontFamily).not.toHaveBeenCalled();
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
