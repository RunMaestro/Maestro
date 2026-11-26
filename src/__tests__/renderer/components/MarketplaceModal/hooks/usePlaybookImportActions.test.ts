import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlaybookImportActions } from '../../../../../renderer/components/MarketplaceModal/hooks';
import { makePlaybook } from '../_fixtures';
import { AGENT_MODES } from '../../../../helpers/mockSession';
import { browseAndPick, MODE_REMOTE_ID, resetPathPicker } from '../../../../helpers/pathPicker';
import {
	UNRESOLVED_REMOTE_MESSAGE,
	usePathPickerStore,
} from '../../../../../renderer/services/pathPicker';

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

	it('an SSH agent with no remote resolved yet fails the import loudly and writes nothing', async () => {
		const result = setup({ sshRemoteId: null });

		await act(async () => {
			await result.result.current.handleImport();
		});

		expect(result.importPlaybook).not.toHaveBeenCalled();
		expect(result.onImportComplete).not.toHaveBeenCalled();
		expect(notifyToastMock).toHaveBeenCalledWith({
			color: 'red',
			title: 'Import failed',
			message: UNRESOLVED_REMOTE_MESSAGE,
			dismissible: true,
		});
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

	// The import target is a folder name inside the Auto Run folder. The import refuses a path, so
	// Browse must never put the picked folder's full path in the field.
	it('updates the target folder name from local browse', async () => {
		vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue('/autorun/folder');
		const result = setup();

		await act(async () => {
			await result.result.current.handleBrowseFolder();
		});

		expect(window.maestro.dialog.selectFolder).toHaveBeenCalledTimes(1);
		expect(result.setTargetFolderName).toHaveBeenCalledWith('folder');
	});

	it.each(AGENT_MODES)(
		'%s: browses for the folder where the import lands, starting in the Auto Run folder',
		async (mode) => {
			const result = setup({ sshRemoteId: mode === 'local' ? undefined : MODE_REMOTE_ID });

			await browseAndPick(
				mode,
				() => {
					void result.result.current.handleBrowseFolder();
					if (mode !== 'local') {
						expect(usePathPickerStore.getState().request).toMatchObject({ startPath: '/autorun' });
					}
				},
				'/autorun/playbooks/'
			);

			expect(result.setTargetFolderName).toHaveBeenCalledWith('playbooks');
			expect(notifyToastMock).not.toHaveBeenCalled();
			if (mode !== 'local') {
				expect(window.maestro.dialog.selectFolder).not.toHaveBeenCalled();
			}
			resetPathPicker();
		}
	);

	it.each(AGENT_MODES)(
		'%s: a pick that is not a folder directly inside the Auto Run folder is refused, with the reason',
		async (mode) => {
			const result = setup({ sshRemoteId: mode === 'local' ? undefined : MODE_REMOTE_ID });
			const browse = () => void result.result.current.handleBrowseFolder();

			// Elsewhere, the Auto Run folder itself, a folder two levels down, and a sibling whose
			// name only starts the same.
			for (const picked of ['/picked/playbooks', '/autorun', '/autorun/a/b', '/autorun-old/a']) {
				await browseAndPick(mode, browse, picked);
			}

			expect(result.setTargetFolderName).not.toHaveBeenCalled();
			expect(notifyToastMock).toHaveBeenCalledTimes(4);
			expect(notifyToastMock).toHaveBeenLastCalledWith(
				expect.objectContaining({
					color: 'orange',
					title: 'Pick a folder inside the Auto Run folder',
				})
			);
			resetPathPicker();
		}
	);

	it('reads a Windows pick inside the Auto Run folder as its folder name', async () => {
		vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue(
			'C:\\Users\\me\\autorun\\security'
		);
		const result = setup({ autoRunFolderPath: 'C:\\Users\\me\\autorun' });

		await act(async () => {
			await result.result.current.handleBrowseFolder();
		});

		expect(result.setTargetFolderName).toHaveBeenCalledWith('security');
	});
});
