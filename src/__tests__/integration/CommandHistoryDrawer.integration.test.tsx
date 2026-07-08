import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '../../web/components/ThemeProvider';
import { CommandHistoryDrawer } from '../../web/mobile/CommandHistoryDrawer';
import type { CommandHistoryEntry } from '../../web/hooks/useCommandHistory';
import type { Theme } from '../../shared/theme-types';

const theme: Theme = {
	id: 'integration-mobile',
	name: 'Integration Mobile',
	mode: 'dark',
	colors: {
		accent: '#2563eb',
		accentDim: '#1d4ed8',
		accentForeground: '#ffffff',
		accentText: '#93c5fd',
		bgActivity: '#0f172a',
		bgMain: '#111827',
		bgSidebar: '#1f2937',
		border: '#374151',
		error: '#dc2626',
		success: '#16a34a',
		textDim: '#9ca3af',
		textMain: '#f9fafb',
		warning: '#f59e0b',
	},
};

describe('CommandHistoryDrawer integration', () => {
	beforeEach(() => {
		vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-05-26T12:00:00.000Z'));
		Object.defineProperty(navigator, 'vibrate', {
			configurable: true,
			value: vi.fn(),
		});
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('renders nothing while closed and closes empty history from the backdrop', () => {
		const onClose = vi.fn();
		const { container, rerender } = renderDrawer({ isOpen: false, onClose });
		expect(container.firstChild).toBeNull();

		rerender(
			<ThemeProvider theme={theme}>
				<CommandHistoryDrawer isOpen history={[]} onClose={onClose} onSelectCommand={vi.fn()} />
			</ThemeProvider>
		);

		expect(screen.getByText('Command History')).toBeInTheDocument();
		expect(screen.getByText('No command history yet')).toBeInTheDocument();
		fireEvent.click(screen.getByLabelText('Close command history drawer'));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('selects commands and clears history through the themed drawer', () => {
		const onClose = vi.fn();
		const onClearHistory = vi.fn();
		const onDeleteCommand = vi.fn();
		const onSelectCommand = vi.fn();
		renderDrawer({
			history: [
				createEntry({ command: 'git status', id: 'terminal-1', mode: 'terminal' }),
				createEntry({ command: 'Explain the failing integration test', id: 'ai-1', mode: 'ai' }),
			],
			onClearHistory,
			onClose,
			onDeleteCommand,
			onSelectCommand,
		});

		expect(screen.getByText('Swipe left on an item to delete')).toBeInTheDocument();
		fireEvent.click(screen.getByText('git status'));
		expect(navigator.vibrate).toHaveBeenCalledWith(10);
		expect(onSelectCommand).toHaveBeenCalledWith('git status');
		expect(onClose).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByText('Clear All'));
		expect(navigator.vibrate).toHaveBeenCalledWith([50, 30, 50]);
		expect(onClearHistory).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalledTimes(2);
	});

	it('reveals and runs delete from the real swipe gesture path', async () => {
		const onDeleteCommand = vi.fn();
		renderDrawer({
			history: [createEntry({ command: 'npm run integration', id: 'delete-me' })],
			onDeleteCommand,
		});

		const commandButton = screen.getByText('npm run integration').closest('button');
		expect(commandButton).not.toBeNull();
		fireEvent.touchStart(commandButton!, {
			touches: [{ clientX: 220, clientY: 20 }],
		});
		fireEvent.touchMove(commandButton!, {
			touches: [{ clientX: 80, clientY: 24 }],
		});
		fireEvent.touchEnd(commandButton!, {
			changedTouches: [{ clientX: 80, clientY: 24 }],
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 60));
		});

		expect(navigator.vibrate).toHaveBeenCalledWith(10);
		fireEvent.click(screen.getByLabelText('Delete command'));
		expect(navigator.vibrate).toHaveBeenCalledWith([10, 50, 20]);
		expect(onDeleteCommand).toHaveBeenCalledWith('delete-me');
	});

	it('dismisses revealed delete actions, handles touch cancel, and resets with swipe right', async () => {
		const onDeleteCommand = vi.fn();
		const onSelectCommand = vi.fn();
		renderDrawer({
			history: [createEntry({ command: 'npm run integration', id: 'swipe-reset' })],
			onDeleteCommand,
			onSelectCommand,
		});

		const commandButton = screen.getByText('npm run integration').closest('button');
		expect(commandButton).not.toBeNull();

		fireEvent.touchStart(commandButton!, {
			touches: [{ clientX: 220, clientY: 20 }],
		});
		fireEvent.touchMove(commandButton!, {
			touches: [{ clientX: 80, clientY: 24 }],
		});
		fireEvent.touchEnd(commandButton!, {
			changedTouches: [{ clientX: 80, clientY: 24 }],
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 60));
		});

		fireEvent.click(commandButton!);
		expect(onSelectCommand).not.toHaveBeenCalled();

		fireEvent.touchStart(commandButton!, {
			touches: [{ clientX: 80, clientY: 24 }],
		});
		fireEvent.touchMove(commandButton!, {
			touches: [{ clientX: 220, clientY: 20 }],
		});
		fireEvent.touchCancel(commandButton!, {
			changedTouches: [{ clientX: 220, clientY: 20 }],
		});
		fireEvent.touchStart(commandButton!, {
			touches: [{ clientX: 80, clientY: 24 }],
		});
		fireEvent.touchMove(commandButton!, {
			touches: [{ clientX: 220, clientY: 20 }],
		});
		fireEvent.touchEnd(commandButton!, {
			changedTouches: [{ clientX: 220, clientY: 20 }],
		});

		fireEvent.click(commandButton!);
		expect(onSelectCommand).toHaveBeenCalledWith('npm run integration');
		expect(onDeleteCommand).not.toHaveBeenCalled();
	});

	it('closes from drawer handle drag gestures and responds to viewport resize', () => {
		const onClose = vi.fn();
		const { container } = renderDrawer({
			history: [createEntry({ command: 'drag drawer closed', id: 'drag-close' })],
			onClose,
		});

		Object.defineProperty(window, 'innerHeight', {
			configurable: true,
			value: 900,
		});
		fireEvent(window, new Event('resize'));

		const handle = Array.from(container.querySelectorAll('div')).find((element) =>
			element.getAttribute('style')?.includes('cursor: grab')
		);
		expect(handle).toBeDefined();

		fireEvent.touchMove(handle!, {
			touches: [{ clientY: 50 }],
		});
		fireEvent.touchEnd(handle!);
		expect(onClose).not.toHaveBeenCalled();

		act(() => {
			fireEvent.touchStart(handle!, {
				touches: [{ clientY: 10 }],
			});
			fireEvent.touchMove(handle!, {
				touches: [{ clientY: 260 }],
			});
		});
		act(() => {
			fireEvent.touchEnd(handle!);
		});

		expect(onClose).toHaveBeenCalledTimes(1);
		expect(navigator.vibrate).toHaveBeenCalledWith(10);
	});

	it('snaps closed after a slow drag past the handle threshold', () => {
		const onClose = vi.fn();
		const { container } = renderDrawer({
			history: [createEntry({ command: 'slow drag drawer closed', id: 'slow-drag-close' })],
			onClose,
		});
		Object.defineProperty(window, 'innerHeight', {
			configurable: true,
			value: 900,
		});
		fireEvent(window, new Event('resize'));

		const handle = Array.from(container.querySelectorAll('div')).find((element) =>
			element.getAttribute('style')?.includes('cursor: grab')
		);
		expect(handle).toBeDefined();

		let now = 0;
		vi.mocked(Date.now).mockImplementation(() => now);
		act(() => {
			fireEvent.touchStart(handle!, {
				touches: [{ clientY: 10 }],
			});
		});
		act(() => {
			fireEvent.touchMove(handle!, {
				touches: [{ clientY: 260 }],
			});
		});
		now = 1000;
		act(() => {
			fireEvent.touchEnd(handle!);
		});

		expect(onClose).toHaveBeenCalledTimes(1);
		expect(navigator.vibrate).toHaveBeenCalledWith(10);
	});

	it('marks an item as long-pressed after the gesture threshold', () => {
		vi.useFakeTimers();
		renderDrawer({
			history: [createEntry({ command: 'delete after long press', id: 'long-press' })],
			onDeleteCommand: vi.fn(),
		});

		const commandButton = screen.getByText('delete after long press').closest('button');
		expect(commandButton).not.toBeNull();

		fireEvent.touchStart(commandButton!, {
			touches: [{ clientX: 100, clientY: 20 }],
		});
		act(() => {
			vi.advanceTimersByTime(500);
		});

		expect(navigator.vibrate).toHaveBeenCalledWith([10, 50, 20]);
		fireEvent.touchEnd(commandButton!, {
			changedTouches: [{ clientX: 100, clientY: 20 }],
		});
	});
});

function renderDrawer(props: Partial<React.ComponentProps<typeof CommandHistoryDrawer>> = {}) {
	return render(
		<ThemeProvider theme={theme}>
			<CommandHistoryDrawer
				isOpen
				history={[]}
				onClose={vi.fn()}
				onSelectCommand={vi.fn()}
				{...props}
			/>
		</ThemeProvider>
	);
}

function createEntry(overrides: Partial<CommandHistoryEntry> = {}): CommandHistoryEntry {
	return {
		command: 'queued command',
		id: 'entry-1',
		mode: 'terminal',
		sessionId: 'session-1',
		timestamp: Date.now() - 60_000,
		...overrides,
	};
}
