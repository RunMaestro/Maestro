import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OutputSearchBar } from '../../../../renderer/components/TerminalOutput/components/OutputSearchBar';
import { mockTheme } from '../../../helpers/mockTheme';

describe('OutputSearchBar IME composition', () => {
	function renderBar(overrides = {}) {
		const defaultProps = {
			theme: mockTheme,
			outputSearchQuery: 'search text',
			outputSearchRegex: false,
			regexError: null,
			currentMatchIndex: 0,
			totalMatches: 3,
			setOutputSearchQuery: vi.fn(),
			setOutputSearchRegex: vi.fn(),
			goToNextMatch: vi.fn(),
			goToPrevMatch: vi.fn(),
			onClose: vi.fn(),
			...overrides,
		};
		return {
			...render(<OutputSearchBar {...defaultProps} />),
			props: defaultProps,
		};
	}

	it('steps to next match on normal Enter key', () => {
		const goToNextMatch = vi.fn();
		renderBar({ goToNextMatch });

		const input = screen.getByRole('textbox');
		const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
		const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
		const stopPropagationSpy = vi.spyOn(event, 'stopPropagation');

		input.dispatchEvent(event);

		expect(goToNextMatch).toHaveBeenCalledTimes(1);
		expect(preventDefaultSpy).toHaveBeenCalled();
		expect(stopPropagationSpy).toHaveBeenCalled();
	});

	it('steps to previous match on normal Shift+Enter', () => {
		const goToPrevMatch = vi.fn();
		renderBar({ goToPrevMatch });

		const input = screen.getByRole('textbox');
		const event = new KeyboardEvent('keydown', {
			key: 'Enter',
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		});
		const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
		const stopPropagationSpy = vi.spyOn(event, 'stopPropagation');

		input.dispatchEvent(event);

		expect(goToPrevMatch).toHaveBeenCalledTimes(1);
		expect(preventDefaultSpy).toHaveBeenCalled();
		expect(stopPropagationSpy).toHaveBeenCalled();
	});

	it('does not step match on Enter during active IME composition (isComposing: true)', () => {
		const goToNextMatch = vi.fn();
		renderBar({ goToNextMatch });

		const input = screen.getByRole('textbox');
		const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
		Object.defineProperty(event, 'isComposing', { value: true });
		const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
		const stopPropagationSpy = vi.spyOn(event, 'stopPropagation');

		input.dispatchEvent(event);

		expect(goToNextMatch).not.toHaveBeenCalled();
		expect(preventDefaultSpy).not.toHaveBeenCalled();
		expect(stopPropagationSpy).toHaveBeenCalled();
	});

	it('does not step match on Enter during Safari IME candidate confirmation (keyCode 229)', () => {
		const goToNextMatch = vi.fn();
		renderBar({ goToNextMatch });

		const input = screen.getByRole('textbox');
		const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
		Object.defineProperty(event, 'keyCode', { value: 229 });
		const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
		const stopPropagationSpy = vi.spyOn(event, 'stopPropagation');

		input.dispatchEvent(event);

		expect(goToNextMatch).not.toHaveBeenCalled();
		expect(preventDefaultSpy).not.toHaveBeenCalled();
		expect(stopPropagationSpy).toHaveBeenCalled();
	});
});
