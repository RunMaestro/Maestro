import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BackupTab } from '../../../../renderer/components/CueModal/BackupTab';
import { mockTheme } from '../../../helpers/mockTheme';
import type { CueBackupSummary } from '../../../../shared/cue-backup-types';

const mocks = vi.hoisted(() => ({
	cueBackupService: {
		create: vi.fn(),
		list: vi.fn(),
		getDiffStatus: vi.fn(),
		delete: vi.fn(),
		restoreAll: vi.fn(),
		restoreFile: vi.fn(),
		readFile: vi.fn(),
		readLive: vi.fn(),
	},
	showConfirmation: vi.fn((_message: string, onConfirm: () => Promise<void> | void) => onConfirm()),
	notifyToast: vi.fn(),
	captureException: vi.fn(),
}));

vi.mock('../../../../renderer/services/cueBackup', () => ({
	cueBackupService: mocks.cueBackupService,
}));

vi.mock('../../../../renderer/stores/modalStore', () => ({
	getModalActions: () => ({
		showConfirmation: mocks.showConfirmation,
	}),
}));

vi.mock('../../../../renderer/stores/notificationStore', () => ({
	notifyToast: mocks.notifyToast,
}));

vi.mock('../../../../renderer/utils/sentry', () => ({
	captureException: mocks.captureException,
}));

vi.mock('../../../../renderer/components/GitDiffViewer', () => ({
	GitDiffViewer: ({
		title,
		diffText,
		onClose,
	}: {
		title: string;
		diffText: string;
		onClose: () => void;
	}) => (
		<div data-testid="git-diff-viewer">
			<h2>{title}</h2>
			<pre>{diffText}</pre>
			<button type="button" onClick={onClose}>
				Close diff
			</button>
		</div>
	),
}));

const backup: CueBackupSummary = {
	filePath: '/user-data/cue-backups/cue-backup.zip',
	fileName: 'cue-backup.zip',
	size: 2048,
	manifest: {
		version: 1,
		createdAt: '2026-06-18T12:00:00Z',
		appVersion: '0.17.1',
		workspaces: [
			{
				id: 'workspace-1',
				cwd: '/repo/maestro',
				agents: [{ id: 'agent-1', name: 'Codex', toolType: 'codex' }],
				files: [
					{ relativePath: 'cue.yaml', size: 32 },
					{ relativePath: 'prompts/review.md', size: 64 },
				],
			},
		],
	},
};

function renderBackupTab() {
	render(<BackupTab theme={mockTheme} />);
}

describe('BackupTab', () => {
	beforeEach(() => {
		mocks.cueBackupService.list.mockResolvedValue([backup]);
		mocks.cueBackupService.create.mockResolvedValue(backup);
		mocks.cueBackupService.getDiffStatus.mockResolvedValue({
			'workspace-1::cue.yaml': 'changed',
			'workspace-1::prompts/review.md': 'missing-live',
		});
		mocks.cueBackupService.restoreAll.mockResolvedValue({ written: 2, skipped: [] });
		mocks.cueBackupService.restoreFile.mockResolvedValue(undefined);
		mocks.cueBackupService.delete.mockResolvedValue(undefined);
		mocks.cueBackupService.readFile.mockResolvedValue('backup cue');
		mocks.cueBackupService.readLive.mockResolvedValue('live cue');
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('loads backups, expands files, and opens a synthetic diff', async () => {
		renderBackupTab();

		expect(screen.getByText(/Loading backups/)).toBeInTheDocument();
		expect(await screen.findByText('cue-backup.zip')).toBeInTheDocument();

		fireEvent.click(screen.getByLabelText('Expand'));

		expect(await screen.findByText('/repo/maestro')).toBeInTheDocument();
		expect(await screen.findByText('cue.yaml')).toBeInTheDocument();
		await waitFor(() =>
			expect(mocks.cueBackupService.getDiffStatus).toHaveBeenCalledWith(backup.filePath)
		);

		fireEvent.click(screen.getAllByTitle('Diff backup vs live file')[0]);

		await waitFor(() =>
			expect(mocks.cueBackupService.readFile).toHaveBeenCalledWith(
				backup.filePath,
				'workspace-1',
				'cue.yaml'
			)
		);
		expect(screen.getByTestId('git-diff-viewer')).toHaveTextContent('Backup vs live');
		expect(screen.getByTestId('git-diff-viewer')).toHaveTextContent('cue.yaml');
		expect(screen.getByTestId('git-diff-viewer')).toHaveTextContent(
			'diff --git a/cue.yaml b/cue.yaml'
		);
	});

	it('creates, restores, and deletes backups through confirmed actions', async () => {
		renderBackupTab();

		expect(await screen.findByText('cue-backup.zip')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Create Backup' }));
		await waitFor(() => expect(mocks.cueBackupService.create).toHaveBeenCalledTimes(1));
		expect(mocks.notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Backup created', color: 'green' })
		);

		fireEvent.click(screen.getByLabelText('Expand'));
		await screen.findByText('cue.yaml');

		fireEvent.click(screen.getByTitle('Restore all files in this backup'));
		await waitFor(() =>
			expect(mocks.cueBackupService.restoreAll).toHaveBeenCalledWith(backup.filePath)
		);

		fireEvent.click(screen.getAllByTitle('Restore this file from backup')[0]);
		await waitFor(() =>
			expect(mocks.cueBackupService.restoreFile).toHaveBeenCalledWith(
				backup.filePath,
				'workspace-1',
				'cue.yaml'
			)
		);

		fireEvent.click(screen.getByTitle('Delete this backup zip'));
		await waitFor(() =>
			expect(mocks.cueBackupService.delete).toHaveBeenCalledWith(backup.filePath)
		);
		expect(mocks.showConfirmation).toHaveBeenCalledTimes(3);
	});

	it('renders the empty state and reports create failures', async () => {
		mocks.cueBackupService.list.mockResolvedValue([]);
		mocks.cueBackupService.create.mockRejectedValue(new Error('Disk full'));

		renderBackupTab();

		expect(await screen.findByText(/No backups yet/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Create Backup' }));

		await waitFor(() =>
			expect(mocks.notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Backup failed', message: 'Disk full', color: 'red' })
			)
		);
		expect(mocks.captureException).toHaveBeenCalledWith(
			expect.any(Error),
			expect.objectContaining({ extra: { context: 'BackupTab.handleCreate' } })
		);
	});
});
