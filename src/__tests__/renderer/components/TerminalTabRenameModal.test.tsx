import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TerminalTabRenameModal } from '../../../renderer/components/TerminalTabRenameModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../renderer/types';

const mockTheme: Theme = {
	id: 'dracula',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgSidebar: '#202020',
		bgActivity: '#2d2d2d',
		border: '#333333',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#0066ff',
		accentDim: '#0066ff66',
		accentText: '#7cd4ff',
		accentForeground: '#ffffff',
		success: '#00aa00',
		warning: '#ffaa00',
		error: '#ff0000',
	},
};

function mount(component: React.ReactElement): {
	container: HTMLDivElement;
	root: Root;
	rerender: (next: React.ReactElement) => void;
} {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);

	act(() => {
		root.render(<LayerStackProvider>{component}</LayerStackProvider>);
	});

	const rerender = (next: React.ReactElement) => {
		act(() => {
			root.render(<LayerStackProvider>{next}</LayerStackProvider>);
		});
	};

	return { container, root, rerender };
}

function queryInput(container: HTMLElement): HTMLInputElement {
	const input = container.querySelector('input');
	expect(input).toBeTruthy();
	return input as HTMLInputElement;
}

function clickButton(container: HTMLElement, label: string): void {
	const button = Array.from(container.querySelectorAll('button')).find(
		(candidate) => candidate.textContent?.trim() === label
	);
	expect(button).toBeTruthy();
	act(() => {
		button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	});
}

function setInputValue(input: HTMLInputElement, value: string): void {
	act(() => {
		const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
		valueSetter?.call(input, value);
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new Event('change', { bubbles: true }));
	});
}

describe('TerminalTabRenameModal', () => {
	beforeEach(() => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.clearAllMocks();
	});

	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('does not render when closed', () => {
		const { container, root } = mount(
			<TerminalTabRenameModal
				theme={mockTheme}
				isOpen={false}
				currentName="Build"
				defaultName="Terminal 1"
				onSave={vi.fn()}
				onClose={vi.fn()}
			/>
		);

		expect(container.querySelector('[role="dialog"]')).toBeNull();

		act(() => {
			root.unmount();
		});
	});

	it('renders the current name and helper text', () => {
		const { container, root } = mount(
			<TerminalTabRenameModal
				theme={mockTheme}
				isOpen
				currentName="Build"
				defaultName="Terminal 2"
				onSave={vi.fn()}
				onClose={vi.fn()}
			/>
		);

		const input = queryInput(container);
		expect(input.value).toBe('Build');
		expect(input.getAttribute('placeholder')).toBe('Terminal 2');
		expect(container.textContent).toContain('Leave empty to use default name (Terminal 2)');

		act(() => {
			root.unmount();
		});
	});

	it('saves the trimmed value from Save button', () => {
		const onSave = vi.fn();
		const onClose = vi.fn();
		const { container, root } = mount(
			<TerminalTabRenameModal
				theme={mockTheme}
				isOpen
				currentName="Build"
				defaultName="Terminal 1"
				onSave={onSave}
				onClose={onClose}
			/>
		);

		setInputValue(queryInput(container), '  New Name  ');
		clickButton(container, 'Save');

		expect(onSave).toHaveBeenCalledWith('New Name');
		expect(onClose).toHaveBeenCalledTimes(1);

		act(() => {
			root.unmount();
		});
	});

	it('saves via Enter key in the input', () => {
		const onSave = vi.fn();
		const onClose = vi.fn();
		const { container, root } = mount(
			<TerminalTabRenameModal
				theme={mockTheme}
				isOpen
				currentName={null}
				defaultName="Terminal 3"
				onSave={onSave}
				onClose={onClose}
			/>
		);

		const input = queryInput(container);
		setInputValue(input, 'Runner');
		act(() => {
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		});

		expect(onSave).toHaveBeenCalledWith('Runner');
		expect(onClose).toHaveBeenCalledTimes(1);

		act(() => {
			root.unmount();
		});
	});

	it('closes without saving when Cancel is clicked', () => {
		const onSave = vi.fn();
		const onClose = vi.fn();
		const { container, root } = mount(
			<TerminalTabRenameModal
				theme={mockTheme}
				isOpen
				currentName="Build"
				defaultName="Terminal 1"
				onSave={onSave}
				onClose={onClose}
			/>
		);

		clickButton(container, 'Cancel');

		expect(onSave).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalledTimes(1);

		act(() => {
			root.unmount();
		});
	});

	it('resets input value when reopened for another tab', () => {
		const onSave = vi.fn();
		const onClose = vi.fn();
		const { container, root, rerender } = mount(
			<TerminalTabRenameModal
				theme={mockTheme}
				isOpen
				currentName="First"
				defaultName="Terminal 1"
				onSave={onSave}
				onClose={onClose}
			/>
		);

		setInputValue(queryInput(container), 'Edited Locally');

		rerender(
			<TerminalTabRenameModal
				theme={mockTheme}
				isOpen={false}
				currentName="First"
				defaultName="Terminal 1"
				onSave={onSave}
				onClose={onClose}
			/>
		);

		rerender(
			<TerminalTabRenameModal
				theme={mockTheme}
				isOpen
				currentName="Second"
				defaultName="Terminal 2"
				onSave={onSave}
				onClose={onClose}
			/>
		);

		expect(queryInput(container).value).toBe('Second');

		act(() => {
			root.unmount();
		});
	});
});
