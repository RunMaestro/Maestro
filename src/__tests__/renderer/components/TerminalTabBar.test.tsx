import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TerminalTabBar } from '../../../renderer/components/TerminalTabBar';
import type { TerminalTab, Theme } from '../../../renderer/types';

vi.mock('lucide-react', () => ({
	X: ({ className }: { className?: string }) => <span data-testid="x-icon" className={className} />,
	Plus: ({ className }: { className?: string }) => (
		<span data-testid="plus-icon" className={className} />
	),
	Terminal: ({ className }: { className?: string }) => (
		<span data-testid="terminal-icon" className={className} />
	),
}));

const mockTheme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgSidebar: '#222222',
		bgActivity: '#2c2c2c',
		border: '#404040',
		textMain: '#ffffff',
		textDim: '#a0a0a0',
		accent: '#00a4ff',
		accentDim: '#0077bb',
		accentText: '#7cd4ff',
		accentForeground: '#ffffff',
		success: '#00ff88',
		warning: '#ffaa00',
		error: '#ff4d4f',
	},
} as Theme;

function createTerminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
	return {
		id: 'terminal-1',
		name: null,
		shellType: 'zsh',
		pid: 101,
		cwd: '/tmp',
		createdAt: Date.now(),
		state: 'idle',
		...overrides,
	};
}

function mount(component: React.ReactElement): { container: HTMLDivElement; root: Root } {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);

	act(() => {
		root.render(component);
	});

	return { container, root };
}

describe('TerminalTabBar', () => {
	const onTabSelect = vi.fn();
	const onTabClose = vi.fn();
	const onNewTab = vi.fn();
	const onTabReorder = vi.fn();

	beforeEach(() => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.clearAllMocks();
	});

	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('renders helper fallback and custom tab names', () => {
		const tabs = [
			createTerminalTab({ id: 'terminal-1', name: null }),
			createTerminalTab({ id: 'terminal-2', name: 'Build Shell' }),
		];

		const { container, root } = mount(
			<TerminalTabBar
				tabs={tabs}
				activeTabId="terminal-1"
				theme={mockTheme}
				onTabSelect={onTabSelect}
				onTabClose={onTabClose}
				onNewTab={onNewTab}
			/>
		);

		const tabBar = container.firstElementChild as HTMLDivElement | null;
		expect(tabBar).toBeTruthy();
		expect(tabBar?.className).toContain('overflow-x-auto');
		expect(tabBar?.className).toContain('scrollbar-thin');

		expect(container.textContent).toContain('Terminal 1');
		expect(container.textContent).toContain('Build Shell');

		act(() => {
			root.unmount();
		});
	});

	it('calls onTabSelect when clicking a tab', () => {
		const tabs = [
			createTerminalTab({ id: 'terminal-1', name: 'One' }),
			createTerminalTab({ id: 'terminal-2', name: 'Two' }),
		];

		const { container, root } = mount(
			<TerminalTabBar
				tabs={tabs}
				activeTabId="terminal-1"
				theme={mockTheme}
				onTabSelect={onTabSelect}
				onTabClose={onTabClose}
				onNewTab={onNewTab}
			/>
		);

		const tabLabel = Array.from(container.querySelectorAll('span')).find(
			(el) => el.textContent === 'Two'
		);
		expect(tabLabel?.parentElement).toBeTruthy();

		act(() => {
			tabLabel?.parentElement?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		});

		expect(onTabSelect).toHaveBeenCalledWith('terminal-2');

		act(() => {
			root.unmount();
		});
	});

	it('hides close button when only one tab exists', () => {
		const { container, root } = mount(
			<TerminalTabBar
				tabs={[createTerminalTab({ id: 'terminal-1', name: 'Solo' })]}
				activeTabId="terminal-1"
				theme={mockTheme}
				onTabSelect={onTabSelect}
				onTabClose={onTabClose}
				onNewTab={onNewTab}
			/>
		);

		expect(container.querySelector('button[title="Close terminal"]')).toBeNull();

		act(() => {
			root.unmount();
		});
	});

	it('shows non-zero exit code for exited terminal tabs', () => {
		const tabs = [
			createTerminalTab({
				id: 'terminal-1',
				name: 'Exited Shell',
				state: 'exited',
				exitCode: 127,
			}),
		];

		const { container, root } = mount(
			<TerminalTabBar
				tabs={tabs}
				activeTabId="terminal-1"
				theme={mockTheme}
				onTabSelect={onTabSelect}
				onTabClose={onTabClose}
				onNewTab={onNewTab}
			/>
		);

		expect(container.textContent).toContain('(127)');

		act(() => {
			root.unmount();
		});
	});

	it('calls onNewTab from new terminal button', () => {
		const expectedTitle = `New terminal (${process.platform === 'darwin' ? 'Ctrl+Shift+`' : 'Ctrl+Shift+`'})`;

		const { container, root } = mount(
			<TerminalTabBar
				tabs={[createTerminalTab({ id: 'terminal-1', name: 'Solo' })]}
				activeTabId="terminal-1"
				theme={mockTheme}
				onTabSelect={onTabSelect}
				onTabClose={onTabClose}
				onNewTab={onNewTab}
			/>
		);

		const newTabButton = container.querySelector(`button[title="${expectedTitle}"]`);
		expect(newTabButton).toBeTruthy();
		expect(newTabButton?.getAttribute('title')).toBe(expectedTitle);

		act(() => {
			newTabButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		});

		expect(onNewTab).toHaveBeenCalledTimes(1);

		act(() => {
			root.unmount();
		});
	});

	it('calls onTabReorder when dropping a tab on another tab', () => {
		const tabs = [
			createTerminalTab({ id: 'terminal-1', name: 'One' }),
			createTerminalTab({ id: 'terminal-2', name: 'Two' }),
		];

		const { container, root } = mount(
			<TerminalTabBar
				tabs={tabs}
				activeTabId="terminal-1"
				theme={mockTheme}
				onTabSelect={onTabSelect}
				onTabClose={onTabClose}
				onNewTab={onNewTab}
				onTabReorder={onTabReorder}
			/>
		);

		const firstTab = Array.from(container.querySelectorAll('span')).find(
			(el) => el.textContent === 'One'
		)?.parentElement;
		const secondTab = Array.from(container.querySelectorAll('span')).find(
			(el) => el.textContent === 'Two'
		)?.parentElement;

		expect(firstTab).toBeTruthy();
		expect(secondTab).toBeTruthy();

		const dragState = new Map<string, string>();
		const dataTransfer = {
			effectAllowed: 'none',
			dropEffect: 'none',
			setData: vi.fn((type: string, value: string) => {
				dragState.set(type, value);
			}),
			getData: vi.fn((type: string) => dragState.get(type) ?? ''),
		};

		const dragStartEvent = new Event('dragstart', { bubbles: true, cancelable: true });
		Object.defineProperty(dragStartEvent, 'dataTransfer', {
			value: dataTransfer,
		});

		const dragOverEvent = new Event('dragover', { bubbles: true, cancelable: true });
		Object.defineProperty(dragOverEvent, 'dataTransfer', {
			value: dataTransfer,
		});

		const dropEvent = new Event('drop', { bubbles: true, cancelable: true });
		Object.defineProperty(dropEvent, 'dataTransfer', {
			value: dataTransfer,
		});

		act(() => {
			firstTab?.dispatchEvent(dragStartEvent);
			secondTab?.dispatchEvent(dragOverEvent);
			secondTab?.dispatchEvent(dropEvent);
		});

		expect(onTabReorder).toHaveBeenCalledWith(0, 1);

		act(() => {
			root.unmount();
		});
	});
});
