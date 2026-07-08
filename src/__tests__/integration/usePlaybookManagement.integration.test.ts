import { act, fireEvent, renderHook, waitFor } from '@testing-library/react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BatchDocumentEntry, Playbook } from '../../renderer/types';
import {
	usePlaybookManagement,
	type PlaybookConfigState,
	type UsePlaybookManagementDeps,
} from '../../renderer/hooks/batch/usePlaybookManagement';
import { DEFAULT_BATCH_PROMPT } from '../../renderer/hooks/batch/batchUtils';
import { logger } from '../../renderer/utils/logger';

vi.mock('../../renderer/utils/logger', () => ({
	logger: {
		error: vi.fn(),
	},
}));

const baseDocuments: BatchDocumentEntry[] = [
	{
		id: 'doc-1',
		filename: 'existing.md',
		resetOnCompletion: false,
		isDuplicate: false,
	},
];

const baseConfig: PlaybookConfigState = {
	documents: baseDocuments,
	loopEnabled: false,
	maxLoops: null,
	prompt: DEFAULT_BATCH_PROMPT,
	taskSelectionMode: 'task',
};

function makePlaybook(overrides: Partial<Playbook> = {}): Playbook {
	return {
		id: 'playbook-1',
		name: 'Saved Playbook',
		createdAt: 1,
		updatedAt: 2,
		documents: [{ filename: 'existing.md', resetOnCompletion: false }],
		loopEnabled: false,
		maxLoops: null,
		prompt: DEFAULT_BATCH_PROMPT,
		...overrides,
	};
}

function makeDeps(overrides: Partial<UsePlaybookManagementDeps> = {}): UsePlaybookManagementDeps {
	return {
		sessionId: 'session-1',
		folderPath: '/repo/docs',
		allDocuments: ['existing.md'],
		config: baseConfig,
		onApplyPlaybook: vi.fn(),
		...overrides,
	};
}

type PlaybookManagementResult = ReturnType<typeof usePlaybookManagement>;

async function waitForPlaybooksToLoad(result: { current: PlaybookManagementResult }) {
	await waitFor(() => {
		expect(result.current.loadingPlaybooks).toBe(false);
	});
}

describe('usePlaybookManagement', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.playbooks.list).mockResolvedValue({
			success: true,
			playbooks: [],
		});
		vi.mocked(window.maestro.playbooks.create).mockResolvedValue({
			success: true,
			playbook: makePlaybook({ id: 'created-playbook', name: 'Created' }),
		});
		vi.mocked(window.maestro.playbooks.update).mockResolvedValue({
			success: true,
			playbook: makePlaybook({ name: 'Updated' }),
		});
		vi.mocked(window.maestro.playbooks.delete).mockResolvedValue({ success: true });
		vi.mocked(window.maestro.playbooks.export).mockResolvedValue({ success: true });
		vi.mocked(window.maestro.playbooks.import).mockResolvedValue({ success: true });
	});

	it('keeps an empty playbook list when loading returns an unsuccessful result', async () => {
		vi.mocked(window.maestro.playbooks.list).mockResolvedValueOnce({
			success: false,
			playbooks: [makePlaybook()],
		});

		const { result } = renderHook(
			(deps: UsePlaybookManagementDeps) => usePlaybookManagement(deps),
			{
				initialProps: makeDeps(),
			}
		);

		await waitForPlaybooksToLoad(result);

		expect(result.current.playbooks).toEqual([]);
	});

	it('logs load failures and clears loading state', async () => {
		const consoleError = vi.mocked(logger.error);
		vi.mocked(window.maestro.playbooks.list).mockRejectedValueOnce(new Error('load failed'));

		const { result } = renderHook(
			(deps: UsePlaybookManagementDeps) => usePlaybookManagement(deps),
			{
				initialProps: makeDeps(),
			}
		);

		try {
			await waitForPlaybooksToLoad(result);

			expect(consoleError).toHaveBeenCalledWith(
				'Failed to load playbooks:',
				undefined,
				expect.any(Error)
			);
			expect(result.current.playbooks).toEqual([]);
		} finally {
			consoleError.mockClear();
		}
	});

	it('loads playbooks with duplicate and missing document markers and default prompt fallback', async () => {
		const onApplyPlaybook = vi.fn();
		const playbook = makePlaybook({
			documents: [
				{ filename: 'existing.md', resetOnCompletion: false },
				{ filename: 'existing.md', resetOnCompletion: true },
				{ filename: 'missing.md', resetOnCompletion: false },
			],
			loopEnabled: true,
			maxLoops: undefined,
			prompt: '   ',
		});

		const { result } = renderHook(
			(deps: UsePlaybookManagementDeps) => usePlaybookManagement(deps),
			{
				initialProps: makeDeps({ onApplyPlaybook }),
			}
		);
		await waitForPlaybooksToLoad(result);

		act(() => {
			result.current.handleLoadPlaybook(playbook);
		});

		expect(onApplyPlaybook).toHaveBeenCalledWith({
			documents: [
				expect.objectContaining({
					filename: 'existing.md',
					resetOnCompletion: false,
					isDuplicate: false,
					isMissing: false,
				}),
				expect.objectContaining({
					filename: 'existing.md',
					resetOnCompletion: true,
					isDuplicate: true,
					isMissing: false,
				}),
				expect.objectContaining({
					filename: 'missing.md',
					resetOnCompletion: false,
					isDuplicate: false,
					isMissing: true,
				}),
			],
			loopEnabled: true,
			maxLoops: null,
			prompt: DEFAULT_BATCH_PROMPT,
			taskSelectionMode: 'task',
		});
		expect(result.current.showPlaybookDropdown).toBe(false);
	});

	it('detects document length, loop, and max-loop changes against a loaded playbook', async () => {
		const playbook = makePlaybook({ loopEnabled: false, maxLoops: 3 });
		const matchingConfig: PlaybookConfigState = {
			documents: baseDocuments,
			loopEnabled: false,
			maxLoops: 3,
			prompt: DEFAULT_BATCH_PROMPT,
			taskSelectionMode: 'task',
		};
		const { result, rerender } = renderHook(
			(deps: UsePlaybookManagementDeps) => usePlaybookManagement(deps),
			{ initialProps: makeDeps({ config: matchingConfig }) }
		);
		await waitForPlaybooksToLoad(result);

		act(() => {
			result.current.handleLoadPlaybook(playbook);
		});
		expect(result.current.isPlaybookModified).toBe(false);

		rerender(
			makeDeps({
				config: {
					...matchingConfig,
					documents: [...baseDocuments, { ...baseDocuments[0], id: 'doc-2' }],
				},
			})
		);
		expect(result.current.isPlaybookModified).toBe(true);

		rerender(makeDeps({ config: { ...matchingConfig, loopEnabled: true } }));
		expect(result.current.isPlaybookModified).toBe(true);

		rerender(makeDeps({ config: { ...matchingConfig, maxLoops: 4 } }));
		expect(result.current.isPlaybookModified).toBe(true);
	});

	it('detects same-length document changes and closes the dropdown on outside click', async () => {
		const playbook = makePlaybook();
		const changedDocumentConfig: PlaybookConfigState = {
			...baseConfig,
			documents: [
				{
					...baseDocuments[0],
					resetOnCompletion: true,
				},
			],
		};

		const { result, rerender } = renderHook(
			(deps: UsePlaybookManagementDeps) => usePlaybookManagement(deps),
			{
				initialProps: makeDeps(),
			}
		);
		await waitForPlaybooksToLoad(result);

		act(() => {
			result.current.handleLoadPlaybook(playbook);
		});

		rerender(makeDeps({ config: changedDocumentConfig }));
		expect(result.current.isPlaybookModified).toBe(true);

		act(() => {
			result.current.setShowPlaybookDropdown(true);
		});
		expect(result.current.showPlaybookDropdown).toBe(true);

		fireEvent.mouseDown(document.body);

		await waitFor(() => {
			expect(result.current.showPlaybookDropdown).toBe(false);
		});
	});

	it('ignores delete confirmation without a selected playbook and clears a loaded deleted playbook', async () => {
		const loaded = makePlaybook();
		const other = makePlaybook({ id: 'other-playbook', name: 'Other' });
		vi.mocked(window.maestro.playbooks.list).mockResolvedValueOnce({
			success: true,
			playbooks: [loaded, other],
		});

		const { result } = renderHook(
			(deps: UsePlaybookManagementDeps) => usePlaybookManagement(deps),
			{
				initialProps: makeDeps(),
			}
		);
		await waitForPlaybooksToLoad(result);

		await act(async () => {
			await result.current.handleConfirmDeletePlaybook();
		});
		expect(window.maestro.playbooks.delete).not.toHaveBeenCalled();

		act(() => {
			result.current.handleLoadPlaybook(loaded);
			result.current.handleDeletePlaybook(loaded, {
				stopPropagation: vi.fn(),
			} as unknown as ReactMouseEvent);
		});
		await act(async () => {
			await result.current.handleConfirmDeletePlaybook();
		});

		expect(window.maestro.playbooks.delete).toHaveBeenCalledWith('session-1', loaded.id);
		expect(result.current.playbooks).toEqual([other]);
		expect(result.current.loadedPlaybook).toBeNull();
		expect(result.current.showDeleteConfirmModal).toBe(false);
		expect(result.current.playbookToDelete).toBeNull();
	});

	it('keeps playbooks and loaded state when delete returns an unsuccessful result', async () => {
		const loaded = makePlaybook();
		const other = makePlaybook({ id: 'other-playbook', name: 'Other' });
		vi.mocked(window.maestro.playbooks.list).mockResolvedValueOnce({
			success: true,
			playbooks: [loaded, other],
		});
		vi.mocked(window.maestro.playbooks.delete).mockResolvedValueOnce({ success: false });

		const { result } = renderHook(
			(deps: UsePlaybookManagementDeps) => usePlaybookManagement(deps),
			{
				initialProps: makeDeps(),
			}
		);
		await waitForPlaybooksToLoad(result);

		act(() => {
			result.current.handleLoadPlaybook(loaded);
			result.current.handleDeletePlaybook(loaded, {
				stopPropagation: vi.fn(),
			} as unknown as ReactMouseEvent);
		});
		await act(async () => {
			await result.current.handleConfirmDeletePlaybook();
		});

		expect(window.maestro.playbooks.delete).toHaveBeenCalledWith('session-1', loaded.id);
		expect(result.current.playbooks).toEqual([loaded, other]);
		expect(result.current.loadedPlaybook).toEqual(loaded);
		expect(result.current.showDeleteConfirmModal).toBe(false);
		expect(result.current.playbookToDelete).toBeNull();
	});

	it('keeps the loaded playbook when deleting a different playbook and logs delete failures', async () => {
		const consoleError = vi.mocked(logger.error);
		const loaded = makePlaybook();
		const other = makePlaybook({ id: 'other-playbook', name: 'Other' });
		vi.mocked(window.maestro.playbooks.list).mockResolvedValueOnce({
			success: true,
			playbooks: [loaded, other],
		});
		vi.mocked(window.maestro.playbooks.delete)
			.mockResolvedValueOnce({ success: true })
			.mockRejectedValueOnce(new Error('delete failed'));

		const { result } = renderHook(
			(deps: UsePlaybookManagementDeps) => usePlaybookManagement(deps),
			{
				initialProps: makeDeps(),
			}
		);
		await waitForPlaybooksToLoad(result);

		try {
			act(() => {
				result.current.handleLoadPlaybook(loaded);
				result.current.handleDeletePlaybook(other, {
					stopPropagation: vi.fn(),
				} as unknown as ReactMouseEvent);
			});
			await act(async () => {
				await result.current.handleConfirmDeletePlaybook();
			});

			expect(result.current.playbooks).toEqual([loaded]);
			expect(result.current.loadedPlaybook).toEqual(loaded);

			act(() => {
				result.current.handleDeletePlaybook(loaded, {
					stopPropagation: vi.fn(),
				} as unknown as ReactMouseEvent);
			});
			await act(async () => {
				await result.current.handleConfirmDeletePlaybook();
			});

			expect(consoleError).toHaveBeenCalledWith(
				'Failed to delete playbook:',
				undefined,
				expect.any(Error)
			);
			expect(result.current.showDeleteConfirmModal).toBe(false);
			expect(result.current.playbookToDelete).toBeNull();
		} finally {
			consoleError.mockClear();
		}
	});

	it('clears pending delete state when canceling delete confirmation', async () => {
		const playbook = makePlaybook();
		const { result } = renderHook(
			(deps: UsePlaybookManagementDeps) => usePlaybookManagement(deps),
			{
				initialProps: makeDeps(),
			}
		);
		await waitForPlaybooksToLoad(result);

		act(() => {
			result.current.handleDeletePlaybook(playbook, {
				stopPropagation: vi.fn(),
			} as unknown as ReactMouseEvent);
		});
		expect(result.current.showDeleteConfirmModal).toBe(true);
		expect(result.current.playbookToDelete).toEqual(playbook);

		act(() => {
			result.current.handleCancelDeletePlaybook();
		});

		expect(result.current.showDeleteConfirmModal).toBe(false);
		expect(result.current.playbookToDelete).toBeNull();
	});

	it('handles export failures, cancellations, and thrown errors', async () => {
		const consoleError = vi.mocked(logger.error);
		const playbook = makePlaybook();
		vi.mocked(window.maestro.playbooks.export)
			.mockResolvedValueOnce({ success: false, error: 'disk full' })
			.mockResolvedValueOnce({ success: false, error: 'Export cancelled' })
			.mockRejectedValueOnce(new Error('export failed'));

		const { result } = renderHook(
			(deps: UsePlaybookManagementDeps) => usePlaybookManagement(deps),
			{
				initialProps: makeDeps(),
			}
		);
		await waitForPlaybooksToLoad(result);

		try {
			await act(async () => {
				await result.current.handleExportPlaybook(playbook);
				await result.current.handleExportPlaybook(playbook);
				await result.current.handleExportPlaybook(playbook);
			});

			expect(window.maestro.playbooks.export).toHaveBeenCalledWith(
				'session-1',
				playbook.id,
				'/repo/docs'
			);
			expect(consoleError).toHaveBeenCalledWith(
				'Failed to export playbook:',
				undefined,
				'disk full'
			);
			expect(consoleError).toHaveBeenCalledWith(
				'Failed to export playbook:',
				undefined,
				expect.any(Error)
			);
			expect(consoleError).toHaveBeenCalledTimes(2);
		} finally {
			consoleError.mockClear();
		}
	});

	it('imports successful playbooks and logs import failures except cancellations', async () => {
		const consoleError = vi.mocked(logger.error);
		const onApplyPlaybook = vi.fn();
		const imported = makePlaybook({ id: 'imported-playbook', name: 'Imported' });
		vi.mocked(window.maestro.playbooks.import)
			.mockResolvedValueOnce({ success: true, playbook: imported })
			.mockResolvedValueOnce({ success: false, error: 'bad file' })
			.mockResolvedValueOnce({ success: false, error: 'Import cancelled' })
			.mockRejectedValueOnce(new Error('import failed'));

		const { result } = renderHook(
			(deps: UsePlaybookManagementDeps) => usePlaybookManagement(deps),
			{
				initialProps: makeDeps({ onApplyPlaybook }),
			}
		);
		await waitForPlaybooksToLoad(result);

		try {
			await act(async () => {
				await result.current.handleImportPlaybook();
			});
			expect(result.current.playbooks).toEqual([imported]);
			expect(result.current.loadedPlaybook).toEqual(imported);
			expect(onApplyPlaybook).toHaveBeenCalled();

			await act(async () => {
				await result.current.handleImportPlaybook();
				await result.current.handleImportPlaybook();
				await result.current.handleImportPlaybook();
			});

			expect(consoleError).toHaveBeenCalledWith(
				'Failed to import playbook:',
				undefined,
				'bad file'
			);
			expect(consoleError).toHaveBeenCalledWith(
				'Failed to import playbook:',
				undefined,
				expect.any(Error)
			);
			expect(consoleError).toHaveBeenCalledTimes(2);
		} finally {
			consoleError.mockClear();
		}
	});

	it('does not start a second save while a playbook save is already running', async () => {
		let resolveCreate: (value: { success: true; playbook: Playbook }) => void = () => {};
		const createPromise = new Promise<{ success: true; playbook: Playbook }>((resolve) => {
			resolveCreate = resolve;
		});
		vi.mocked(window.maestro.playbooks.create).mockReturnValueOnce(createPromise);

		const { result } = renderHook(
			(deps: UsePlaybookManagementDeps) => usePlaybookManagement(deps),
			{
				initialProps: makeDeps(),
			}
		);
		await waitForPlaybooksToLoad(result);

		let firstSave: Promise<void>;
		act(() => {
			firstSave = result.current.handleSaveAsPlaybook('Draft');
		});
		await waitFor(() => {
			expect(result.current.savingPlaybook).toBe(true);
		});

		await act(async () => {
			await result.current.handleSaveAsPlaybook('Second Draft');
		});
		expect(window.maestro.playbooks.create).toHaveBeenCalledTimes(1);

		await act(async () => {
			resolveCreate({
				success: true,
				playbook: makePlaybook({ id: 'created-playbook', name: 'Draft' }),
			});
			await firstSave!;
		});
		expect(result.current.savingPlaybook).toBe(false);
	});

	it('keeps the save modal open when create returns an unsuccessful result', async () => {
		vi.mocked(window.maestro.playbooks.create).mockResolvedValueOnce({
			success: false,
			error: 'name already exists',
		});

		const { result } = renderHook(
			(deps: UsePlaybookManagementDeps) => usePlaybookManagement(deps),
			{
				initialProps: makeDeps(),
			}
		);
		await waitForPlaybooksToLoad(result);

		act(() => {
			result.current.setShowSavePlaybookModal(true);
		});
		await act(async () => {
			await result.current.handleSaveAsPlaybook('Duplicate');
		});

		expect(window.maestro.playbooks.create).toHaveBeenCalledWith(
			'session-1',
			expect.objectContaining({
				name: 'Duplicate',
				documents: [{ filename: 'existing.md', resetOnCompletion: false }],
				loopEnabled: false,
				maxLoops: null,
				prompt: DEFAULT_BATCH_PROMPT,
			})
		);
		expect(result.current.playbooks).toEqual([]);
		expect(result.current.loadedPlaybook).toBeNull();
		expect(result.current.showSavePlaybookModal).toBe(true);
		expect(result.current.savingPlaybook).toBe(false);
	});

	it('logs save failures and resets saving state', async () => {
		const consoleError = vi.mocked(logger.error);
		vi.mocked(window.maestro.playbooks.create).mockRejectedValueOnce(new Error('create failed'));
		const { result } = renderHook(
			(deps: UsePlaybookManagementDeps) => usePlaybookManagement(deps),
			{
				initialProps: makeDeps(),
			}
		);
		await waitForPlaybooksToLoad(result);

		try {
			await act(async () => {
				await result.current.handleSaveAsPlaybook('Broken');
			});

			expect(consoleError).toHaveBeenCalledWith(
				'Failed to save playbook:',
				undefined,
				expect.any(Error)
			);
			expect(result.current.savingPlaybook).toBe(false);
		} finally {
			consoleError.mockClear();
		}
	});

	it('skips update without a loaded playbook and preserves unrelated playbooks on update', async () => {
		const loaded = makePlaybook();
		const other = makePlaybook({ id: 'other-playbook', name: 'Other' });
		const updated = makePlaybook({ name: 'Updated Playbook', prompt: 'Updated prompt' });
		vi.mocked(window.maestro.playbooks.list).mockResolvedValueOnce({
			success: true,
			playbooks: [loaded, other],
		});
		vi.mocked(window.maestro.playbooks.update).mockResolvedValueOnce({
			success: true,
			playbook: updated,
		});

		const updateConfig: PlaybookConfigState = {
			...baseConfig,
			prompt: 'Updated prompt',
		};
		const { result } = renderHook(
			(deps: UsePlaybookManagementDeps) => usePlaybookManagement(deps),
			{
				initialProps: makeDeps({ config: updateConfig }),
			}
		);
		await waitForPlaybooksToLoad(result);

		await act(async () => {
			await result.current.handleSaveUpdate();
		});
		expect(window.maestro.playbooks.update).not.toHaveBeenCalled();

		act(() => {
			result.current.handleLoadPlaybook(loaded);
		});
		await act(async () => {
			await result.current.handleSaveUpdate();
		});

		expect(window.maestro.playbooks.update).toHaveBeenCalledWith(
			'session-1',
			loaded.id,
			expect.objectContaining({
				prompt: 'Updated prompt',
				documents: [{ filename: 'existing.md', resetOnCompletion: false }],
				loopEnabled: false,
				maxLoops: null,
				updatedAt: expect.any(Number),
			})
		);
		expect(result.current.loadedPlaybook).toEqual(updated);
		expect(result.current.playbooks).toEqual([updated, other]);
	});

	it('preserves loaded state when update returns an unsuccessful result', async () => {
		const loaded = makePlaybook();
		const other = makePlaybook({ id: 'other-playbook', name: 'Other' });
		vi.mocked(window.maestro.playbooks.list).mockResolvedValueOnce({
			success: true,
			playbooks: [loaded, other],
		});
		vi.mocked(window.maestro.playbooks.update).mockResolvedValueOnce({
			success: false,
			error: 'write failed',
		});

		const updateConfig: PlaybookConfigState = {
			...baseConfig,
			prompt: 'Changed prompt',
		};
		const { result } = renderHook(
			(deps: UsePlaybookManagementDeps) => usePlaybookManagement(deps),
			{
				initialProps: makeDeps({ config: updateConfig }),
			}
		);
		await waitForPlaybooksToLoad(result);

		act(() => {
			result.current.handleLoadPlaybook(loaded);
		});
		await act(async () => {
			await result.current.handleSaveUpdate();
		});

		expect(window.maestro.playbooks.update).toHaveBeenCalledWith(
			'session-1',
			loaded.id,
			expect.objectContaining({
				prompt: 'Changed prompt',
				documents: [{ filename: 'existing.md', resetOnCompletion: false }],
				loopEnabled: false,
				maxLoops: null,
				updatedAt: expect.any(Number),
			})
		);
		expect(result.current.loadedPlaybook).toEqual(loaded);
		expect(result.current.playbooks).toEqual([loaded, other]);
		expect(result.current.savingPlaybook).toBe(false);
	});

	it('logs update failures and reapplies a loaded playbook when discarding changes', async () => {
		const consoleError = vi.mocked(logger.error);
		const onApplyPlaybook = vi.fn();
		const loaded = makePlaybook();
		vi.mocked(window.maestro.playbooks.list).mockResolvedValueOnce({
			success: true,
			playbooks: [loaded],
		});
		vi.mocked(window.maestro.playbooks.update).mockRejectedValueOnce(new Error('update failed'));

		const updateConfig: PlaybookConfigState = {
			...baseConfig,
			prompt: 'Changed prompt',
		};
		const { result } = renderHook(
			(deps: UsePlaybookManagementDeps) => usePlaybookManagement(deps),
			{
				initialProps: makeDeps({ config: updateConfig, onApplyPlaybook }),
			}
		);
		await waitForPlaybooksToLoad(result);

		try {
			act(() => {
				result.current.handleLoadPlaybook(loaded);
			});
			await act(async () => {
				await result.current.handleSaveUpdate();
			});

			expect(consoleError).toHaveBeenCalledWith(
				'Failed to update playbook:',
				undefined,
				expect.any(Error)
			);
			expect(result.current.savingPlaybook).toBe(false);

			act(() => {
				result.current.handleDiscardChanges();
			});

			expect(onApplyPlaybook).toHaveBeenLastCalledWith(
				expect.objectContaining({
					documents: [expect.objectContaining({ filename: 'existing.md' })],
					prompt: DEFAULT_BATCH_PROMPT,
					taskSelectionMode: 'task',
				})
			);
		} finally {
			consoleError.mockClear();
		}
	});

	it('does not apply a playbook when discarding without a loaded playbook', async () => {
		const onApplyPlaybook = vi.fn();
		const { result } = renderHook(
			(deps: UsePlaybookManagementDeps) => usePlaybookManagement(deps),
			{
				initialProps: makeDeps({ onApplyPlaybook }),
			}
		);
		await waitForPlaybooksToLoad(result);

		act(() => {
			result.current.handleDiscardChanges();
		});

		expect(onApplyPlaybook).not.toHaveBeenCalled();
	});
});
