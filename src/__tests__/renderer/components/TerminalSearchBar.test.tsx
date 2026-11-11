import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TerminalSearchBar } from '../../../renderer/components/TerminalSearchBar';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../helpers/mockTheme';

function setup() {
	const onSearchNext = vi.fn(() => true);
	const onSearchPrevious = vi.fn(() => true);
	render(
		<LayerStackProvider>
			<TerminalSearchBar
				theme={mockTheme}
				isOpen={true}
				onClose={vi.fn()}
				onSearch={vi.fn(() => true)}
				onSearchNext={onSearchNext}
				onSearchPrevious={onSearchPrevious}
			/>
		</LayerStackProvider>
	);
	const input = screen.getByPlaceholderText('Search...');
	fireEvent.change(input, { target: { value: 'needle' } });
	return { input, onSearchNext, onSearchPrevious };
}

describe('TerminalSearchBar Enter', () => {
	it('moves to the next match on Enter and the previous one on Shift+Enter', () => {
		const { input, onSearchNext, onSearchPrevious } = setup();

		expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
		expect(onSearchNext).toHaveBeenCalledTimes(1);

		expect(fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })).toBe(false);
		expect(onSearchPrevious).toHaveBeenCalledTimes(1);
	});

	it('leaves Enter to the input method during an IME composition', () => {
		const { input, onSearchNext, onSearchPrevious } = setup();

		for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
			expect(fireEvent.keyDown(input, { key: 'Enter', ...ime })).toBe(true);
			expect(fireEvent.keyDown(input, { key: 'Enter', shiftKey: true, ...ime })).toBe(true);
		}

		expect(onSearchNext).not.toHaveBeenCalled();
		expect(onSearchPrevious).not.toHaveBeenCalled();
	});
});
