import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CustomFontsRow } from '../../../../../../renderer/components/Settings/tabs/DisplayTab/components/CustomFontsRow';
import { mockTheme } from '../../../../../helpers/mockTheme';

function setup() {
	const onAddCustomFont = vi.fn();
	render(
		<CustomFontsRow
			theme={mockTheme}
			customFonts={[]}
			onAddCustomFont={onAddCustomFont}
			onRemoveCustomFont={vi.fn()}
		/>
	);
	const input = screen.getByTestId('custom-font-input');
	fireEvent.change(input, { target: { value: 'Noto Sans JP' } });
	return { input, onAddCustomFont };
}

describe('CustomFontsRow Enter', () => {
	it('adds the font on Enter', () => {
		const { input, onAddCustomFont } = setup();

		fireEvent.keyDown(input, { key: 'Enter' });

		expect(onAddCustomFont).toHaveBeenCalledWith('Noto Sans JP');
	});

	it('leaves Enter to the input method during an IME composition', () => {
		const { input, onAddCustomFont } = setup();

		for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
			fireEvent.keyDown(input, { key: 'Enter', ...ime });
		}

		expect(onAddCustomFont).not.toHaveBeenCalled();
		expect(input).toHaveValue('Noto Sans JP');
	});
});
