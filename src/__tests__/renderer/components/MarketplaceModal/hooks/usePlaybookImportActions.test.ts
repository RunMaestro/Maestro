import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlaybookImportActions } from '../../../../../renderer/components/MarketplaceModal/hooks';
import { makePlaybook } from '../_fixtures';

const notifyToastMock = vi.fn();
const loggerErrorMock = vi.fn();

vi.mock('../../../../../renderer/stores/notificationStore', () => ({
	notifyToast: (...args: unknown[]) => notifyToastMock(...args),
}));

vi.mock('../../../../../renderer/utils/logger', () => ({
	logger: {
		error: (...args: unknown[]) => loggerErrorMock(...args),
	},
}));

function setup(overrides: Partial<Parameters<typeof usePlaybookImportActions>[0]> = {}) {
	const importPlaybook = vi.fn().mockResolvedValue({ success: true });
	const onImportComplete = vi.fn();
	const onClose = vi.fn();
	const setTargetFolderName = vi.fn();
	const params = {
		selectedPlaybook: makePlaybook({ id: 'playbook-1' }),
		targetFolderName: 'target-folder',
		autoRunFolderPath: '/autorun',
		sessionId: 'session-1',
		sshRemoteId: undefined,
		isRemoteSession: false,
		importPlaybook,
		onImportComplete,
		onClose,
		setTargetFolderName,
		...overrides,
	};

	const hook = renderHook(() => usePlaybookImportActions(params));

	return {
		...hook,
		importPlaybook,
		onImportComplete,
		onClose,
		setTargetFolderName,
		params,
	};
}

describe('usePlaybookImportActions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue('/picked/folder');
	});

	it('imports the selected playbook with local arguments and closes on success', async () => {
		const result = setup();

		await act(async () => {
			await result.result.current.handleImport();
		});

		expect(result.importPlaybook).toHaveBeenCalledWith(
			result.params.selectedPlaybook,
			'target-folder',
			'/autorun',
			'session-1',
			undefined
		);
		expect(result.onImportComplete).toHaveBeenCalledWith('target-folder');
		expect(result.onClose).toHaveBeenCalledTimes(1);
	});

	it('forwards sshRemoteId for remote imports', async () => {
		const result = setup({ sshRemoteId: 'remote-1', isRemoteSession: true });

		await act(async () => {
			await result.result.current.handleImport();
		});

		expect(result.importPlaybook).toHaveBeenCalledWith(
			result.params.selectedPlaybook,
			'target-folder',
			'/autorun',
			'session-1',
			'remote-1'
		);
	});

	it('does nothing without a selected playbook or folder name', async () => {
		let result = setup({ selectedPlaybook: null });
		await act(async () => {
			await result.result.current.handleImport();
		});
		expect(result.importPlaybook).not.toHaveBeenCalled();
		result.unmount();

		result = setup({ targetFolderName: '   ' });
		await act(async () => {
			await result.result.current.handleImport();
		});
		expect(result.importPlaybook).not.toHaveBeenCalled();
	});

	it('logs and shows a sticky toast when import fails', async () => {
		const result = setup({
			importPlaybook: vi.fn().mockResolvedValue({ success: false, error: 'Nope' }),
		});

		await act(async () => {
			await result.result.current.handleImport();
		});

		expect(loggerErrorMock).toHaveBeenCalledWith('Import failed:', undefined, 'Nope');
		expect(notifyToastMock).toHaveBeenCalledWith({
			color: 'red',
			title: 'Import failed',
			message: 'Nope',
			dismissible: true,
		});
		expect(result.onClose).not.toHaveBeenCalled();
	});

	it('updates the target folder from local browse', async () => {
		const result = setup();

		await act(async () => {
			await result.result.current.handleBrowseFolder();
		});

		expect(window.maestro.dialog.selectFolder).toHaveBeenCalledTimes(1);
		expect(result.setTargetFolderName).toHaveBeenCalledWith('/picked/folder');
	});

	it('does not browse folders for remote sessions', async () => {
		const result = setup({ isRemoteSession: true });

		await act(async () => {
			await result.result.current.handleBrowseFolder();
		});

		expect(window.maestro.dialog.selectFolder).not.toHaveBeenCalled();
		expect(result.setTargetFolderName).not.toHaveBeenCalled();
	});
});
