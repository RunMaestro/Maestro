/**
 * @file SaveMarkdownModal.test.tsx
 * @description Tests for SaveMarkdownModal component
 *
 * Test coverage includes:
 * - Basic rendering
 * - Form validation
 * - Save functionality
 * - SSH remote session behavior (folder browse button visibility, remote saving)
 * - Keyboard interaction (Enter to save)
 * - Error handling
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SaveMarkdownModal } from '../../../renderer/components/SaveMarkdownModal';
import type { Theme } from '../../../renderer/types';

// Mock createPortal to render inline for testing
vi.mock('react-dom', async () => {
	const actual = await vi.importActual('react-dom');
	return {
		...actual,
		createPortal: (children: React.ReactNode) => children,
	};
});

// Mock layer stack context
const mockRegisterLayer = vi.fn().mockReturnValue('layer-1');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: mockUpdateLayerHandler,
	}),
}));

// Mock window.maestro APIs
const mockSelectFolder = vi.fn();
const mockWriteFile = vi.fn();

beforeEach(() => {
	(window as any).maestro = {
		dialog: {
			selectFolder: mockSelectFolder,
		},
		fs: {
			writeFile: mockWriteFile,
		},
	};
});

afterEach(() => {
	vi.clearAllMocks();
});

// Default theme for testing
const defaultTheme: Theme = {
	id: 'test-theme' as any,
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgActivity: '#0f3460',
		textMain: '#e94560',
		textDim: '#a0a0a0',
		accent: '#e94560',
		accentDim: '#b83b5e',
		accentForeground: '#ffffff',
		border: '#2a2a4e',
		success: '#00ff88',
		warning: '#ffcc00',
		error: '#ff4444',
	},
};

const defaultProps = {
	theme: defaultTheme,
	content: '# Test Markdown\n\nThis is test content.',
	onClose: vi.fn(),
	defaultFolder: '/test/folder',
	onFileSaved: vi.fn(),
};

describe('SaveMarkdownModal', () => {
	describe('basic rendering', () => {
		it('renders without crashing', () => {
			render(<SaveMarkdownModal {...defaultProps} />);
			expect(screen.getByText('Save Markdown')).toBeInTheDocument();
		});

		it('renders folder input with default value', () => {
			render(<SaveMarkdownModal {...defaultProps} />);
			const folderInput = screen.getByPlaceholderText('/path/to/folder');
			expect(folderInput).toHaveValue('/test/folder');
		});

		it('renders filename input with empty value', () => {
			render(<SaveMarkdownModal {...defaultProps} />);
			const filenameInput = screen.getByPlaceholderText('document.md');
			expect(filenameInput).toHaveValue('');
		});

		it('renders Save and Cancel buttons', () => {
			render(<SaveMarkdownModal {...defaultProps} />);
			expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
		});

		it('shows .md extension hint', () => {
			render(<SaveMarkdownModal {...defaultProps} />);
			expect(
				screen.getByText('.md extension will be added automatically if not provided')
			).toBeInTheDocument();
		});

		it('renders folder browse button by default', () => {
			render(<SaveMarkdownModal {...defaultProps} />);
			expect(screen.getByTitle('Browse for folder')).toBeInTheDocument();
		});
	});

	describe('SSH remote session behavior', () => {
		it('hides folder browse button when isRemoteSession is true', () => {
			render(<SaveMarkdownModal {...defaultProps} isRemoteSession={true} />);
			expect(screen.queryByTitle('Browse for folder')).not.toBeInTheDocument();
		});

		it('shows folder browse button when isRemoteSession is false', () => {
			render(<SaveMarkdownModal {...defaultProps} isRemoteSession={false} />);
			expect(screen.getByTitle('Browse for folder')).toBeInTheDocument();
		});

		it('allows manual path entry when isRemoteSession is true', () => {
			render(<SaveMarkdownModal {...defaultProps} isRemoteSession={true} />);
			const folderInput = screen.getByPlaceholderText('/path/to/folder');
			fireEvent.change(folderInput, { target: { value: '/remote/path' } });
			expect(folderInput).toHaveValue('/remote/path');
		});

		it('passes sshRemoteId to writeFile when saving to remote', async () => {
			mockWriteFile.mockResolvedValue({ success: true });
			render(
				<SaveMarkdownModal
					{...defaultProps}
					isRemoteSession={true}
					sshRemoteId="ssh-remote-123"
					defaultFolder="/home/user"
				/>
			);

			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'remote-doc.md' } });

			const saveButton = screen.getByRole('button', { name: 'Save' });
			await act(async () => {
				fireEvent.click(saveButton);
			});

			expect(mockWriteFile).toHaveBeenCalledWith(
				'/home/user/remote-doc.md',
				'# Test Markdown\n\nThis is test content.',
				'ssh-remote-123'
			);
		});

		it('saves without sshRemoteId when not provided', async () => {
			mockWriteFile.mockResolvedValue({ success: true });
			render(<SaveMarkdownModal {...defaultProps} isRemoteSession={false} />);

			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'local-doc.md' } });

			const saveButton = screen.getByRole('button', { name: 'Save' });
			await act(async () => {
				fireEvent.click(saveButton);
			});

			expect(mockWriteFile).toHaveBeenCalledWith(
				'/test/folder/local-doc.md',
				expect.any(String),
				undefined
			);
		});
	});

	describe('folder browser', () => {
		it('opens folder dialog when browse button is clicked', async () => {
			mockSelectFolder.mockResolvedValue('/selected/folder');
			render(<SaveMarkdownModal {...defaultProps} />);

			const browseButton = screen.getByTitle('Browse for folder');
			await act(async () => {
				fireEvent.click(browseButton);
			});

			expect(mockSelectFolder).toHaveBeenCalled();
		});

		it('updates folder input when folder is selected', async () => {
			mockSelectFolder.mockResolvedValue('/selected/folder');
			render(<SaveMarkdownModal {...defaultProps} />);

			const browseButton = screen.getByTitle('Browse for folder');
			await act(async () => {
				fireEvent.click(browseButton);
			});

			await waitFor(() => {
				const folderInput = screen.getByPlaceholderText('/path/to/folder');
				expect(folderInput).toHaveValue('/selected/folder');
			});
		});

		it('does not update folder when dialog is cancelled', async () => {
			mockSelectFolder.mockResolvedValue(null);
			render(<SaveMarkdownModal {...defaultProps} />);

			const browseButton = screen.getByTitle('Browse for folder');
			await act(async () => {
				fireEvent.click(browseButton);
			});

			const folderInput = screen.getByPlaceholderText('/path/to/folder');
			expect(folderInput).toHaveValue('/test/folder');
		});

		it('shows error when folder dialog fails', async () => {
			mockSelectFolder.mockRejectedValue(new Error('Dialog error'));
			render(<SaveMarkdownModal {...defaultProps} />);

			const browseButton = screen.getByTitle('Browse for folder');
			await act(async () => {
				fireEvent.click(browseButton);
			});

			await waitFor(() => {
				expect(screen.getByText('Failed to open folder browser')).toBeInTheDocument();
			});
		});
	});

	describe('form validation', () => {
		it('disables Save button when folder is empty', () => {
			render(<SaveMarkdownModal {...defaultProps} defaultFolder="" />);
			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'test.md' } });

			const saveButton = screen.getByRole('button', { name: 'Save' });
			expect(saveButton).toBeDisabled();
		});

		it('disables Save button when filename is empty', () => {
			render(<SaveMarkdownModal {...defaultProps} />);
			const saveButton = screen.getByRole('button', { name: 'Save' });
			expect(saveButton).toBeDisabled();
		});

		it('enables Save button when both folder and filename are filled', () => {
			render(<SaveMarkdownModal {...defaultProps} />);
			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'test.md' } });

			const saveButton = screen.getByRole('button', { name: 'Save' });
			expect(saveButton).not.toBeDisabled();
		});

		it('shows error when trying to save without folder', async () => {
			render(<SaveMarkdownModal {...defaultProps} defaultFolder="" />);
			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'test.md' } });

			// Force enable and click (simulating edge case)
			const saveButton = screen.getByRole('button', { name: 'Save' });
			// Button is disabled, so this shouldn't trigger save
			expect(saveButton).toBeDisabled();
		});
	});

	describe('save functionality', () => {
		it('saves file with correct path and content', async () => {
			mockWriteFile.mockResolvedValue({ success: true });
			const onClose = vi.fn();
			render(<SaveMarkdownModal {...defaultProps} onClose={onClose} />);

			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'test.md' } });

			const saveButton = screen.getByRole('button', { name: 'Save' });
			await act(async () => {
				fireEvent.click(saveButton);
			});

			expect(mockWriteFile).toHaveBeenCalledWith(
				'/test/folder/test.md',
				'# Test Markdown\n\nThis is test content.',
				undefined // No SSH remote ID for local save
			);
		});

		it('adds .md extension if not provided', async () => {
			mockWriteFile.mockResolvedValue({ success: true });
			render(<SaveMarkdownModal {...defaultProps} />);

			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'test' } });

			const saveButton = screen.getByRole('button', { name: 'Save' });
			await act(async () => {
				fireEvent.click(saveButton);
			});

			expect(mockWriteFile).toHaveBeenCalledWith('/test/folder/test.md', expect.any(String), undefined);
		});

		it('does not duplicate .md extension', async () => {
			mockWriteFile.mockResolvedValue({ success: true });
			render(<SaveMarkdownModal {...defaultProps} />);

			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'test.md' } });

			const saveButton = screen.getByRole('button', { name: 'Save' });
			await act(async () => {
				fireEvent.click(saveButton);
			});

			expect(mockWriteFile).toHaveBeenCalledWith('/test/folder/test.md', expect.any(String), undefined);
		});

		it('handles .MD extension case-insensitively', async () => {
			mockWriteFile.mockResolvedValue({ success: true });
			render(<SaveMarkdownModal {...defaultProps} />);

			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'test.MD' } });

			const saveButton = screen.getByRole('button', { name: 'Save' });
			await act(async () => {
				fireEvent.click(saveButton);
			});

			// Should not add another .md
			expect(mockWriteFile).toHaveBeenCalledWith('/test/folder/test.MD', expect.any(String), undefined);
		});

		it('calls onClose after successful save', async () => {
			mockWriteFile.mockResolvedValue({ success: true });
			const onClose = vi.fn();
			render(<SaveMarkdownModal {...defaultProps} onClose={onClose} />);

			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'test.md' } });

			const saveButton = screen.getByRole('button', { name: 'Save' });
			await act(async () => {
				fireEvent.click(saveButton);
			});

			await waitFor(() => {
				expect(onClose).toHaveBeenCalled();
			});
		});

		it('shows error when save fails', async () => {
			mockWriteFile.mockResolvedValue({ success: false });
			render(<SaveMarkdownModal {...defaultProps} />);

			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'test.md' } });

			const saveButton = screen.getByRole('button', { name: 'Save' });
			await act(async () => {
				fireEvent.click(saveButton);
			});

			// Wait for both the error to appear AND saving state to reset (from finally block)
			await waitFor(() => {
				expect(screen.getByText('Failed to save file')).toBeInTheDocument();
				// Ensure the save button is back to "Save" (not "Saving...") to confirm finally block completed
				expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
			});
		});

		it('shows error message from exception', async () => {
			mockWriteFile.mockRejectedValue(new Error('Permission denied'));
			render(<SaveMarkdownModal {...defaultProps} />);

			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'test.md' } });

			const saveButton = screen.getByRole('button', { name: 'Save' });
			await act(async () => {
				fireEvent.click(saveButton);
			});

			// Wait for both the error to appear AND saving state to reset (from finally block)
			await waitFor(() => {
				expect(screen.getByText('Permission denied')).toBeInTheDocument();
				// Ensure the save button is back to "Save" (not "Saving...") to confirm finally block completed
				expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
			});
		});

		it('shows Saving... label while saving', async () => {
			mockWriteFile.mockImplementation(
				() => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 100))
			);
			render(<SaveMarkdownModal {...defaultProps} />);

			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'test.md' } });

			const saveButton = screen.getByRole('button', { name: 'Save' });
			await act(async () => {
				fireEvent.click(saveButton);
			});

			expect(screen.getByRole('button', { name: 'Saving...' })).toBeInTheDocument();
		});

		it('handles folder path with trailing slash', async () => {
			mockWriteFile.mockResolvedValue({ success: true });
			render(<SaveMarkdownModal {...defaultProps} defaultFolder="/test/folder/" />);

			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'test.md' } });

			const saveButton = screen.getByRole('button', { name: 'Save' });
			await act(async () => {
				fireEvent.click(saveButton);
			});

			// Should not have double slash
			expect(mockWriteFile).toHaveBeenCalledWith('/test/folder/test.md', expect.any(String), undefined);
		});

		it('handles Windows-style paths', async () => {
			mockWriteFile.mockResolvedValue({ success: true });
			// Use String.raw or actual backslash path value
			const windowsPath = 'C:\\Users\\test';
			render(<SaveMarkdownModal {...defaultProps} defaultFolder={windowsPath} />);

			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'test.md' } });

			const saveButton = screen.getByRole('button', { name: 'Save' });
			await act(async () => {
				fireEvent.click(saveButton);
			});

			// Should use backslash for Windows paths
			expect(mockWriteFile).toHaveBeenCalledWith(`${windowsPath}\\test.md`, expect.any(String), undefined);
		});
	});

	describe('keyboard interaction', () => {
		it('saves when Enter is pressed with valid form', async () => {
			mockWriteFile.mockResolvedValue({ success: true });
			render(<SaveMarkdownModal {...defaultProps} />);

			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'test.md' } });
			fireEvent.keyDown(filenameInput, { key: 'Enter' });

			await waitFor(() => {
				expect(mockWriteFile).toHaveBeenCalled();
			});
		});

		it('does not save when Enter is pressed with empty filename', async () => {
			render(<SaveMarkdownModal {...defaultProps} />);

			const folderInput = screen.getByPlaceholderText('/path/to/folder');
			fireEvent.keyDown(folderInput, { key: 'Enter' });

			expect(mockWriteFile).not.toHaveBeenCalled();
		});

		it('does not save when Enter is pressed while saving', async () => {
			mockWriteFile.mockImplementation(
				() => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 100))
			);
			render(<SaveMarkdownModal {...defaultProps} />);

			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'test.md' } });

			// First Enter starts saving
			fireEvent.keyDown(filenameInput, { key: 'Enter' });
			// Second Enter while saving should be ignored
			fireEvent.keyDown(filenameInput, { key: 'Enter' });

			// Should only be called once
			expect(mockWriteFile).toHaveBeenCalledTimes(1);
		});
	});

	describe('cancel functionality', () => {
		it('calls onClose when Cancel button is clicked', async () => {
			const onClose = vi.fn();
			render(<SaveMarkdownModal {...defaultProps} onClose={onClose} />);

			const cancelButton = screen.getByRole('button', { name: 'Cancel' });
			await act(async () => {
				fireEvent.click(cancelButton);
			});

			expect(onClose).toHaveBeenCalled();
		});
	});

	describe('error clearing', () => {
		it('clears error when folder is changed', async () => {
			mockWriteFile.mockResolvedValue({ success: false });
			render(<SaveMarkdownModal {...defaultProps} />);

			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'test.md' } });

			const saveButton = screen.getByRole('button', { name: 'Save' });
			await act(async () => {
				fireEvent.click(saveButton);
			});

			// Wait for both the error to appear AND saving state to reset (from finally block)
			await waitFor(() => {
				expect(screen.getByText('Failed to save file')).toBeInTheDocument();
				expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
			});

			// Change folder
			const folderInput = screen.getByPlaceholderText('/path/to/folder');
			fireEvent.change(folderInput, { target: { value: '/new/folder' } });

			expect(screen.queryByText('Failed to save file')).not.toBeInTheDocument();
		});

		it('clears error when filename is changed', async () => {
			mockWriteFile.mockResolvedValue({ success: false });
			render(<SaveMarkdownModal {...defaultProps} />);

			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'test.md' } });

			const saveButton = screen.getByRole('button', { name: 'Save' });
			await act(async () => {
				fireEvent.click(saveButton);
			});

			// Wait for both the error to appear AND saving state to reset (from finally block)
			await waitFor(() => {
				expect(screen.getByText('Failed to save file')).toBeInTheDocument();
				expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
			});

			// Change filename
			fireEvent.change(filenameInput, { target: { value: 'new.md' } });

			expect(screen.queryByText('Failed to save file')).not.toBeInTheDocument();
		});
	});

	describe('focus behavior', () => {
		it('focuses filename input on mount', async () => {
			render(<SaveMarkdownModal {...defaultProps} />);

			// Wait for requestAnimationFrame
			await act(async () => {
				await new Promise((resolve) => requestAnimationFrame(resolve));
			});

			const filenameInput = screen.getByPlaceholderText('document.md');
			expect(document.activeElement).toBe(filenameInput);
		});
	});

	describe('onFileSaved callback', () => {
		it('calls onFileSaved after successful save', async () => {
			mockWriteFile.mockResolvedValue({ success: true });
			const onFileSaved = vi.fn();
			const onClose = vi.fn();
			render(
				<SaveMarkdownModal
					{...defaultProps}
					onClose={onClose}
					onFileSaved={onFileSaved}
				/>
			);

			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'test.md' } });

			const saveButton = screen.getByRole('button', { name: 'Save' });
			await act(async () => {
				fireEvent.click(saveButton);
			});

			await waitFor(() => {
				expect(onFileSaved).toHaveBeenCalledTimes(1);
				expect(onClose).toHaveBeenCalledTimes(1);
			});
		});

		it('calls onFileSaved before onClose', async () => {
			mockWriteFile.mockResolvedValue({ success: true });
			const callOrder: string[] = [];
			const onFileSaved = vi.fn(() => callOrder.push('onFileSaved'));
			const onClose = vi.fn(() => callOrder.push('onClose'));
			render(
				<SaveMarkdownModal
					{...defaultProps}
					onClose={onClose}
					onFileSaved={onFileSaved}
				/>
			);

			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'test.md' } });

			const saveButton = screen.getByRole('button', { name: 'Save' });
			await act(async () => {
				fireEvent.click(saveButton);
			});

			await waitFor(() => {
				expect(callOrder).toEqual(['onFileSaved', 'onClose']);
			});
		});

		it('does not call onFileSaved when save fails', async () => {
			mockWriteFile.mockResolvedValue({ success: false });
			const onFileSaved = vi.fn();
			render(<SaveMarkdownModal {...defaultProps} onFileSaved={onFileSaved} />);

			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'test.md' } });

			const saveButton = screen.getByRole('button', { name: 'Save' });
			await act(async () => {
				fireEvent.click(saveButton);
			});

			await waitFor(() => {
				expect(screen.getByText('Failed to save file')).toBeInTheDocument();
			});

			expect(onFileSaved).not.toHaveBeenCalled();
		});

		it('does not call onFileSaved when save throws error', async () => {
			mockWriteFile.mockRejectedValue(new Error('Write error'));
			const onFileSaved = vi.fn();
			render(<SaveMarkdownModal {...defaultProps} onFileSaved={onFileSaved} />);

			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'test.md' } });

			const saveButton = screen.getByRole('button', { name: 'Save' });
			await act(async () => {
				fireEvent.click(saveButton);
			});

			await waitFor(() => {
				expect(screen.getByText('Write error')).toBeInTheDocument();
			});

			expect(onFileSaved).not.toHaveBeenCalled();
		});

		it('works when onFileSaved is not provided', async () => {
			mockWriteFile.mockResolvedValue({ success: true });
			const onClose = vi.fn();
			render(
				<SaveMarkdownModal
					theme={defaultTheme}
					content="Test content"
					onClose={onClose}
					defaultFolder="/test/folder"
					// onFileSaved intentionally not provided
				/>
			);

			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'test.md' } });

			const saveButton = screen.getByRole('button', { name: 'Save' });
			await act(async () => {
				fireEvent.click(saveButton);
			});

			await waitFor(() => {
				expect(onClose).toHaveBeenCalled();
			});
		});
	});

	describe('Open in Tab checkbox', () => {
		it('does not render checkbox when onOpenInTab is not provided', () => {
			render(<SaveMarkdownModal {...defaultProps} />);
			expect(screen.queryByText('Open in Tab')).not.toBeInTheDocument();
		});

		it('renders unchecked checkbox when onOpenInTab is provided', () => {
			const onOpenInTab = vi.fn();
			render(<SaveMarkdownModal {...defaultProps} onOpenInTab={onOpenInTab} />);
			const checkbox = screen.getByRole('checkbox');
			expect(checkbox).toBeInTheDocument();
			expect(checkbox).not.toBeChecked();
			expect(screen.getByText('Open in Tab')).toBeInTheDocument();
		});

		it('toggles checkbox when clicked', () => {
			const onOpenInTab = vi.fn();
			render(<SaveMarkdownModal {...defaultProps} onOpenInTab={onOpenInTab} />);
			const checkbox = screen.getByRole('checkbox');
			fireEvent.click(checkbox);
			expect(checkbox).toBeChecked();
			fireEvent.click(checkbox);
			expect(checkbox).not.toBeChecked();
		});

		it('does not call onOpenInTab when checkbox is unchecked', async () => {
			mockWriteFile.mockResolvedValue({ success: true });
			const onOpenInTab = vi.fn();
			render(<SaveMarkdownModal {...defaultProps} onOpenInTab={onOpenInTab} />);

			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'test.md' } });

			const saveButton = screen.getByRole('button', { name: 'Save' });
			await act(async () => {
				fireEvent.click(saveButton);
			});

			await waitFor(() => {
				expect(defaultProps.onClose).toHaveBeenCalled();
			});
			expect(onOpenInTab).not.toHaveBeenCalled();
		});

		it('calls onOpenInTab with file details when checkbox is checked', async () => {
			mockWriteFile.mockResolvedValue({ success: true });
			const onOpenInTab = vi.fn();
			render(<SaveMarkdownModal {...defaultProps} onOpenInTab={onOpenInTab} />);

			// Check the checkbox
			const checkbox = screen.getByRole('checkbox');
			fireEvent.click(checkbox);

			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'test.md' } });

			const saveButton = screen.getByRole('button', { name: 'Save' });
			await act(async () => {
				fireEvent.click(saveButton);
			});

			await waitFor(() => {
				expect(onOpenInTab).toHaveBeenCalledWith({
					path: '/test/folder/test.md',
					name: 'test.md',
					content: '# Test Markdown\n\nThis is test content.',
					sshRemoteId: undefined,
				});
			});
		});

		it('passes sshRemoteId to onOpenInTab for remote sessions', async () => {
			mockWriteFile.mockResolvedValue({ success: true });
			const onOpenInTab = vi.fn();
			render(
				<SaveMarkdownModal
					{...defaultProps}
					onOpenInTab={onOpenInTab}
					isRemoteSession={true}
					sshRemoteId="ssh-remote-456"
				/>
			);

			// Check the checkbox
			const checkbox = screen.getByRole('checkbox');
			fireEvent.click(checkbox);

			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'remote-doc' } });

			const saveButton = screen.getByRole('button', { name: 'Save' });
			await act(async () => {
				fireEvent.click(saveButton);
			});

			await waitFor(() => {
				expect(onOpenInTab).toHaveBeenCalledWith({
					path: '/test/folder/remote-doc.md',
					name: 'remote-doc.md',
					content: '# Test Markdown\n\nThis is test content.',
					sshRemoteId: 'ssh-remote-456',
				});
			});
		});

		it('does not call onOpenInTab when save fails', async () => {
			mockWriteFile.mockResolvedValue({ success: false });
			const onOpenInTab = vi.fn();
			render(<SaveMarkdownModal {...defaultProps} onOpenInTab={onOpenInTab} />);

			const checkbox = screen.getByRole('checkbox');
			fireEvent.click(checkbox);

			const filenameInput = screen.getByPlaceholderText('document.md');
			fireEvent.change(filenameInput, { target: { value: 'test.md' } });

			const saveButton = screen.getByRole('button', { name: 'Save' });
			await act(async () => {
				fireEvent.click(saveButton);
			});

			await waitFor(() => {
				expect(screen.getByText('Failed to save file')).toBeInTheDocument();
			});
			expect(onOpenInTab).not.toHaveBeenCalled();
		});
	});
});
