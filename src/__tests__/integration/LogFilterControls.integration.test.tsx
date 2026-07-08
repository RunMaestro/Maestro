import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LogFilterControls } from '../../renderer/components/LogFilterControls';
import type { Theme } from '../../renderer/types';

const theme: Theme = {
	id: 'dracula',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#222222',
		bgActivity: '#333333',
		border: '#444444',
		textMain: '#ffffff',
		textDim: '#999999',
		accent: '#8b5cf6',
		accentDim: '#6d28d9',
		accentText: '#f5f3ff',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

function createProps(overrides: Partial<Parameters<typeof LogFilterControls>[0]> = {}) {
	return {
		logId: 'log-1',
		fontFamily: 'Menlo, monospace',
		theme,
		filterQuery: '',
		filterMode: { mode: 'include' as const, regex: false },
		isActive: false,
		onToggleFilter: vi.fn(),
		onSetFilterQuery: vi.fn(),
		onSetFilterMode: vi.fn(),
		onClearFilter: vi.fn(),
		...overrides,
	};
}

describe('LogFilterControls', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('opens the filter from the collapsed icon', () => {
		const onToggleFilter = vi.fn();
		render(<LogFilterControls {...createProps({ onToggleFilter })} />);

		fireEvent.click(screen.getByTitle('Filter this output'));

		expect(onToggleFilter).toHaveBeenCalledWith('log-1');
	});

	it('updates include mode, text query, and closes on Escape', () => {
		const onSetFilterMode = vi.fn();
		const onSetFilterQuery = vi.fn();
		const onClearFilter = vi.fn();
		render(
			<LogFilterControls
				{...createProps({
					isActive: true,
					onSetFilterMode,
					onSetFilterQuery,
					onClearFilter,
				})}
			/>
		);

		const modeButton = screen.getByTitle('Include matching lines');
		const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		expect(modeButton.dispatchEvent(mouseDown)).toBe(false);
		expect(mouseDown.defaultPrevented).toBe(true);

		fireEvent.click(modeButton);
		const modeUpdater = onSetFilterMode.mock.calls[0][1] as Parameters<
			Parameters<typeof LogFilterControls>[0]['onSetFilterMode']
		>[1];
		expect(modeUpdater({ mode: 'include', regex: false })).toEqual({
			mode: 'exclude',
			regex: false,
		});
		expect(modeUpdater({ mode: 'exclude', regex: true })).toEqual({
			mode: 'include',
			regex: true,
		});

		const input = screen.getByPlaceholderText('Include by keyword');
		fireEvent.change(input, { target: { value: 'warning' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(onClearFilter).not.toHaveBeenCalled();
		fireEvent.keyDown(input, { key: 'Escape' });

		expect(onSetFilterQuery).toHaveBeenCalledWith('log-1', 'warning');
		expect(onClearFilter).toHaveBeenCalledWith('log-1');
	});

	it('updates regex mode and clears the active filter', () => {
		const onSetFilterMode = vi.fn();
		const onClearFilter = vi.fn();
		render(
			<LogFilterControls
				{...createProps({
					filterQuery: 'error',
					filterMode: { mode: 'exclude', regex: true },
					onSetFilterMode,
					onClearFilter,
				})}
			/>
		);

		expect(screen.getByPlaceholderText('Exclude by RegEx')).toBeInTheDocument();
		expect(screen.getByTitle('Exclude matching lines')).toBeInTheDocument();

		const regexButton = screen.getByTitle('Using regex');
		const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		expect(regexButton.dispatchEvent(mouseDown)).toBe(false);
		expect(mouseDown.defaultPrevented).toBe(true);

		fireEvent.click(regexButton);
		const regexUpdater = onSetFilterMode.mock.calls[0][1] as Parameters<
			Parameters<typeof LogFilterControls>[0]['onSetFilterMode']
		>[1];
		expect(regexUpdater({ mode: 'include', regex: true })).toEqual({
			mode: 'include',
			regex: false,
		});
		expect(regexUpdater({ mode: 'exclude', regex: false })).toEqual({
			mode: 'exclude',
			regex: true,
		});

		const clearButton = screen.getByTestId('x-icon').closest('button');
		expect(clearButton).not.toBeNull();
		fireEvent.click(clearButton!);

		expect(onClearFilter).toHaveBeenCalledWith('log-1');
	});

	it('renders include-regex and exclude-keyword placeholder variants', () => {
		const { rerender } = render(
			<LogFilterControls
				{...createProps({
					isActive: true,
					filterMode: { mode: 'include', regex: true },
				})}
			/>
		);

		expect(screen.getByPlaceholderText('Include by RegEx')).toBeInTheDocument();

		rerender(
			<LogFilterControls
				{...createProps({
					isActive: true,
					filterMode: { mode: 'exclude', regex: false },
				})}
			/>
		);

		expect(screen.getByPlaceholderText('Exclude by keyword')).toBeInTheDocument();
	});

	it('auto-closes on blur only when the query is empty', () => {
		const onToggleFilter = vi.fn();
		const { rerender } = render(
			<LogFilterControls {...createProps({ isActive: true, onToggleFilter })} />
		);

		fireEvent.blur(screen.getByPlaceholderText('Include by keyword'));
		expect(onToggleFilter).toHaveBeenCalledWith('log-1');

		onToggleFilter.mockClear();
		rerender(
			<LogFilterControls
				{...createProps({
					filterQuery: 'keep open',
					isActive: true,
					onToggleFilter,
				})}
			/>
		);

		fireEvent.blur(screen.getByDisplayValue('keep open'));

		expect(onToggleFilter).not.toHaveBeenCalled();
	});
});
