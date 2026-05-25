/**
 * @file DebugWizardModal.test.tsx
 * @description Tests for the debug wizard shortcut modal.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DebugWizardModal } from '../../../renderer/components/DebugWizardModal';
import {
	WizardProvider,
	useWizard,
	type WizardState,
} from '../../../renderer/components/Wizard/WizardContext';
import type { Theme } from '../../../renderer/types';

vi.mock('lucide-react', () => ({
	FolderOpen: ({ className }: { className?: string }) => (
		<svg data-testid="folder-open-icon" className={className} />
	),
}));

vi.mock('../../../renderer/components/ui/Modal', () => ({
	Modal: ({
		title,
		onClose,
		footer,
		children,
	}: {
		title: string;
		onClose: () => void;
		footer: React.ReactNode;
		children: React.ReactNode;
	}) => (
		<div role="dialog" aria-label={title}>
			<button onClick={onClose}>Modal close</button>
			{children}
			{footer}
		</div>
	),
	ModalFooter: ({
		onCancel,
		onConfirm,
		confirmLabel,
		confirmDisabled,
	}: {
		onCancel: () => void;
		onConfirm: () => void;
		confirmLabel: string;
		confirmDisabled?: boolean;
	}) => (
		<footer>
			<button onClick={onCancel}>Cancel</button>
			<button onClick={onConfirm} disabled={confirmDisabled}>
				{confirmLabel}
			</button>
		</footer>
	),
}));

const originalMaestro = window.maestro;
let latestWizardState: WizardState | null = null;

const mockTheme: Theme = {
	id: 'test',
	name: 'Test',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#1a1a1a',
		bgActivity: '#222222',
		border: '#333333',
		textMain: '#ffffff',
		textDim: '#999999',
		textFaint: '#666666',
		accent: '#4a9eff',
		accentForeground: '#ffffff',
		buttonBg: '#333333',
		buttonHover: '#444444',
		headerBg: '#181818',
		scrollbarTrack: '#111111',
		scrollbarThumb: '#444444',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

const setupMaestroMock = () => {
	const maestro = {
		dialog: {
			selectFolder: vi.fn().mockResolvedValue(null),
		},
		fs: {
			readDir: vi.fn(),
			readFile: vi.fn(),
		},
		settings: {
			set: vi.fn().mockResolvedValue(undefined),
		},
	};

	window.maestro = maestro as unknown as typeof window.maestro;
	return maestro;
};

function WizardStateProbe() {
	const { state } = useWizard();
	latestWizardState = state;
	return (
		<div data-testid="wizard-state">
			<span data-testid="wizard-open">{String(state.isOpen)}</span>
			<span data-testid="wizard-step">{state.currentStep}</span>
			<span data-testid="wizard-doc-count">{state.generatedDocuments.length}</span>
		</div>
	);
}

const renderModal = ({
	isOpen = true,
	onClose = vi.fn(),
}: {
	isOpen?: boolean;
	onClose?: () => void;
} = {}) => {
	const result = render(
		<WizardProvider>
			<DebugWizardModal theme={mockTheme} isOpen={isOpen} onClose={onClose} />
			<WizardStateProbe />
		</WizardProvider>
	);
	return { ...result, onClose };
};

const fillRequiredFields = (directory = '/repo/project', agentName = 'Project Agent') => {
	fireEvent.change(screen.getByPlaceholderText('/path/to/project'), {
		target: { value: directory },
	});
	fireEvent.change(screen.getByPlaceholderText('My Project'), {
		target: { value: agentName },
	});
};

describe('DebugWizardModal', () => {
	beforeEach(() => {
		latestWizardState = null;
		setupMaestroMock();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		window.maestro = originalMaestro;
	});

	it('renders nothing while closed', () => {
		renderModal({ isOpen: false });

		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		expect(screen.getByTestId('wizard-open')).toHaveTextContent('false');
	});

	it('validates directory and agent name before loading documents', async () => {
		renderModal();

		fireEvent.click(screen.getByText('Jump to Phase Review'));

		expect(await screen.findByText('Please select a directory')).toBeInTheDocument();

		fireEvent.change(screen.getByPlaceholderText('/path/to/project'), {
			target: { value: '/repo/project' },
		});
		fireEvent.click(screen.getByText('Jump to Phase Review'));

		expect(await screen.findByText('Please enter an agent name')).toBeInTheDocument();
		expect(window.maestro.fs.readDir).not.toHaveBeenCalled();
	});

	it('selects a folder and derives the agent name when the name is empty', async () => {
		const maestro = setupMaestroMock();
		maestro.dialog.selectFolder.mockResolvedValue('/tmp/My Project');
		renderModal();

		fireEvent.click(screen.getByText('Browse'));

		await waitFor(() => {
			expect(screen.getByPlaceholderText('/path/to/project')).toHaveValue('/tmp/My Project');
			expect(screen.getByPlaceholderText('My Project')).toHaveValue('My Project');
		});
	});

	it('leaves fields unchanged when folder selection is canceled', async () => {
		const maestro = setupMaestroMock();
		maestro.dialog.selectFolder.mockResolvedValue(null);
		renderModal();

		fireEvent.click(screen.getByText('Browse'));

		await waitFor(() => {
			expect(maestro.dialog.selectFolder).toHaveBeenCalledTimes(1);
		});
		expect(screen.getByPlaceholderText('/path/to/project')).toHaveValue('');
		expect(screen.getByPlaceholderText('My Project')).toHaveValue('');
	});

	it('uses fallback and platform basename handling for selected folders', async () => {
		const maestro = setupMaestroMock();
		maestro.dialog.selectFolder
			.mockResolvedValueOnce('/')
			.mockResolvedValueOnce('C:\\repo\\Win Project')
			.mockResolvedValueOnce('/tmp/Trailing Project/');
		renderModal();

		fireEvent.click(screen.getByText('Browse'));

		await waitFor(() => {
			expect(screen.getByPlaceholderText('/path/to/project')).toHaveValue('/');
			expect(screen.getByPlaceholderText('My Project')).toHaveValue('My Project');
		});

		fireEvent.change(screen.getByPlaceholderText('My Project'), { target: { value: '' } });
		fireEvent.click(screen.getByText('Browse'));

		await waitFor(() => {
			expect(screen.getByPlaceholderText('/path/to/project')).toHaveValue('C:\\repo\\Win Project');
			expect(screen.getByPlaceholderText('My Project')).toHaveValue('Win Project');
		});

		fireEvent.change(screen.getByPlaceholderText('My Project'), { target: { value: '' } });
		fireEvent.click(screen.getByText('Browse'));

		await waitFor(() => {
			expect(screen.getByPlaceholderText('/path/to/project')).toHaveValue('/tmp/Trailing Project/');
			expect(screen.getByPlaceholderText('My Project')).toHaveValue('Trailing Project');
		});
	});

	it('logs folder picker failures without changing fields', async () => {
		const maestro = setupMaestroMock();
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const failure = new Error('picker failed');
		maestro.dialog.selectFolder.mockRejectedValue(failure);
		renderModal();

		fireEvent.click(screen.getByText('Browse'));

		await waitFor(() => {
			expect(consoleError).toHaveBeenCalledWith('Failed to select directory:', failure);
		});
		expect(screen.getByPlaceholderText('/path/to/project')).toHaveValue('');
		expect(screen.getByPlaceholderText('My Project')).toHaveValue('');
	});

	it('does not overwrite an existing agent name when browsing for a folder', async () => {
		const maestro = setupMaestroMock();
		maestro.dialog.selectFolder.mockResolvedValue('/tmp/Other Project');
		renderModal();

		fireEvent.change(screen.getByPlaceholderText('My Project'), {
			target: { value: 'Pinned Name' },
		});
		fireEvent.click(screen.getByText('Browse'));

		await waitFor(() => {
			expect(screen.getByPlaceholderText('/path/to/project')).toHaveValue('/tmp/Other Project');
			expect(screen.getByPlaceholderText('My Project')).toHaveValue('Pinned Name');
		});
	});

	it('shows an Auto Run Docs folder error when the directory cannot be read', async () => {
		const maestro = setupMaestroMock();
		maestro.fs.readDir.mockRejectedValue(new Error('missing folder'));
		renderModal();
		fillRequiredFields('/repo/missing');

		fireEvent.click(screen.getByText('Jump to Phase Review'));

		expect(
			await screen.findByText('No Auto Run Docs folder found at /repo/missing/Auto Run Docs')
		).toBeInTheDocument();
		expect(screen.getByText('Jump to Phase Review')).not.toBeDisabled();
	});

	it('requires at least one markdown file in the Auto Run Docs folder', async () => {
		const maestro = setupMaestroMock();
		maestro.fs.readDir.mockResolvedValue([
			{ name: 'notes.txt', isDirectory: false },
			{ name: 'nested.md', isDirectory: true },
		]);
		renderModal();
		fillRequiredFields();

		fireEvent.click(screen.getByText('Jump to Phase Review'));

		expect(
			await screen.findByText('No markdown files found in /repo/project/Auto Run Docs')
		).toBeInTheDocument();
		expect(maestro.fs.readFile).not.toHaveBeenCalled();
	});

	it('reports failure when every markdown document is unreadable or empty', async () => {
		const maestro = setupMaestroMock();
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		maestro.fs.readDir.mockResolvedValue([
			{ name: 'Phase-01.md', isDirectory: false },
			{ name: 'Phase-02.md', isDirectory: false },
		]);
		maestro.fs.readFile
			.mockResolvedValueOnce('')
			.mockRejectedValueOnce(new Error('permission denied'));
		renderModal();
		fillRequiredFields();

		fireEvent.click(screen.getByText('Jump to Phase Review'));

		expect(await screen.findByText('Failed to load any documents')).toBeInTheDocument();
		expect(consoleWarn).toHaveBeenCalledWith('Failed to read Phase-02.md:', expect.any(Error));
	});

	it('loads markdown documents, seeds wizard state, and jumps to phase review', async () => {
		const maestro = setupMaestroMock();
		const { onClose } = renderModal();
		maestro.fs.readDir.mockResolvedValue([
			{ name: 'Phase-02.txt', isDirectory: false },
			{ name: 'Phase-01.md', isDirectory: false },
			{ name: 'Nested.md', isDirectory: true },
			{ name: 'Phase-02.md', isDirectory: false },
		]);
		maestro.fs.readFile.mockImplementation(async (path: string) => {
			if (path.endsWith('Phase-01.md')) {
				return '# Phase 1\n\n- [ ] First\n- [x] Done';
			}
			return '# Phase 2\n\nNo tasks yet';
		});
		fillRequiredFields('/repo/project', '  Debug Agent  ');

		fireEvent.click(screen.getByText('Jump to Phase Review'));

		await waitFor(() => {
			expect(onClose).toHaveBeenCalled();
			expect(screen.getByTestId('wizard-open')).toHaveTextContent('true');
			expect(screen.getByTestId('wizard-doc-count')).toHaveTextContent('2');
		});

		expect(maestro.fs.readDir).toHaveBeenCalledWith('/repo/project/Auto Run Docs');
		expect(maestro.fs.readFile).toHaveBeenCalledWith('/repo/project/Auto Run Docs/Phase-01.md');
		expect(latestWizardState).toMatchObject({
			selectedAgent: 'claude-code',
			directoryPath: '/repo/project',
			agentName: 'Debug Agent',
			generatedDocuments: [
				{
					filename: 'Phase-01.md',
					content: '# Phase 1\n\n- [ ] First\n- [x] Done',
					taskCount: 2,
				},
				{
					filename: 'Phase-02.md',
					content: '# Phase 2\n\nNo tasks yet',
					taskCount: 0,
				},
			],
		});

		await waitFor(() => {
			expect(screen.getByTestId('wizard-step')).toHaveTextContent('phase-review');
		});
	});

	it('submits with Enter and reports missing Auto Run Docs folders', async () => {
		const maestro = setupMaestroMock();
		maestro.fs.readDir.mockRejectedValue(new Error('missing folder'));
		renderModal();
		fillRequiredFields();

		fireEvent.keyDown(screen.getByText(/Must contain/).closest('div')!, { key: 'Enter' });

		expect(
			await screen.findByText('No Auto Run Docs folder found at /repo/project/Auto Run Docs')
		).toBeInTheDocument();
	});

	it('ignores non-Enter keyboard events in the form body', () => {
		const maestro = setupMaestroMock();
		renderModal();
		fillRequiredFields();

		fireEvent.keyDown(screen.getByText(/Must contain/).closest('div')!, { key: 'Escape' });

		expect(maestro.fs.readDir).not.toHaveBeenCalled();
	});

	it('reports unexpected failures that happen after documents load', async () => {
		const maestro = setupMaestroMock();
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		maestro.fs.readDir.mockResolvedValue([{ name: 'Phase-01.md', isDirectory: false }]);
		maestro.fs.readFile.mockResolvedValue('# Phase 1\n\n- [ ] First');
		const onClose = vi.fn(() => {
			throw new Error('close failed');
		});
		renderModal({ onClose });
		fillRequiredFields();

		fireEvent.click(screen.getByText('Jump to Phase Review'));

		expect(await screen.findByText('close failed')).toBeInTheDocument();
		expect(consoleError).toHaveBeenCalledWith('Failed to load documents:', expect.any(Error));
	});

	it('reports unknown errors for non-Error failures after documents load', async () => {
		class NonErrorFailure {
			constructor(readonly message: string) {}
		}

		const maestro = setupMaestroMock();
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const failure = new NonErrorFailure('close failed');
		maestro.fs.readDir.mockResolvedValue([{ name: 'Phase-01.md', isDirectory: false }]);
		maestro.fs.readFile.mockResolvedValue('# Phase 1\n\n- [ ] First');
		const onClose = vi.fn(() => {
			throw failure;
		});
		renderModal({ onClose });
		fillRequiredFields();

		fireEvent.click(screen.getByText('Jump to Phase Review'));

		expect(await screen.findByText('Unknown error')).toBeInTheDocument();
		expect(consoleError).toHaveBeenCalledWith('Failed to load documents:', failure);
	});
});
