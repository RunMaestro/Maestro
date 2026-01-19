/**
 * LogViewer.tsx Test Suite
 *
 * Tests for the LogViewer component which displays Maestro system logs with:
 * - Log level filtering (debug, info, warn, error, toast)
 * - Search functionality
 * - Expand/collapse log details
 * - Export and clear logs
 * - Visual timeline
 * - Layer stack integration
 * - Keyboard navigation
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LogViewer } from '../../../renderer/components/LogViewer';
import type { Theme } from '../../../renderer/types';

// Mock theme
const mockTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#44475a',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		border: '#44475a',
		error: '#ff5555',
		warning: '#ffb86c',
		success: '#50fa7b',
		syntaxComment: '#6272a4',
		syntaxKeyword: '#ff79c6',
	},
};

// Mock log entries
const createMockLog = (
	overrides: Partial<{
		timestamp: number;
		level: 'debug' | 'info' | 'warn' | 'error' | 'toast' | 'autorun';
		message: string;
		context?: string;
		data?: unknown;
	}> = {}
) => ({
	timestamp: Date.now(),
	level: 'info' as const,
	message: 'Test log message',
	...overrides,
});

// Mock layer stack context
const mockRegisterLayer = vi.fn().mockReturnValue('mock-layer-id');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: mockUpdateLayerHandler,
	}),
}));

// Mock ConfirmModal
vi.mock('../../../renderer/components/ConfirmModal', () => ({
	ConfirmModal: ({
		message,
		onConfirm,
		onClose,
	}: {
		message: string;
		onConfirm: () => void;
		onClose: () => void;
	}) => (
		<div data-testid="confirm-modal">
			<p>{message}</p>
			<button onClick={onConfirm}>Confirm</button>
			<button onClick={onClose}>Cancel</button>
		</div>
	),
}));

// Add getLogs, clearLogs, and onNewLog to the existing window.maestro.logger mock
beforeEach(() => {
	vi.clearAllMocks();

	// Extend window.maestro.logger with getLogs, clearLogs, and onNewLog methods
	(window.maestro.logger as Record<string, unknown>).getLogs = vi.fn().mockResolvedValue([]);
	(window.maestro.logger as Record<string, unknown>).clearLogs = vi
		.fn()
		.mockResolvedValue(undefined);
	(window.maestro.logger as Record<string, unknown>).onNewLog = vi.fn().mockReturnValue(() => {});
	(window.maestro.logger as Record<string, unknown>).getMaxLogBuffer = vi.fn(() => ({
		then: (cb: (value: number) => void) => {
			cb(1000);
			return Promise.resolve(1000);
		},
	}));
});

afterEach(() => {
	vi.clearAllMocks();
});

// Helper to get the mock functions
const getMockGetLogs = () => window.maestro.logger.getLogs as ReturnType<typeof vi.fn>;
const getMockClearLogs = () => window.maestro.logger.clearLogs as ReturnType<typeof vi.fn>;

describe('LogViewer', () => {
	describe('Initial render', () => {
		it('should render with dialog role and aria attributes', async () => {
			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toBeInTheDocument();
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'System Log Viewer');
		});

		it('should render header with title', async () => {
			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			expect(screen.getByText('Maestro System Logs')).toBeInTheDocument();
		});

		it('should display entry count', async () => {
			getMockGetLogs().mockResolvedValue([
				createMockLog({ message: 'Log 1' }),
				createMockLog({ message: 'Log 2' }),
			]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('2 entries')).toBeInTheDocument();
			});
		});

		it('should display "entry" for single log', async () => {
			getMockGetLogs().mockResolvedValue([createMockLog({ message: 'Single log' })]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('1 entry')).toBeInTheDocument();
			});
		});

		it('should load logs on mount', async () => {
			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(getMockGetLogs()).toHaveBeenCalled();
			});
		});

		it('should display empty state when no logs', async () => {
			getMockGetLogs().mockResolvedValue([]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('No logs yet')).toBeInTheDocument();
			});
		});
	});

	describe('Layer stack integration', () => {
		it('should register layer on mount', async () => {
			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			expect(mockRegisterLayer).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'modal',
					blocksLowerLayers: true,
					capturesFocus: true,
					focusTrap: 'lenient',
					ariaLabel: 'System Log Viewer',
				})
			);
		});

		it('should unregister layer on unmount', async () => {
			const { unmount } = render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			unmount();

			expect(mockUnregisterLayer).toHaveBeenCalledWith('mock-layer-id');
		});

		it('should update layer handler when search state changes', async () => {
			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			// Open search
			fireEvent.keyDown(screen.getByRole('dialog'), { key: 'f', metaKey: true });

			await waitFor(() => {
				expect(mockUpdateLayerHandler).toHaveBeenCalled();
			});
		});
	});

	describe('Log level filtering', () => {
		beforeEach(() => {
			getMockGetLogs().mockResolvedValue([
				createMockLog({ level: 'debug', message: 'Debug message' }),
				createMockLog({ level: 'info', message: 'Info message' }),
				createMockLog({ level: 'warn', message: 'Warning message' }),
				createMockLog({ level: 'error', message: 'Error message' }),
				createMockLog({ level: 'toast', message: 'Toast message' }),
			]);
		});

		it('should render all filter buttons', async () => {
			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByRole('button', { name: 'ALL' })).toBeInTheDocument();
				expect(screen.getByRole('button', { name: 'DEBUG' })).toBeInTheDocument();
				expect(screen.getByRole('button', { name: 'INFO' })).toBeInTheDocument();
				expect(screen.getByRole('button', { name: 'WARN' })).toBeInTheDocument();
				expect(screen.getByRole('button', { name: 'ERROR' })).toBeInTheDocument();
				expect(screen.getByRole('button', { name: 'TOAST' })).toBeInTheDocument();
			});
		});

		it('should filter logs by level when toggle clicked', async () => {
			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Info message')).toBeInTheDocument();
			});

			// Click INFO to disable it
			const infoButton = screen.getByRole('button', { name: 'INFO' });
			fireEvent.click(infoButton);

			await waitFor(() => {
				expect(screen.queryByText('Info message')).not.toBeInTheDocument();
			});
		});

		it('should toggle filter back on when clicked again', async () => {
			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Info message')).toBeInTheDocument();
			});

			const infoButton = screen.getByRole('button', { name: 'INFO' });

			// Click to disable
			fireEvent.click(infoButton);
			await waitFor(() => {
				expect(screen.queryByText('Info message')).not.toBeInTheDocument();
			});

			// Click to enable
			fireEvent.click(infoButton);
			await waitFor(() => {
				expect(screen.getByText('Info message')).toBeInTheDocument();
			});
		});

		it('should toggle all levels with ALL button', async () => {
			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Info message')).toBeInTheDocument();
			});

			const allButton = screen.getByRole('button', { name: 'ALL' });

			// Click ALL to turn off all enabled levels
			fireEvent.click(allButton);

			await waitFor(() => {
				expect(screen.queryByText('Info message')).not.toBeInTheDocument();
				expect(screen.queryByText('Warning message')).not.toBeInTheDocument();
				expect(screen.queryByText('Error message')).not.toBeInTheDocument();
			});
		});

		it('should disable debug level when logLevel is info', async () => {
			render(<LogViewer theme={mockTheme} onClose={vi.fn()} logLevel="info" />);

			await waitFor(() => {
				const debugButton = screen.getByRole('button', { name: 'DEBUG' });
				expect(debugButton).toBeDisabled();
			});
		});

		it('should disable debug and info levels when logLevel is warn', async () => {
			render(<LogViewer theme={mockTheme} onClose={vi.fn()} logLevel="warn" />);

			await waitFor(() => {
				expect(screen.getByRole('button', { name: 'DEBUG' })).toBeDisabled();
				expect(screen.getByRole('button', { name: 'INFO' })).toBeDisabled();
				expect(screen.getByRole('button', { name: 'WARN' })).not.toBeDisabled();
				expect(screen.getByRole('button', { name: 'ERROR' })).not.toBeDisabled();
			});
		});

		it('should always enable toast level', async () => {
			render(<LogViewer theme={mockTheme} onClose={vi.fn()} logLevel="error" />);

			await waitFor(() => {
				expect(screen.getByRole('button', { name: 'TOAST' })).not.toBeDisabled();
			});
		});

		it('should persist level selections via callback', async () => {
			const onSelectedLevelsChange = vi.fn();

			render(
				<LogViewer
					theme={mockTheme}
					onClose={vi.fn()}
					onSelectedLevelsChange={onSelectedLevelsChange}
				/>
			);

			await waitFor(() => {
				expect(screen.getByRole('button', { name: 'INFO' })).toBeInTheDocument();
			});

			fireEvent.click(screen.getByRole('button', { name: 'INFO' }));

			expect(onSelectedLevelsChange).toHaveBeenCalled();
		});

		it('should initialize with saved level selections', async () => {
			getMockGetLogs().mockResolvedValue([
				createMockLog({ level: 'info', message: 'Info message' }),
				createMockLog({ level: 'warn', message: 'Warning message' }),
			]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} savedSelectedLevels={['warn']} />);

			await waitFor(() => {
				// Only warn should be visible
				expect(screen.queryByText('Info message')).not.toBeInTheDocument();
				expect(screen.getByText('Warning message')).toBeInTheDocument();
			});
		});
	});

	describe('Search functionality', () => {
		beforeEach(() => {
			getMockGetLogs().mockResolvedValue([
				createMockLog({ message: 'Alpha message', context: 'ModuleA' }),
				createMockLog({ message: 'Beta message', context: 'ModuleB' }),
				createMockLog({ message: 'Gamma message', data: { key: 'searchable' } }),
			]);
		});

		it('should open search with Cmd+F', async () => {
			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			fireEvent.keyDown(screen.getByRole('dialog'), { key: 'f', metaKey: true });

			await waitFor(() => {
				expect(screen.getByPlaceholderText('Search logs...')).toBeInTheDocument();
			});
		});

		it('should filter logs by message content', async () => {
			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Alpha message')).toBeInTheDocument();
			});

			fireEvent.keyDown(screen.getByRole('dialog'), { key: 'f', metaKey: true });
			const searchInput = await screen.findByPlaceholderText('Search logs...');
			fireEvent.change(searchInput, { target: { value: 'Beta' } });

			await waitFor(() => {
				expect(screen.queryByText('Alpha message')).not.toBeInTheDocument();
				expect(screen.getByText('Beta message')).toBeInTheDocument();
			});
		});

		it('should filter logs by context', async () => {
			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Alpha message')).toBeInTheDocument();
			});

			fireEvent.keyDown(screen.getByRole('dialog'), { key: 'f', metaKey: true });
			const searchInput = await screen.findByPlaceholderText('Search logs...');
			fireEvent.change(searchInput, { target: { value: 'ModuleB' } });

			await waitFor(() => {
				expect(screen.queryByText('Alpha message')).not.toBeInTheDocument();
				expect(screen.getByText('Beta message')).toBeInTheDocument();
			});
		});

		it('should filter logs by data content', async () => {
			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Alpha message')).toBeInTheDocument();
			});

			fireEvent.keyDown(screen.getByRole('dialog'), { key: 'f', metaKey: true });
			const searchInput = await screen.findByPlaceholderText('Search logs...');
			fireEvent.change(searchInput, { target: { value: 'searchable' } });

			await waitFor(() => {
				expect(screen.queryByText('Alpha message')).not.toBeInTheDocument();
				expect(screen.getByText('Gamma message')).toBeInTheDocument();
			});
		});

		it('should close search and clear query with ESC button', async () => {
			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			fireEvent.keyDown(screen.getByRole('dialog'), { key: 'f', metaKey: true });
			const searchInput = await screen.findByPlaceholderText('Search logs...');
			fireEvent.change(searchInput, { target: { value: 'test' } });

			// Click ESC button
			fireEvent.click(screen.getByText('ESC'));

			await waitFor(() => {
				expect(screen.queryByPlaceholderText('Search logs...')).not.toBeInTheDocument();
			});
		});

		it('should be case-insensitive', async () => {
			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Alpha message')).toBeInTheDocument();
			});

			fireEvent.keyDown(screen.getByRole('dialog'), { key: 'f', metaKey: true });
			const searchInput = await screen.findByPlaceholderText('Search logs...');
			fireEvent.change(searchInput, { target: { value: 'ALPHA' } });

			await waitFor(() => {
				expect(screen.getByText('Alpha message')).toBeInTheDocument();
			});
		});

		it('should show filter empty state when search has no results', async () => {
			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Alpha message')).toBeInTheDocument();
			});

			fireEvent.keyDown(screen.getByRole('dialog'), { key: 'f', metaKey: true });
			const searchInput = await screen.findByPlaceholderText('Search logs...');
			fireEvent.change(searchInput, { target: { value: 'nonexistent' } });

			await waitFor(() => {
				expect(screen.getByText('No logs match your filter')).toBeInTheDocument();
			});
		});
	});

	describe('Expand/collapse data', () => {
		it('should show details toggle for logs with data', async () => {
			getMockGetLogs().mockResolvedValue([
				createMockLog({ message: 'Log with data', data: { key: 'value' } }),
			]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Show details')).toBeInTheDocument();
			});
		});

		it('should not show details toggle for logs without data', async () => {
			getMockGetLogs().mockResolvedValue([createMockLog({ message: 'Log without data' })]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Log without data')).toBeInTheDocument();
				expect(screen.queryByText('Show details')).not.toBeInTheDocument();
			});
		});

		it('should toggle details visibility on click', async () => {
			getMockGetLogs().mockResolvedValue([
				createMockLog({ message: 'Log with data', data: { testKey: 'testValue' } }),
			]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Show details')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByText('Show details'));

			await waitFor(() => {
				expect(screen.getByText('Hide details')).toBeInTheDocument();
				expect(screen.getByText(/"testKey": "testValue"/)).toBeInTheDocument();
			});
		});

		it('should collapse details on second click', async () => {
			getMockGetLogs().mockResolvedValue([
				createMockLog({ message: 'Log with data', data: { key: 'value' } }),
			]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Show details')).toBeInTheDocument();
			});

			// Expand
			fireEvent.click(screen.getByText('Show details'));
			await waitFor(() => {
				expect(screen.getByText('Hide details')).toBeInTheDocument();
			});

			// Collapse
			fireEvent.click(screen.getByText('Hide details'));
			await waitFor(() => {
				expect(screen.getByText('Show details')).toBeInTheDocument();
			});
		});

		it('should show expand all button when logs have data', async () => {
			getMockGetLogs().mockResolvedValue([
				createMockLog({ message: 'Log 1', data: { a: 1 } }),
				createMockLog({ message: 'Log 2', data: { b: 2 } }),
			]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByTitle('Expand all')).toBeInTheDocument();
				expect(screen.getByTitle('Collapse all')).toBeInTheDocument();
			});
		});

		it('should expand all logs with data when expand all clicked', async () => {
			getMockGetLogs().mockResolvedValue([
				createMockLog({ message: 'Log 1', data: { a: 1 } }),
				createMockLog({ message: 'Log 2', data: { b: 2 } }),
			]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByTitle('Expand all')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByTitle('Expand all'));

			await waitFor(() => {
				const hideButtons = screen.getAllByText('Hide details');
				expect(hideButtons).toHaveLength(2);
			});
		});

		it('should collapse all logs when collapse all clicked', async () => {
			getMockGetLogs().mockResolvedValue([
				createMockLog({ message: 'Log 1', data: { a: 1 } }),
				createMockLog({ message: 'Log 2', data: { b: 2 } }),
			]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			// Expand all first
			await waitFor(() => {
				expect(screen.getByTitle('Expand all')).toBeInTheDocument();
			});
			fireEvent.click(screen.getByTitle('Expand all'));

			await waitFor(() => {
				expect(screen.getAllByText('Hide details')).toHaveLength(2);
			});

			// Now collapse all
			fireEvent.click(screen.getByTitle('Collapse all'));

			await waitFor(() => {
				const showButtons = screen.getAllByText('Show details');
				expect(showButtons).toHaveLength(2);
			});
		});

		it('should not show expand/collapse buttons when no logs have data', async () => {
			getMockGetLogs().mockResolvedValue([createMockLog({ message: 'Log without data' })]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Log without data')).toBeInTheDocument();
				expect(screen.queryByTitle('Expand all')).not.toBeInTheDocument();
				expect(screen.queryByTitle('Collapse all')).not.toBeInTheDocument();
			});
		});
	});

	describe('Export logs', () => {
		it('should export logs when download button clicked', async () => {
			getMockGetLogs().mockResolvedValue([
				createMockLog({
					timestamp: new Date('2024-01-15T10:30:00').getTime(),
					level: 'info',
					message: 'Test message',
					context: 'TestModule',
					data: { key: 'value' },
				}),
			]);

			// Mock URL.createObjectURL and URL.revokeObjectURL
			const mockUrl = 'blob:test-url';
			const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue(mockUrl);
			const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

			// Mock anchor element
			const mockClick = vi.fn();
			const originalCreateElement = document.createElement.bind(document);
			vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
				if (tag === 'a') {
					return { click: mockClick, href: '', download: '' } as unknown as HTMLAnchorElement;
				}
				return originalCreateElement(tag);
			});

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByTitle('Export logs')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByTitle('Export logs'));

			expect(createObjectURLSpy).toHaveBeenCalled();
			expect(mockClick).toHaveBeenCalled();
			expect(revokeObjectURLSpy).toHaveBeenCalledWith(mockUrl);

			createObjectURLSpy.mockRestore();
			revokeObjectURLSpy.mockRestore();
		});
	});

	describe('Clear logs', () => {
		it('should show confirmation modal when clear clicked', async () => {
			getMockGetLogs().mockResolvedValue([createMockLog({ message: 'Test log' })]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByTitle('Clear logs')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByTitle('Clear logs'));

			expect(screen.getByTestId('confirm-modal')).toBeInTheDocument();
		});

		it('should clear logs when confirmed', async () => {
			getMockGetLogs().mockResolvedValue([createMockLog({ message: 'Test log' })]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByTitle('Clear logs')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByTitle('Clear logs'));
			fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

			expect(getMockClearLogs()).toHaveBeenCalled();
		});

		it('should close modal when cancelled', async () => {
			getMockGetLogs().mockResolvedValue([createMockLog({ message: 'Test log' })]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByTitle('Clear logs')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByTitle('Clear logs'));
			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

			expect(getMockClearLogs()).not.toHaveBeenCalled();
			await waitFor(() => {
				expect(screen.queryByTestId('confirm-modal')).not.toBeInTheDocument();
			});
		});
	});

	describe('Close functionality', () => {
		it('should call onClose when X button clicked', async () => {
			const onClose = vi.fn();

			render(<LogViewer theme={mockTheme} onClose={onClose} />);

			fireEvent.click(screen.getByTitle('Close log viewer'));

			expect(onClose).toHaveBeenCalled();
		});
	});

	describe('Keyboard navigation', () => {
		it('should scroll down with ArrowDown key', async () => {
			getMockGetLogs().mockResolvedValue([
				createMockLog({ message: 'Log 1' }),
				createMockLog({ message: 'Log 2' }),
			]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Log 1')).toBeInTheDocument();
			});

			const scrollBySpy = vi.fn();
			const container = screen.getByRole('dialog').querySelector('.overflow-y-auto');
			if (container) {
				container.scrollBy = scrollBySpy;
			}

			fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowDown' });

			expect(scrollBySpy).toHaveBeenCalledWith({ top: 100, behavior: 'smooth' });
		});

		it('should scroll up with ArrowUp key', async () => {
			getMockGetLogs().mockResolvedValue([createMockLog({ message: 'Log 1' })]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Log 1')).toBeInTheDocument();
			});

			const scrollBySpy = vi.fn();
			const container = screen.getByRole('dialog').querySelector('.overflow-y-auto');
			if (container) {
				container.scrollBy = scrollBySpy;
			}

			fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowUp' });

			expect(scrollBySpy).toHaveBeenCalledWith({ top: -100, behavior: 'smooth' });
		});

		it('should jump to top with Cmd+ArrowUp', async () => {
			getMockGetLogs().mockResolvedValue([createMockLog({ message: 'Log 1' })]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Log 1')).toBeInTheDocument();
			});

			const scrollToSpy = vi.fn();
			const container = screen.getByRole('dialog').querySelector('.overflow-y-auto');
			if (container) {
				container.scrollTo = scrollToSpy;
			}

			fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowUp', metaKey: true });

			expect(scrollToSpy).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
		});

		it('should jump to bottom with Cmd+ArrowDown', async () => {
			getMockGetLogs().mockResolvedValue([createMockLog({ message: 'Log 1' })]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Log 1')).toBeInTheDocument();
			});

			const scrollToSpy = vi.fn();
			const container = screen.getByRole('dialog').querySelector('.overflow-y-auto');
			if (container) {
				container.scrollTo = scrollToSpy;
				Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true });
			}

			fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowDown', metaKey: true });

			expect(scrollToSpy).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));
		});

		it('should page up with Alt+ArrowUp', async () => {
			getMockGetLogs().mockResolvedValue([createMockLog({ message: 'Log 1' })]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Log 1')).toBeInTheDocument();
			});

			const scrollBySpy = vi.fn();
			const container = screen.getByRole('dialog').querySelector('.overflow-y-auto');
			if (container) {
				container.scrollBy = scrollBySpy;
				Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true });
			}

			fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowUp', altKey: true });

			expect(scrollBySpy).toHaveBeenCalledWith({ top: -400, behavior: 'smooth' });
		});

		it('should page down with Alt+ArrowDown', async () => {
			getMockGetLogs().mockResolvedValue([createMockLog({ message: 'Log 1' })]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Log 1')).toBeInTheDocument();
			});

			const scrollBySpy = vi.fn();
			const container = screen.getByRole('dialog').querySelector('.overflow-y-auto');
			if (container) {
				container.scrollBy = scrollBySpy;
				Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true });
			}

			fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowDown', altKey: true });

			expect(scrollBySpy).toHaveBeenCalledWith({ top: 400, behavior: 'smooth' });
		});

		it('should not scroll when search is open', async () => {
			getMockGetLogs().mockResolvedValue([createMockLog({ message: 'Log 1' })]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Log 1')).toBeInTheDocument();
			});

			// Open search
			fireEvent.keyDown(screen.getByRole('dialog'), { key: 'f', metaKey: true });
			await screen.findByPlaceholderText('Search logs...');

			const scrollBySpy = vi.fn();
			const container = screen.getByRole('dialog').querySelector('.overflow-y-auto');
			if (container) {
				container.scrollBy = scrollBySpy;
			}

			fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowDown' });

			// Should not scroll because search is open
			expect(scrollBySpy).not.toHaveBeenCalled();
		});
	});

	describe('Visual timeline', () => {
		it('should render timeline bar for each log', async () => {
			getMockGetLogs().mockResolvedValue([
				createMockLog({ level: 'info', message: 'Log 1' }),
				createMockLog({ level: 'error', message: 'Log 2' }),
				createMockLog({ level: 'warn', message: 'Log 3' }),
			]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				// Timeline container should exist
				const timeline = screen.getByRole('dialog').querySelector('.h-2.w-full');
				expect(timeline).toBeInTheDocument();
				expect(timeline?.children).toHaveLength(3);
			});
		});

		it('should scroll to log when timeline segment clicked', async () => {
			getMockGetLogs().mockResolvedValue([
				createMockLog({ level: 'info', message: 'Log 1' }),
				createMockLog({ level: 'error', message: 'Log 2' }),
			]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Log 1')).toBeInTheDocument();
			});

			const scrollToSpy = vi.fn();
			const container = screen.getByRole('dialog').querySelector('.overflow-y-auto');
			if (container) {
				container.scrollTo = scrollToSpy;
				Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true });
				Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true });
			}

			const timeline = screen.getByRole('dialog').querySelector('.h-2.w-full');
			const secondSegment = timeline?.children[1] as HTMLElement;
			if (secondSegment) {
				fireEvent.click(secondSegment);
			}

			expect(scrollToSpy).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));
		});
	});

	describe('Log level colors', () => {
		it('should use correct color for debug level', async () => {
			getMockGetLogs().mockResolvedValue([createMockLog({ level: 'debug', message: 'Debug' })]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} logLevel="debug" />);

			await waitFor(() => {
				const levelPill = screen.getByText('debug');
				expect(levelPill).toHaveStyle({ color: '#6366f1' });
			});
		});

		it('should use correct color for info level', async () => {
			getMockGetLogs().mockResolvedValue([createMockLog({ level: 'info', message: 'Info' })]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				const levelPill = screen.getByText('info');
				expect(levelPill).toHaveStyle({ color: '#3b82f6' });
			});
		});

		it('should use correct color for warn level', async () => {
			getMockGetLogs().mockResolvedValue([createMockLog({ level: 'warn', message: 'Warn' })]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				const levelPill = screen.getByText('warn');
				expect(levelPill).toHaveStyle({ color: '#f59e0b' });
			});
		});

		it('should use correct color for error level', async () => {
			getMockGetLogs().mockResolvedValue([createMockLog({ level: 'error', message: 'Error' })]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				const levelPill = screen.getByText('error');
				expect(levelPill).toHaveStyle({ color: '#ef4444' });
			});
		});

		it('should use correct color for toast level', async () => {
			getMockGetLogs().mockResolvedValue([createMockLog({ level: 'toast', message: 'Toast' })]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				const levelPill = screen.getByText('toast');
				expect(levelPill).toHaveStyle({ color: '#a855f7' });
			});
		});
	});

	describe('Log entry display', () => {
		it('should display timestamp', async () => {
			const timestamp = new Date('2024-01-15T14:30:45').getTime();
			getMockGetLogs().mockResolvedValue([createMockLog({ timestamp, message: 'Test' })]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				// Should show localized time
				expect(screen.getByText(/\d{1,2}:\d{2}:\d{2}/)).toBeInTheDocument();
			});
		});

		it('should display context badge when present', async () => {
			getMockGetLogs().mockResolvedValue([
				createMockLog({ message: 'Test', context: 'TestModule' }),
			]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('TestModule')).toBeInTheDocument();
			});
		});

		it('should not show context badge when context is empty', async () => {
			getMockGetLogs().mockResolvedValue([createMockLog({ message: 'Test' })]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Test')).toBeInTheDocument();
				// No context span should be rendered when context is empty
				// The log entry should not have a span with accent color for context
				const dialog = screen.getByRole('dialog');
				// Check that there's no TestModule or other context text
				expect(screen.queryByText('TestModule')).not.toBeInTheDocument();
			});
		});

		it('should display agent pill for toast entries with project in data', async () => {
			getMockGetLogs().mockResolvedValue([
				createMockLog({
					level: 'toast',
					message: 'Toast message',
					data: { project: 'Test Agent', type: 'success' },
				}),
			]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Test Agent')).toBeInTheDocument();
			});
		});

		it('should display agent pill for autorun entries with context', async () => {
			getMockGetLogs().mockResolvedValue([
				createMockLog({
					level: 'autorun',
					message: 'Auto run started',
					context: 'My Session',
				}),
			]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('My Session')).toBeInTheDocument();
			});
		});

		it('should not show agent pill for toast entries without project', async () => {
			getMockGetLogs().mockResolvedValue([
				createMockLog({
					level: 'toast',
					message: 'Toast message',
					data: { type: 'info' }, // No project field
				}),
			]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Toast message')).toBeInTheDocument();
				// Should not have any agent pill text
				expect(screen.queryByText('Test Agent')).not.toBeInTheDocument();
			});
		});

		it('should not show context badge for toast entries', async () => {
			getMockGetLogs().mockResolvedValue([
				createMockLog({
					level: 'toast',
					message: 'Test notification',
					context: 'Toast',
					data: { project: 'Agent Name' },
				}),
			]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				// Should show the agent name from data.project
				expect(screen.getByText('Agent Name')).toBeInTheDocument();
				// The context "Toast" should not be shown as a separate badge for toast entries
				// The level pill shows "toast" (lowercase), and context "Toast" (capitalized)
				// should not appear as a separate context badge
				const toastLevelPill = screen.getByText('toast');
				expect(toastLevelPill).toBeInTheDocument();
				// Make sure there's no separate "Toast" context badge (distinct from the level pill)
				const allTextElements = screen.queryAllByText('Toast');
				// Should be 0 - the context "Toast" is not displayed for toast level entries
				expect(allTextElements.length).toBe(0);
			});
		});
	});

	describe('Footer', () => {
		it('should show search hint when search is closed', async () => {
			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText(/Press/)).toBeInTheDocument();
				expect(screen.getByText('⌘F')).toBeInTheDocument();
				expect(screen.getByText(/to search/)).toBeInTheDocument();
			});
		});

		it('should hide search hint when search is open', async () => {
			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			fireEvent.keyDown(screen.getByRole('dialog'), { key: 'f', metaKey: true });

			await waitFor(() => {
				expect(screen.queryByText(/Press.*to search/)).not.toBeInTheDocument();
			});
		});
	});

	describe('Error handling', () => {
		it('should handle getLogs failure gracefully', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			getMockGetLogs().mockRejectedValue(new Error('Failed to load'));

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(consoleError).toHaveBeenCalledWith('Failed to load logs:', expect.any(Error));
			});

			consoleError.mockRestore();
		});

		it('should handle clearLogs failure gracefully', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			getMockGetLogs().mockResolvedValue([createMockLog({ message: 'Test' })]);
			getMockClearLogs().mockRejectedValue(new Error('Failed to clear'));

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByTitle('Clear logs')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByTitle('Clear logs'));
			fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

			await waitFor(() => {
				expect(consoleError).toHaveBeenCalledWith('Failed to clear logs:', expect.any(Error));
			});

			consoleError.mockRestore();
		});

		it('should handle circular references in data during search', async () => {
			// Create a log with data that might cause JSON.stringify to fail
			const circularData = { a: 1 };
			(circularData as unknown as { self: unknown }).self = circularData;

			getMockGetLogs().mockResolvedValue([createMockLog({ message: 'Test', data: circularData })]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Test')).toBeInTheDocument();
			});

			// Search should not crash with circular data
			fireEvent.keyDown(screen.getByRole('dialog'), { key: 'f', metaKey: true });
			const searchInput = await screen.findByPlaceholderText('Search logs...');
			fireEvent.change(searchInput, { target: { value: 'searchterm' } });

			// Should gracefully handle the error and not find anything
			await waitFor(() => {
				expect(screen.queryByText('Test')).not.toBeInTheDocument();
			});
		});
	});

	describe('Edge cases', () => {
		it('should handle XSS-like content in messages', async () => {
			getMockGetLogs().mockResolvedValue([
				createMockLog({ message: '<script>alert("xss")</script>' }),
			]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('<script>alert("xss")</script>')).toBeInTheDocument();
			});
		});

		it('should handle unicode in messages', async () => {
			getMockGetLogs().mockResolvedValue([
				createMockLog({ message: 'Unicode: 🎵 日本語 العربية' }),
			]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Unicode: 🎵 日本語 العربية')).toBeInTheDocument();
			});
		});

		it('should handle very long messages', async () => {
			const longMessage = 'A'.repeat(5000);
			getMockGetLogs().mockResolvedValue([createMockLog({ message: longMessage })]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText(longMessage)).toBeInTheDocument();
			});
		});

		it('should handle rapid filter toggles', async () => {
			getMockGetLogs().mockResolvedValue([
				createMockLog({ level: 'info', message: 'Info' }),
				createMockLog({ level: 'warn', message: 'Warn' }),
			]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Info')).toBeInTheDocument();
			});

			const infoButton = screen.getByRole('button', { name: 'INFO' });

			// Rapid toggles
			fireEvent.click(infoButton);
			fireEvent.click(infoButton);
			fireEvent.click(infoButton);

			// Should be stable
			await waitFor(() => {
				expect(screen.queryByText('Info')).not.toBeInTheDocument();
			});
		});

		it('should handle empty message', async () => {
			getMockGetLogs().mockResolvedValue([createMockLog({ message: '' })]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				// Log entry should still render
				expect(screen.getByText('info')).toBeInTheDocument();
			});
		});

		it('should handle epoch timestamp', async () => {
			getMockGetLogs().mockResolvedValue([createMockLog({ timestamp: 0, message: 'Epoch' })]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Epoch')).toBeInTheDocument();
			});
		});
	});

	describe('ALL button toggle on/off', () => {
		it('should re-enable all levels when ALL button is clicked after disabling', async () => {
			getMockGetLogs().mockResolvedValue([
				createMockLog({ level: 'info', message: 'Info message' }),
				createMockLog({ level: 'warn', message: 'Warning message' }),
				createMockLog({ level: 'error', message: 'Error message' }),
			]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Info message')).toBeInTheDocument();
			});

			const allButton = screen.getByRole('button', { name: 'ALL' });

			// Click ALL to turn off all enabled levels
			fireEvent.click(allButton);

			await waitFor(() => {
				expect(screen.queryByText('Info message')).not.toBeInTheDocument();
				expect(screen.queryByText('Warning message')).not.toBeInTheDocument();
				expect(screen.queryByText('Error message')).not.toBeInTheDocument();
			});

			// Click ALL again to turn on all enabled levels (tests lines 412-415)
			fireEvent.click(allButton);

			await waitFor(() => {
				expect(screen.getByText('Info message')).toBeInTheDocument();
				expect(screen.getByText('Warning message')).toBeInTheDocument();
				expect(screen.getByText('Error message')).toBeInTheDocument();
			});
		});
	});

	describe('expandableIndices with data attribute', () => {
		it('should identify logs with data as expandable', async () => {
			getMockGetLogs().mockResolvedValue([
				createMockLog({ message: 'Log without data' }),
				createMockLog({ message: 'Log with data', data: { key: 'value' } }),
				createMockLog({ message: 'Another without data' }),
			]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Log without data')).toBeInTheDocument();
				expect(screen.getByText('Log with data')).toBeInTheDocument();
			});

			// The expand all button should be available since there's at least one expandable log (lowercase title)
			const expandAllButton = screen.getByTitle('Expand all');
			expect(expandAllButton).toBeInTheDocument();

			// Click expand all to trigger expandableIndices usage
			fireEvent.click(expandAllButton);

			// The log with data should now be expanded
			await waitFor(() => {
				expect(screen.getByText(/"key":/)).toBeInTheDocument();
			});
		});

		it('should filter out logs without data in expandableIndices', async () => {
			getMockGetLogs().mockResolvedValue([
				createMockLog({ message: 'No data 1' }),
				createMockLog({ message: 'No data 2' }),
				createMockLog({ message: 'Has data', data: { foo: 'bar' } }),
			]);

			render(<LogViewer theme={mockTheme} onClose={vi.fn()} />);

			await waitFor(() => {
				expect(screen.getByText('Has data')).toBeInTheDocument();
			});

			// Expand all and verify only the one with data shows expanded content (lowercase title)
			const expandAllButton = screen.getByTitle('Expand all');
			fireEvent.click(expandAllButton);

			await waitFor(() => {
				// Only the log with data should show expanded JSON content
				expect(screen.getByText(/"foo":/)).toBeInTheDocument();
			});
		});
	});
});
