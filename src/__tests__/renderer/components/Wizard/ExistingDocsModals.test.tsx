import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExistingAutoRunDocsModal } from '../../../../renderer/components/Wizard/ExistingAutoRunDocsModal';
import { ExistingDocsModal } from '../../../../renderer/components/Wizard/ExistingDocsModal';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import * as LayerStackContext from '../../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../../renderer/types';

vi.mock('lucide-react', () => ({
	AlertTriangle: ({ className }: { className?: string }) => (
		<svg data-testid="alert-triangle-icon" className={className} />
	),
	ArrowRight: ({ className }: { className?: string }) => (
		<svg data-testid="arrow-right-icon" className={className} />
	),
	BookOpen: ({ className }: { className?: string }) => (
		<svg data-testid="book-open-icon" className={className} />
	),
	FileText: ({ className }: { className?: string }) => (
		<svg data-testid="file-text-icon" className={className} />
	),
	FolderOpen: ({ className }: { className?: string }) => (
		<svg data-testid="folder-open-icon" className={className} />
	),
	Trash2: ({ className }: { className?: string }) => (
		<svg data-testid="trash-icon" className={className} />
	),
}));

const mockTheme: Theme = {
	id: 'test-dark',
	name: 'Test Dark',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#202020',
		bgActivity: '#2a2a2a',
		border: '#333333',
		textMain: '#ffffff',
		textDim: '#999999',
		textFaint: '#666666',
		accent: '#4a9eff',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
		buttonBg: '#333333',
		buttonHover: '#444444',
		headerBg: '#202020',
		scrollbarTrack: '#111111',
		scrollbarThumb: '#444444',
	},
};

const renderWithLayerStack = (ui: React.ReactElement) =>
	render(<LayerStackProvider>{ui}</LayerStackProvider>);

describe('Wizard existing documents modals', () => {
	const originalAutorun = window.maestro.autorun;
	const deleteFolder = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		Object.defineProperty(window.maestro, 'autorun', {
			configurable: true,
			value: {
				...originalAutorun,
				deleteFolder,
			},
		});
	});

	afterEach(() => {
		Object.defineProperty(window.maestro, 'autorun', {
			configurable: true,
			value: originalAutorun,
		});
		vi.restoreAllMocks();
	});

	describe('ExistingAutoRunDocsModal', () => {
		const defaultProps = {
			theme: mockTheme,
			directoryPath: '/Users/test/Maestro Project',
			documentCount: 2,
			onStartFresh: vi.fn(),
			onContinuePlanning: vi.fn(),
			onCancel: vi.fn(),
		};

		it('shows project details, plural document copy, and focuses the safer continue action', () => {
			renderWithLayerStack(<ExistingAutoRunDocsModal {...defaultProps} />);

			expect(
				screen.getByRole('dialog', { name: 'Existing Auto Run Documents Detected' })
			).toBeInTheDocument();
			expect(screen.getByText('Maestro Project')).toHaveAttribute(
				'title',
				'/Users/test/Maestro Project'
			);
			expect(screen.getByText(/2 documents found in/)).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /Continue Planning/i })).toHaveFocus();
		});

		it('uses singular document copy and falls back to the raw path as the folder label', () => {
			renderWithLayerStack(
				<ExistingAutoRunDocsModal
					{...defaultProps}
					directoryPath="/Users/test/Trailing Slash/"
					documentCount={1}
				/>
			);

			expect(screen.getByText('/Users/test/Trailing Slash/')).toHaveAttribute(
				'title',
				'/Users/test/Trailing Slash/'
			);
			expect(screen.getByText(/1 document found in/)).toBeInTheDocument();
		});

		it('continues, cancels from Escape, and starts fresh through keyboard navigation', async () => {
			const onContinuePlanning = vi.fn();
			const onStartFresh = vi.fn();
			const onCancel = vi.fn();
			renderWithLayerStack(
				<ExistingAutoRunDocsModal
					{...defaultProps}
					onContinuePlanning={onContinuePlanning}
					onStartFresh={onStartFresh}
					onCancel={onCancel}
				/>
			);
			const dialog = screen.getByRole('dialog');

			fireEvent.keyDown(dialog, { key: 'a' });
			expect(onContinuePlanning).not.toHaveBeenCalled();
			expect(onStartFresh).not.toHaveBeenCalled();

			fireEvent.keyDown(dialog, { key: 'Enter' });
			expect(onContinuePlanning).toHaveBeenCalledTimes(1);

			fireEvent.keyDown(dialog, { key: 'ArrowDown' });
			fireEvent.keyDown(dialog, { key: 'Enter' });
			expect(onStartFresh).toHaveBeenCalledTimes(1);
			expect(screen.getByRole('button', { name: /Deleting/i })).toBeDisabled();

			window.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
			);
			await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
		});

		it('supports Tab switching and focused start-fresh styling', () => {
			const onStartFresh = vi.fn();
			const onContinuePlanning = vi.fn();
			renderWithLayerStack(
				<ExistingAutoRunDocsModal
					{...defaultProps}
					onStartFresh={onStartFresh}
					onContinuePlanning={onContinuePlanning}
				/>
			);
			const dialog = screen.getByRole('dialog');
			const startFreshButton = screen.getByRole('button', {
				name: /Start Fresh \(Delete Existing Docs\)/i,
			});

			fireEvent.focus(startFreshButton);
			expect(startFreshButton).toHaveStyle({
				boxShadow: `0 0 0 2px ${mockTheme.colors.bgSidebar}, 0 0 0 4px ${mockTheme.colors.error}`,
			});

			fireEvent.keyDown(dialog, { key: 'ArrowUp' });
			fireEvent.keyDown(dialog, { key: 'Enter' });
			expect(onContinuePlanning).toHaveBeenCalledTimes(1);
			expect(onStartFresh).not.toHaveBeenCalled();

			fireEvent.keyDown(dialog, { key: 'Tab' });
			fireEvent.keyDown(dialog, { key: 'Enter' });

			expect(onStartFresh).toHaveBeenCalledTimes(1);
		});

		it('switches from start fresh back to continue with Tab', () => {
			const onContinuePlanning = vi.fn();
			renderWithLayerStack(
				<ExistingAutoRunDocsModal {...defaultProps} onContinuePlanning={onContinuePlanning} />
			);
			const dialog = screen.getByRole('dialog');
			const startFreshButton = screen.getByRole('button', {
				name: /Start Fresh \(Delete Existing Docs\)/i,
			});

			fireEvent.focus(startFreshButton);
			fireEvent.keyDown(dialog, { key: 'Tab' });
			fireEvent.keyDown(dialog, { key: 'Enter' });

			expect(onContinuePlanning).toHaveBeenCalledTimes(1);
		});
	});

	describe('ExistingDocsModal', () => {
		const defaultProps = {
			theme: mockTheme,
			documentCount: 3,
			directoryPath: '/tmp/project/Auto Run Docs',
			onStartFresh: vi.fn(),
			onContinue: vi.fn(),
			onCancel: vi.fn(),
		};

		it('shows existing document count, focuses continue, and handles continue/cancel actions', () => {
			const onContinue = vi.fn();
			const onCancel = vi.fn();
			renderWithLayerStack(
				<ExistingDocsModal {...defaultProps} onContinue={onContinue} onCancel={onCancel} />
			);

			expect(
				screen.getByRole('dialog', { name: 'Existing Auto Run Documents Found' })
			).toBeInTheDocument();
			expect(screen.getByText(/3 Auto Run documents/)).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /Continue Building/i })).toHaveFocus();

			fireEvent.click(screen.getByRole('button', { name: /Continue Building/i }));
			expect(onContinue).toHaveBeenCalledTimes(1);

			fireEvent.click(screen.getByRole('button', { name: /Cancel and choose/i }));
			expect(onCancel).toHaveBeenCalledTimes(1);
		});

		it('uses singular copy when one existing document is present', () => {
			renderWithLayerStack(<ExistingDocsModal {...defaultProps} documentCount={1} />);

			expect(document.getElementById('existing-docs-description')).toHaveTextContent(
				'1 Auto Run document from a previous planning session'
			);
		});

		it('registers an escape handler that cancels the modal', () => {
			const onCancel = vi.fn();
			let registeredEscapeHandler: (() => void) | undefined;

			vi.spyOn(LayerStackContext, 'useLayerStack').mockReturnValue({
				registerLayer: vi.fn((layer) => {
					registeredEscapeHandler = layer.onEscape;
					return 'existing-docs-layer';
				}),
				unregisterLayer: vi.fn(),
				updateLayerHandler: vi.fn(),
			} as unknown as ReturnType<typeof LayerStackContext.useLayerStack>);

			render(<ExistingDocsModal {...defaultProps} onCancel={onCancel} />);

			expect(registeredEscapeHandler).toEqual(expect.any(Function));

			registeredEscapeHandler?.();

			expect(onCancel).toHaveBeenCalledTimes(1);
		});

		it('allows Tab to bubble but stops other modal key presses', () => {
			const onParentKeyDown = vi.fn();
			render(
				<div onKeyDown={onParentKeyDown}>
					<LayerStackProvider>
						<ExistingDocsModal {...defaultProps} />
					</LayerStackProvider>
				</div>
			);
			const dialog = screen.getByRole('dialog');

			fireEvent.keyDown(dialog, { key: 'Tab' });
			expect(onParentKeyDown).toHaveBeenCalledTimes(1);

			onParentKeyDown.mockClear();
			fireEvent.keyDown(dialog, { key: 'Enter' });
			expect(onParentKeyDown).not.toHaveBeenCalled();
		});

		it('deletes existing docs before starting fresh', async () => {
			deleteFolder.mockResolvedValue({ success: true });
			const onStartFresh = vi.fn();
			renderWithLayerStack(<ExistingDocsModal {...defaultProps} onStartFresh={onStartFresh} />);

			fireEvent.click(screen.getByRole('button', { name: /Delete & Start Fresh/i }));

			expect(screen.getByRole('button', { name: /Deleting Documents/i })).toBeDisabled();
			await waitFor(() => {
				expect(deleteFolder).toHaveBeenCalledWith('/tmp/project/Auto Run Docs');
				expect(onStartFresh).toHaveBeenCalledTimes(1);
			});
		});

		it('shows result errors and re-enables actions when deletion is rejected', async () => {
			deleteFolder.mockResolvedValue({ success: false, error: 'Permission denied' });
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const onStartFresh = vi.fn();
			renderWithLayerStack(<ExistingDocsModal {...defaultProps} onStartFresh={onStartFresh} />);

			fireEvent.click(screen.getByRole('button', { name: /Delete & Start Fresh/i }));

			expect(await screen.findByText('Permission denied')).toBeInTheDocument();
			expect(consoleError).toHaveBeenCalledWith(
				'Failed to delete existing docs:',
				expect.any(Error)
			);
			expect(onStartFresh).not.toHaveBeenCalled();
			expect(screen.getByRole('button', { name: /Delete & Start Fresh/i })).toBeEnabled();
		});

		it('uses the default deletion error when a failed result has no message', async () => {
			deleteFolder.mockResolvedValue({ success: false });
			vi.spyOn(console, 'error').mockImplementation(() => {});

			renderWithLayerStack(<ExistingDocsModal {...defaultProps} />);

			fireEvent.click(screen.getByRole('button', { name: /Delete & Start Fresh/i }));

			expect(await screen.findByText('Failed to delete Auto Run Docs folder')).toBeInTheDocument();
		});

		it('shows fallback errors for thrown non-Error deletion failures and uses the latest Escape handler', async () => {
			deleteFolder.mockRejectedValue('disk offline');
			const firstCancel = vi.fn();
			const secondCancel = vi.fn();
			const { rerender } = renderWithLayerStack(
				<ExistingDocsModal {...defaultProps} onCancel={firstCancel} />
			);
			rerender(
				<LayerStackProvider>
					<ExistingDocsModal {...defaultProps} onCancel={secondCancel} />
				</LayerStackProvider>
			);
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

			fireEvent.click(screen.getByRole('button', { name: /Delete & Start Fresh/i }));

			expect(await screen.findByText('Failed to delete existing documents')).toBeInTheDocument();
			expect(consoleError).toHaveBeenCalledWith('Failed to delete existing docs:', 'disk offline');

			window.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
			);
			await waitFor(() => {
				expect(firstCancel).not.toHaveBeenCalled();
				expect(secondCancel).toHaveBeenCalledTimes(1);
			});
		});
	});
});
