import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { IgnorePatternsSection } from '../../../../renderer/components/Settings/IgnorePatternsSection';
import { mockTheme } from '../../../helpers/mockTheme';

function setup() {
	const onIgnorePatternsChange = vi.fn();
	render(
		<IgnorePatternsSection
			theme={mockTheme}
			title="Local Ignore Patterns"
			description="Patterns to skip"
			ignorePatterns={['node_modules']}
			onIgnorePatternsChange={onIgnorePatternsChange}
			defaultPatterns={['node_modules']}
		/>
	);
	const input = screen.getByPlaceholderText(/Enter glob pattern/);
	fireEvent.change(input, { target: { value: '*.log' } });
	return { input, onIgnorePatternsChange };
}

describe('IgnorePatternsSection Enter', () => {
	it('adds the pattern on Enter', () => {
		const { input, onIgnorePatternsChange } = setup();

		expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);

		expect(onIgnorePatternsChange).toHaveBeenCalledWith(['node_modules', '*.log']);
	});

	it('leaves Enter to the input method during an IME composition', () => {
		const { input, onIgnorePatternsChange } = setup();

		for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
			expect(fireEvent.keyDown(input, { key: 'Enter', ...ime })).toBe(true);
		}

		expect(onIgnorePatternsChange).not.toHaveBeenCalled();
	});
});
