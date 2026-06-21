import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DebugPackageModal } from '../../renderer/components/DebugPackageModal';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../renderer/types';
import { notifyToast } from '../../renderer/stores/notificationStore';
import { flashCopiedToClipboard } from '../../renderer/utils/flashCopiedToClipboard';
import { logger } from '../../renderer/utils/logger';

vi.mock('../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));

vi.mock('../../renderer/utils/flashCopiedToClipboard', () => ({
	flashCopiedToClipboard: vi.fn(),
}));

vi.mock('lucide-react', () => ({
	Package: ({ className }: { className?: string }) => (
		<svg data-testid="package-icon" className={className} />
	),
	Check: ({ className }: { className?: string }) => (
		<svg data-testid="check-icon" className={className} />
	),
	Loader2: ({ className }: { className?: string }) => (
		<svg data-testid="loader-icon" className={className} />
	),
	FolderOpen: ({ className }: { className?: string }) => (
		<svg data-testid="folder-open-icon" className={className} />
	),
	AlertCircle: ({ className }: { className?: string }) => (
		<svg data-testid="alert-icon" className={className} />
	),
	Copy: ({ className }: { className?: string }) => (
		<svg data-testid="copy-icon" className={className} />
	),
	X: ({ className }: { className?: string }) => <svg data-testid="x-icon" className={className} />,
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

const previewCategories = [
	{ id: 'logs', name: 'System Logs', included: true, sizeEstimate: '~10 KB' },
	{ id: 'errors', name: 'Error States', included: true, sizeEstimate: '< 5 KB' },
	{ id: 'sessions', name: 'Session Metadata', included: true, sizeEstimate: '~20 KB' },
	{ id: 'groupChats', name: 'Group Chat Metadata', included: true, sizeEstimate: '< 5 KB' },
	{ id: 'batchState', name: 'Auto Run State', included: true, sizeEstimate: '< 5 KB' },
];

const originalClipboard = navigator.clipboard;
const originalDebug = window.maestro.debug;
const originalProcess = window.maestro.process;

function renderModal(props: Partial<React.ComponentProps<typeof DebugPackageModal>> = {}) {
	return render(
		<LayerStackProvider>
			<DebugPackageModal theme={mockTheme} isOpen={true} onClose={vi.fn()} {...props} />
		</LayerStackProvider>
	);
}

async function waitForPreview() {
	await screen.findByText('Select what to include:');
}

describe('DebugPackageModal', () => {
	beforeEach(() => {
		window.maestro.debug = {
			previewPackage: vi.fn(),
			createPackage: vi.fn(),
		};
		window.maestro.process = {
			...originalProcess,
			runCommand: vi.fn(),
		};
		vi.mocked(window.maestro.debug.previewPackage).mockResolvedValue({
			categories: previewCategories,
		});
		vi.mocked(window.maestro.debug.createPackage).mockResolvedValue({
			success: true,
			path: '/tmp/maestro-debug.zip',
		});
		vi.mocked(window.maestro.process.runCommand).mockResolvedValue({
			success: true,
			output: '',
			error: '',
			exitCode: 0,
		});
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: {
				writeText: vi.fn().mockResolvedValue(undefined),
			},
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.restoreAllMocks();
		window.maestro.debug = originalDebug;
		window.maestro.process = originalProcess;
		if (originalClipboard) {
			Object.defineProperty(navigator, 'clipboard', {
				configurable: true,
				value: originalClipboard,
			});
		} else {
			Reflect.deleteProperty(navigator, 'clipboard');
		}
	});

	it('does not render or load a preview while closed', () => {
		renderModal({ isOpen: false });

		expect(screen.queryByText('Create Debug Package')).not.toBeInTheDocument();
		expect(window.maestro.debug.previewPackage).not.toHaveBeenCalled();
	});

	it('loads preview categories and disables generation when nothing is selected', async () => {
		renderModal();

		expect(screen.getByTestId('loader-icon')).toBeInTheDocument();
		await waitForPreview();

		expect(window.maestro.debug.previewPackage).toHaveBeenCalledTimes(1);
		expect(screen.getByText('5 of 5 selected')).toBeInTheDocument();
		expect(screen.getByText('System Logs')).toBeInTheDocument();
		expect(screen.getByText('Error States')).toBeInTheDocument();
		expect(
			screen.getByText(/This package does NOT include your conversations/)
		).toBeInTheDocument();

		for (const checkbox of screen.getAllByRole('checkbox')) {
			fireEvent.click(checkbox);
		}

		expect(screen.getByText('0 of 5 selected')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Generate Package' })).toBeDisabled();
	});

	it('maps selected categories to createPackage options and shows success actions', async () => {
		renderModal();
		await waitForPreview();

		const [logsCheckbox, errorsCheckbox] = screen.getAllByRole('checkbox');
		fireEvent.click(logsCheckbox);
		fireEvent.click(errorsCheckbox);
		fireEvent.click(screen.getByRole('button', { name: 'Generate Package' }));

		await screen.findByText('Package created successfully!');

		expect(window.maestro.debug.createPackage).toHaveBeenCalledWith({
			includeLogs: false,
			includeErrors: false,
			includeSessions: true,
			includeGroupChats: true,
			includeBatchState: true,
		});
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'success',
				title: 'Debug Package Created',
				message: 'Package saved to /tmp/maestro-debug.zip',
			})
		);
		expect(screen.getByText('/tmp/maestro-debug.zip')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Copy file path to clipboard'));
		await waitFor(() =>
			expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/tmp/maestro-debug.zip')
		);
		expect(flashCopiedToClipboard).toHaveBeenCalledWith(
			'/tmp/maestro-debug.zip',
			'File Path Copied'
		);

		fireEvent.click(screen.getByRole('button', { name: 'Show in Finder' }));
		expect(window.maestro.process.runCommand).toHaveBeenCalledWith({
			sessionId: 'debug-package',
			command: 'open -R "/tmp/maestro-debug.zip"',
			cwd: '/',
			shell: '/bin/bash',
		});
	});

	it('defaults missing preview categories to included createPackage options', async () => {
		vi.mocked(window.maestro.debug.previewPackage).mockResolvedValue({
			categories: [
				{ id: 'system', name: 'System Information', included: true, sizeEstimate: '< 1 KB' },
			],
		});
		renderModal();
		await waitForPreview();

		fireEvent.click(screen.getByRole('button', { name: 'Generate Package' }));

		await screen.findByText('Package created successfully!');
		expect(window.maestro.debug.createPackage).toHaveBeenCalledWith({
			includeLogs: true,
			includeErrors: true,
			includeSessions: true,
			includeGroupChats: true,
			includeBatchState: true,
		});
	});

	it('returns to idle state when package generation is cancelled', async () => {
		vi.mocked(window.maestro.debug.createPackage).mockResolvedValue({ cancelled: true });
		renderModal();
		await waitForPreview();

		fireEvent.click(screen.getByRole('button', { name: 'Generate Package' }));
		await waitFor(() =>
			expect(screen.getByRole('button', { name: 'Generate Package' })).toBeEnabled()
		);

		expect(screen.queryByText('Package created successfully!')).not.toBeInTheDocument();
		expect(notifyToast).not.toHaveBeenCalled();
	});

	it('uses fallback categories when preview loading fails', async () => {
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
		vi.mocked(window.maestro.debug.previewPackage).mockRejectedValue(new Error('preview failed'));
		renderModal();

		await screen.findByText('System Information');

		expect(loggerError).toHaveBeenCalledWith(
			'[DebugPackageModal] Failed to load preview:',
			undefined,
			expect.any(Error)
		);
		expect(screen.getByText('8 of 8 selected')).toBeInTheDocument();
	});

	it('shows result errors from createPackage and reports them', async () => {
		vi.mocked(window.maestro.debug.createPackage).mockResolvedValue({
			success: false,
			error: 'Disk is full',
		});
		renderModal();
		await waitForPreview();

		fireEvent.click(screen.getByRole('button', { name: 'Generate Package' }));

		expect(await screen.findByText('Failed to create package')).toBeInTheDocument();
		expect(screen.getByText('Disk is full')).toBeInTheDocument();
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'error',
				title: 'Debug Package Failed',
				message: 'Disk is full',
			})
		);
	});

	it('uses fallback result error messages when createPackage returns no error', async () => {
		vi.mocked(window.maestro.debug.createPackage).mockResolvedValue({
			success: false,
		});
		renderModal();
		await waitForPreview();

		fireEvent.click(screen.getByRole('button', { name: 'Generate Package' }));

		expect(await screen.findByText('Failed to create package')).toBeInTheDocument();
		expect(screen.getByText('Unknown error occurred')).toBeInTheDocument();
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'error',
				title: 'Debug Package Failed',
				message: 'Failed to create debug package',
			})
		);
	});

	it('shows thrown generation errors and logs the original exception', async () => {
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
		vi.mocked(window.maestro.debug.createPackage).mockRejectedValue(new Error('zip failed'));
		renderModal();
		await waitForPreview();

		fireEvent.click(screen.getByRole('button', { name: 'Generate Package' }));

		expect(await screen.findByText('zip failed')).toBeInTheDocument();
		expect(loggerError).toHaveBeenCalledWith(
			'[DebugPackageModal] Generation failed:',
			undefined,
			expect.any(Error)
		);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'error',
				title: 'Debug Package Failed',
				message: 'zip failed',
			})
		);
	});

	it('uses fallback thrown-error messages for non-Error rejections', async () => {
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
		vi.mocked(window.maestro.debug.createPackage).mockRejectedValue('zip failed');
		renderModal();
		await waitForPreview();

		fireEvent.click(screen.getByRole('button', { name: 'Generate Package' }));

		expect(await screen.findByText('Unknown error')).toBeInTheDocument();
		expect(loggerError).toHaveBeenCalledWith(
			'[DebugPackageModal] Generation failed:',
			undefined,
			'zip failed'
		);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'error',
				title: 'Debug Package Failed',
				message: 'Failed to create debug package',
			})
		);
	});
});
