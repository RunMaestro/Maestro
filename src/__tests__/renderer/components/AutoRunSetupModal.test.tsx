/**
 * Tests for AutoRunSetupModal component
 *
 * AutoRunSetupModal is a modal dialog for setting up Auto Run:
 * - Allows user to select a folder for Auto Run documents
 * - Validates folder and counts markdown files
 * - Supports tilde (~) expansion for home directory paths
 * - Registers with layer stack for modal management
 * - Provides keyboard shortcuts (Cmd+O, Enter)
 * - Debounces folder validation (300ms)
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AutoRunSetupModal } from '../../../renderer/components/AutoRunSetupModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../renderer/types';

// Mock lucide-react
vi.mock('lucide-react', () => ({
	X: () => <svg data-testid="x-icon" />,
	Folder: () => <svg data-testid="folder-icon" />,
	FileText: () => <svg data-testid="file-text-icon" />,
	Play: () => <svg data-testid="play-icon" />,
	CheckSquare: () => <svg data-testid="check-square-icon" />,
}));

// Create a test theme
const createTestTheme = (overrides: Partial<Theme['colors']> = {}): Theme => ({
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
		info: '#3794ff',
		textInverse: '#000000',
		...overrides,
	},
});

// Helper to render with LayerStackProvider
const renderWithLayerStack = (ui: React.ReactElement) => {
	return render(<LayerStackProvider>{ui}</LayerStackProvider>);
};

describe('AutoRunSetupModal', () => {
	let theme: Theme;

	beforeEach(() => {
		theme = createTestTheme();
		vi.clearAllMocks();
		vi.useFakeTimers();

		// Reset mocks to default behavior
		vi.mocked(window.maestro.fs.homeDir).mockResolvedValue('/home/testuser');
		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({ success: true, files: [] });
		vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue(null);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe('rendering', () => {
		it('renders modal with correct structure', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByRole('dialog')).toBeInTheDocument();
			expect(screen.getByText('Change Auto Run Folder')).toBeInTheDocument();
		});

		it('renders with correct ARIA attributes', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'Change Auto Run Folder');
		});

		it('renders close button with X icon', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByTestId('x-icon')).toBeInTheDocument();
		});

		it('renders feature explanation section', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(
				screen.getByText(/Auto Run lets you manage and execute Markdown documents/)
			).toBeInTheDocument();
			expect(screen.getByText('Markdown Documents')).toBeInTheDocument();
			expect(screen.getByText('Checkbox Tasks')).toBeInTheDocument();
			expect(screen.getByText('Batch Execution')).toBeInTheDocument();
		});

		it('renders feature icons', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByTestId('file-text-icon')).toBeInTheDocument();
			expect(screen.getByTestId('check-square-icon')).toBeInTheDocument();
			expect(screen.getByTestId('play-icon')).toBeInTheDocument();
		});

		it('renders folder input and browse button', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByPlaceholderText(/Select Auto Run folder/)).toBeInTheDocument();
			expect(screen.getByTestId('folder-icon')).toBeInTheDocument();
		});

		it('renders Cancel and Continue buttons', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
		});

		it('includes sessionName in placeholder when provided', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			renderWithLayerStack(
				<AutoRunSetupModal
					theme={theme}
					onClose={onClose}
					onFolderSelected={onFolderSelected}
					sessionName="My Agent"
				/>
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(
				screen.getByPlaceholderText('Select Auto Run folder for My Agent')
			).toBeInTheDocument();
		});

		it('applies theme colors to modal container', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			const { container } = renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// Modal uses inline width style instead of Tailwind class
			const modalContent = container.querySelector('[style*="width: 520px"]');
			expect(modalContent).toHaveStyle({ backgroundColor: theme.colors.bgSidebar });
		});
	});

	describe('folder input', () => {
		it('initializes with currentFolder value', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			renderWithLayerStack(
				<AutoRunSetupModal
					theme={theme}
					onClose={onClose}
					onFolderSelected={onFolderSelected}
					currentFolder="/existing/path"
				/>
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const input = screen.getByPlaceholderText(/Select Auto Run folder/);
			expect(input).toHaveValue('/existing/path');
		});

		it('updates selectedFolder on input change', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const input = screen.getByPlaceholderText(/Select Auto Run folder/);
			fireEvent.change(input, { target: { value: '/new/path' } });

			expect(input).toHaveValue('/new/path');
		});
	});

	describe('folder validation', () => {
		it('shows "Checking folder..." during validation', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			// Make listDocs take time
			vi.mocked(window.maestro.autorun.listDocs).mockImplementation(
				() => new Promise((resolve) => setTimeout(() => resolve({ success: true, files: [] }), 500))
			);

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const input = screen.getByPlaceholderText(/Select Auto Run folder/);
			fireEvent.change(input, { target: { value: '/test/path' } });

			// Advance past debounce
			await act(async () => {
				vi.advanceTimersByTime(300);
			});

			expect(screen.getByText('Checking folder...')).toBeInTheDocument();
		});

		it('shows success message when folder is valid with no documents', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({ success: true, files: [] });

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const input = screen.getByPlaceholderText(/Select Auto Run folder/);
			fireEvent.change(input, { target: { value: '/valid/folder' } });

			// Advance past debounce and wait for validation
			await act(async () => {
				vi.advanceTimersByTime(300);
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('Folder found (no markdown documents yet)')).toBeInTheDocument();
		});

		it('shows document count when folder has markdown files (singular)', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
				success: true,
				files: ['doc1.md'],
			});

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const input = screen.getByPlaceholderText(/Select Auto Run folder/);
			fireEvent.change(input, { target: { value: '/folder/with/docs' } });

			await act(async () => {
				vi.advanceTimersByTime(300);
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('Found 1 markdown document')).toBeInTheDocument();
		});

		it('shows document count when folder has markdown files (plural)', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
				success: true,
				files: ['doc1.md', 'doc2.md', 'doc3.md'],
			});

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const input = screen.getByPlaceholderText(/Select Auto Run folder/);
			fireEvent.change(input, { target: { value: '/folder/with/docs' } });

			await act(async () => {
				vi.advanceTimersByTime(300);
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('Found 3 markdown documents')).toBeInTheDocument();
		});

		it('shows error when folder is not accessible', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({ success: false });

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const input = screen.getByPlaceholderText(/Select Auto Run folder/);
			fireEvent.change(input, { target: { value: '/invalid/folder' } });

			await act(async () => {
				vi.advanceTimersByTime(300);
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('Folder not found or not accessible')).toBeInTheDocument();
		});

		it('shows error when validation throws', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			vi.mocked(window.maestro.autorun.listDocs).mockRejectedValue(new Error('Network error'));

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const input = screen.getByPlaceholderText(/Select Auto Run folder/);
			fireEvent.change(input, { target: { value: '/error/folder' } });

			await act(async () => {
				vi.advanceTimersByTime(300);
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('Failed to access folder')).toBeInTheDocument();
		});

		it('does not validate empty folder', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const input = screen.getByPlaceholderText(/Select Auto Run folder/);
			fireEvent.change(input, { target: { value: '  ' } });

			await act(async () => {
				vi.advanceTimersByTime(500);
				await vi.runAllTimersAsync();
			});

			expect(window.maestro.autorun.listDocs).not.toHaveBeenCalled();
		});

		it('debounces validation with 300ms delay', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({ success: true, files: [] });

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const input = screen.getByPlaceholderText(/Select Auto Run folder/);

			// Type rapidly
			fireEvent.change(input, { target: { value: '/a' } });
			await act(async () => {
				vi.advanceTimersByTime(100);
			});

			fireEvent.change(input, { target: { value: '/ab' } });
			await act(async () => {
				vi.advanceTimersByTime(100);
			});

			fireEvent.change(input, { target: { value: '/abc' } });
			await act(async () => {
				vi.advanceTimersByTime(100);
			});

			// Not yet called (only 300ms since last change)
			expect(window.maestro.autorun.listDocs).not.toHaveBeenCalled();

			// After debounce completes
			await act(async () => {
				vi.advanceTimersByTime(300);
				await vi.runAllTimersAsync();
			});

			expect(window.maestro.autorun.listDocs).toHaveBeenCalledWith('/abc', undefined);
		});
	});

	describe('tilde expansion', () => {
		it('expands ~ to home directory in validation', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			vi.mocked(window.maestro.fs.homeDir).mockResolvedValue('/home/testuser');
			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({ success: true, files: [] });

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const input = screen.getByPlaceholderText(/Select Auto Run folder/);
			fireEvent.change(input, { target: { value: '~/Documents' } });

			await act(async () => {
				vi.advanceTimersByTime(300);
				await vi.runAllTimersAsync();
			});

			expect(window.maestro.autorun.listDocs).toHaveBeenCalledWith(
				'/home/testuser/Documents',
				undefined
			);
		});

		it('expands standalone ~ to home directory', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			vi.mocked(window.maestro.fs.homeDir).mockResolvedValue('/home/testuser');
			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({ success: true, files: [] });

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const input = screen.getByPlaceholderText(/Select Auto Run folder/);
			fireEvent.change(input, { target: { value: '~' } });

			await act(async () => {
				vi.advanceTimersByTime(300);
				await vi.runAllTimersAsync();
			});

			expect(window.maestro.autorun.listDocs).toHaveBeenCalledWith('/home/testuser', undefined);
		});

		it('waits for homeDir before validating tilde paths', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			// Delay homeDir response
			let resolveHomeDir: (value: string) => void;
			const homeDirPromise = new Promise<string>((resolve) => {
				resolveHomeDir = resolve;
			});
			vi.mocked(window.maestro.fs.homeDir).mockReturnValue(homeDirPromise);
			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({ success: true, files: [] });

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			// Wait for initial effect to fire
			await act(async () => {
				vi.advanceTimersByTime(10);
			});

			const input = screen.getByPlaceholderText(/Select Auto Run folder/);
			fireEvent.change(input, { target: { value: '~/path' } });

			// Debounce time passed but homeDir not loaded - should show checking
			await act(async () => {
				vi.advanceTimersByTime(300);
			});

			expect(screen.getByText('Checking folder...')).toBeInTheDocument();
			expect(window.maestro.autorun.listDocs).not.toHaveBeenCalled();

			// Now resolve homeDir
			await act(async () => {
				resolveHomeDir!('/home/testuser');
				await vi.runAllTimersAsync();
			});

			// After homeDir loads, effect re-runs and validation should proceed
			await act(async () => {
				vi.advanceTimersByTime(300);
				await vi.runAllTimersAsync();
			});

			expect(window.maestro.autorun.listDocs).toHaveBeenCalledWith(
				'/home/testuser/path',
				undefined
			);
		});

		it('expands tilde in path when continuing', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			vi.mocked(window.maestro.fs.homeDir).mockResolvedValue('/home/testuser');
			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({ success: true, files: [] });

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const input = screen.getByPlaceholderText(/Select Auto Run folder/);
			fireEvent.change(input, { target: { value: '~/Projects' } });

			await act(async () => {
				vi.advanceTimersByTime(300);
				await vi.runAllTimersAsync();
			});

			const continueButton = screen.getByRole('button', { name: 'Continue' });
			fireEvent.click(continueButton);

			expect(onFolderSelected).toHaveBeenCalledWith('/home/testuser/Projects');
		});
	});

	describe('folder picker dialog', () => {
		it('opens folder picker when browse button is clicked', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue('/selected/folder');

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const browseButton = screen.getByTestId('folder-icon').closest('button')!;
			fireEvent.click(browseButton);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(window.maestro.dialog.selectFolder).toHaveBeenCalled();
		});

		it('updates input when folder is selected from picker', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue('/selected/folder');

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const browseButton = screen.getByTestId('folder-icon').closest('button')!;
			fireEvent.click(browseButton);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const input = screen.getByPlaceholderText(/Select Auto Run folder/);
			expect(input).toHaveValue('/selected/folder');
		});

		it('does not update input when folder picker is cancelled', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue(null);

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const input = screen.getByPlaceholderText(/Select Auto Run folder/);
			fireEvent.change(input, { target: { value: '/original/path' } });

			const browseButton = screen.getByTestId('folder-icon').closest('button')!;
			fireEvent.click(browseButton);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(input).toHaveValue('/original/path');
		});
	});

	describe('keyboard interactions', () => {
		it('opens folder picker on Cmd+O', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue('/selected/folder');

			const { container } = renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// Keyboard events are handled by the wrapper div around Modal
			const wrapper = container.firstChild as HTMLElement;
			fireEvent.keyDown(wrapper, { key: 'o', metaKey: true });

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(window.maestro.dialog.selectFolder).toHaveBeenCalled();
		});

		it('opens folder picker on Ctrl+O', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue('/selected/folder');

			const { container } = renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// Keyboard events are handled by the wrapper div around Modal
			const wrapper = container.firstChild as HTMLElement;
			fireEvent.keyDown(wrapper, { key: 'O', ctrlKey: true });

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(window.maestro.dialog.selectFolder).toHaveBeenCalled();
		});

		it('triggers continue on Enter when folder is selected', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({ success: true, files: [] });

			const { container } = renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const input = screen.getByPlaceholderText(/Select Auto Run folder/);
			fireEvent.change(input, { target: { value: '/valid/path' } });

			await act(async () => {
				vi.advanceTimersByTime(300);
				await vi.runAllTimersAsync();
			});

			// Keyboard events are handled by the wrapper div around Modal
			const wrapper = container.firstChild as HTMLElement;
			fireEvent.keyDown(wrapper, { key: 'Enter' });

			expect(onFolderSelected).toHaveBeenCalledWith('/valid/path');
			expect(onClose).toHaveBeenCalled();
		});

		it('does not trigger continue on Enter when folder is empty', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const dialog = screen.getByRole('dialog');
			fireEvent.keyDown(dialog, { key: 'Enter' });

			expect(onFolderSelected).not.toHaveBeenCalled();
			expect(onClose).not.toHaveBeenCalled();
		});

		it('stops propagation of keydown events except Escape', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();
			const parentHandler = vi.fn();

			render(
				<div onKeyDown={parentHandler}>
					<LayerStackProvider>
						<AutoRunSetupModal
							theme={theme}
							onClose={onClose}
							onFolderSelected={onFolderSelected}
						/>
					</LayerStackProvider>
				</div>
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const dialog = screen.getByRole('dialog');
			fireEvent.keyDown(dialog, { key: 'a' });

			expect(parentHandler).not.toHaveBeenCalled();
		});

		it('handles Escape differently from other keys (LayerStack handles it)', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			// The modal's onKeyDown handler does NOT call stopPropagation for Escape
			// (unlike other keys), allowing LayerStack to handle it at capture phase.
			// This test verifies that regular keys get stopPropagation called,
			// demonstrating the conditional behavior in the keyDown handler.
			const parentHandler = vi.fn();

			render(
				<div onKeyDown={parentHandler}>
					<LayerStackProvider>
						<AutoRunSetupModal
							theme={theme}
							onClose={onClose}
							onFolderSelected={onFolderSelected}
						/>
					</LayerStackProvider>
				</div>
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const dialog = screen.getByRole('dialog');

			// Regular key - should NOT reach parent (stopPropagation called by modal)
			fireEvent.keyDown(dialog, { key: 'a' });
			expect(parentHandler).not.toHaveBeenCalled();

			// Note: Escape is handled by LayerStack at capture phase, so it also
			// doesn't reach parent, but for a different reason (LayerStack stops it)
			parentHandler.mockClear();
			fireEvent.keyDown(dialog, { key: 'Escape' });
			// Parent still doesn't receive it because LayerStack intercepts in capture phase
			expect(parentHandler).not.toHaveBeenCalled();
		});
	});

	describe('close button', () => {
		it('calls onClose when X button is clicked', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const closeButton = screen.getByTestId('x-icon').closest('button');
			fireEvent.click(closeButton!);

			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});

	describe('cancel button', () => {
		it('calls onClose when Cancel is clicked', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('does not call onFolderSelected when Cancel is clicked', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
			expect(onFolderSelected).not.toHaveBeenCalled();
		});
	});

	describe('continue button', () => {
		it('is disabled when no folder is selected', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const continueButton = screen.getByRole('button', { name: 'Continue' });
			expect(continueButton).toBeDisabled();
		});

		it('is enabled when folder is selected', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const input = screen.getByPlaceholderText(/Select Auto Run folder/);
			fireEvent.change(input, { target: { value: '/some/path' } });

			const continueButton = screen.getByRole('button', { name: 'Continue' });
			expect(continueButton).not.toBeDisabled();
		});

		it('calls onFolderSelected with trimmed path', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({ success: true, files: [] });

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const input = screen.getByPlaceholderText(/Select Auto Run folder/);
			fireEvent.change(input, { target: { value: '  /path/with/spaces  ' } });

			await act(async () => {
				vi.advanceTimersByTime(300);
				await vi.runAllTimersAsync();
			});

			const continueButton = screen.getByRole('button', { name: 'Continue' });
			fireEvent.click(continueButton);

			expect(onFolderSelected).toHaveBeenCalledWith('/path/with/spaces');
		});

		it('calls onClose after onFolderSelected', async () => {
			const callOrder: string[] = [];
			const onClose = vi.fn(() => callOrder.push('close'));
			const onFolderSelected = vi.fn(() => callOrder.push('folderSelected'));

			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({ success: true, files: [] });

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const input = screen.getByPlaceholderText(/Select Auto Run folder/);
			fireEvent.change(input, { target: { value: '/test/path' } });

			await act(async () => {
				vi.advanceTimersByTime(300);
				await vi.runAllTimersAsync();
			});

			const continueButton = screen.getByRole('button', { name: 'Continue' });
			fireEvent.click(continueButton);

			expect(callOrder).toEqual(['folderSelected', 'close']);
		});

		it('applies theme accent color', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const continueButton = screen.getByRole('button', { name: 'Continue' });
			expect(continueButton).toHaveStyle({ backgroundColor: theme.colors.accent });
		});
	});

	describe('layer stack integration', () => {
		it('registers layer on mount', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			const { unmount } = renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByRole('dialog')).toBeInTheDocument();
			unmount();
		});

		it('unregisters layer on unmount', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			const { unmount } = renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(() => unmount()).not.toThrow();
		});

		it('updates layer handler when onClose changes', async () => {
			const onClose1 = vi.fn();
			const onClose2 = vi.fn();
			const onFolderSelected = vi.fn();

			const { rerender } = renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose1} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			rerender(
				<LayerStackProvider>
					<AutoRunSetupModal theme={theme} onClose={onClose2} onFolderSelected={onFolderSelected} />
				</LayerStackProvider>
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});
	});

	describe('modal structure', () => {
		it('has fixed positioning with backdrop', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveClass('fixed');
			expect(dialog).toHaveClass('inset-0');
			// Modal component uses inline z-index style instead of Tailwind class
			expect(dialog).toHaveStyle({ zIndex: 9999 });
		});

		it('has blur backdrop', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveClass('modal-overlay');
		});

		it('has animation classes', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveClass('animate-in');
			expect(dialog).toHaveClass('fade-in');
		});

		it('has tabIndex for focus', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('tabIndex', '-1');
		});
	});

	describe('theme variations', () => {
		it('renders with light theme', async () => {
			const lightTheme = createTestTheme({
				bgMain: '#ffffff',
				bgSidebar: '#f5f5f5',
				textMain: '#333333',
				textDim: '#666666',
				accent: '#0066cc',
				success: '#28a745',
				error: '#dc3545',
			});

			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			const { container } = renderWithLayerStack(
				<AutoRunSetupModal
					theme={lightTheme}
					onClose={onClose}
					onFolderSelected={onFolderSelected}
				/>
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// Modal uses inline width style instead of Tailwind class
			const modalContent = container.querySelector('[style*="width: 520px"]');
			expect(modalContent).toHaveStyle({ backgroundColor: lightTheme.colors.bgSidebar });
		});

		it('applies success color to validation message', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({ success: true, files: [] });

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const input = screen.getByPlaceholderText(/Select Auto Run folder/);
			fireEvent.change(input, { target: { value: '/valid/folder' } });

			await act(async () => {
				vi.advanceTimersByTime(300);
				await vi.runAllTimersAsync();
			});

			const successMessage = screen.getByText('Folder found (no markdown documents yet)');
			expect(successMessage).toHaveStyle({ color: theme.colors.success });
		});

		it('applies error color to error message', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({ success: false });

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const input = screen.getByPlaceholderText(/Select Auto Run folder/);
			fireEvent.change(input, { target: { value: '/invalid/folder' } });

			await act(async () => {
				vi.advanceTimersByTime(300);
				await vi.runAllTimersAsync();
			});

			const errorMessage = screen.getByText('Folder not found or not accessible');
			expect(errorMessage).toHaveStyle({ color: theme.colors.error });
		});
	});

	describe('edge cases', () => {
		it('handles very long folder paths', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			const longPath = '/a/'.repeat(100) + 'folder';
			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({ success: true, files: [] });

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const input = screen.getByPlaceholderText(/Select Auto Run folder/);
			fireEvent.change(input, { target: { value: longPath } });

			await act(async () => {
				vi.advanceTimersByTime(300);
				await vi.runAllTimersAsync();
			});

			expect(input).toHaveValue(longPath);
			expect(window.maestro.autorun.listDocs).toHaveBeenCalledWith(longPath, undefined);
		});

		it('handles paths with special characters', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			const specialPath = '/path with spaces/folder (test)/[brackets]';
			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({ success: true, files: [] });

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const input = screen.getByPlaceholderText(/Select Auto Run folder/);
			fireEvent.change(input, { target: { value: specialPath } });

			await act(async () => {
				vi.advanceTimersByTime(300);
				await vi.runAllTimersAsync();
			});

			const continueButton = screen.getByRole('button', { name: 'Continue' });
			fireEvent.click(continueButton);

			expect(onFolderSelected).toHaveBeenCalledWith(specialPath);
		});

		it('handles unicode paths', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			const unicodePath = '/Users/テスト/Documenti/文档';
			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({ success: true, files: [] });

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const input = screen.getByPlaceholderText(/Select Auto Run folder/);
			fireEvent.change(input, { target: { value: unicodePath } });

			await act(async () => {
				vi.advanceTimersByTime(300);
				await vi.runAllTimersAsync();
			});

			const continueButton = screen.getByRole('button', { name: 'Continue' });
			fireEvent.click(continueButton);

			expect(onFolderSelected).toHaveBeenCalledWith(unicodePath);
		});

		it('handles rapid folder changes', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({ success: true, files: [] });

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const input = screen.getByPlaceholderText(/Select Auto Run folder/);

			// Rapid changes
			for (let i = 0; i < 10; i++) {
				fireEvent.change(input, { target: { value: `/path${i}` } });
				await act(async () => {
					vi.advanceTimersByTime(50);
				});
			}

			// Wait for final debounce
			await act(async () => {
				vi.advanceTimersByTime(300);
				await vi.runAllTimersAsync();
			});

			// Only the last path should be validated
			expect(window.maestro.autorun.listDocs).toHaveBeenCalledWith('/path9', undefined);
		});

		it('cancels previous validation request when folder changes quickly', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
				success: true,
				files: ['doc.md'],
			});

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const input = screen.getByPlaceholderText(/Select Auto Run folder/);

			// First change - start typing
			fireEvent.change(input, { target: { value: '/first/path' } });
			await act(async () => {
				vi.advanceTimersByTime(100);
			}); // Less than debounce time

			// Second change - before first debounce completes
			fireEvent.change(input, { target: { value: '/second/path' } });
			await act(async () => {
				vi.advanceTimersByTime(300);
			}); // Now debounce fires

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// Only the second path should have been validated (first was cancelled by debounce)
			expect(window.maestro.autorun.listDocs).toHaveBeenCalledTimes(1);
			expect(window.maestro.autorun.listDocs).toHaveBeenCalledWith('/second/path', undefined);
			expect(screen.getByText('Found 1 markdown document')).toBeInTheDocument();
		});
	});

	describe('accessibility', () => {
		it('has semantic button elements', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const buttons = screen.getAllByRole('button');
			expect(buttons.length).toBeGreaterThanOrEqual(3); // X, Browse, Cancel, Continue
		});

		it('has heading for modal title', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByRole('heading', { name: 'Change Auto Run Folder' })).toBeInTheDocument();
		});

		it('has labeled input field', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('Auto Run Folder')).toBeInTheDocument();
		});

		it('has focus ring on continue button', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const continueButton = screen.getByRole('button', { name: 'Continue' });
			expect(continueButton).toHaveClass('focus:ring-2');
			expect(continueButton).toHaveClass('focus:ring-offset-1');
		});

		it('has title attribute on browse button', async () => {
			const onClose = vi.fn();
			const onFolderSelected = vi.fn();

			renderWithLayerStack(
				<AutoRunSetupModal theme={theme} onClose={onClose} onFolderSelected={onFolderSelected} />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const browseButton = screen.getByTestId('folder-icon').closest('button');
			expect(browseButton).toHaveAttribute('title', 'Browse folders (Cmd+O)');
		});
	});
});
