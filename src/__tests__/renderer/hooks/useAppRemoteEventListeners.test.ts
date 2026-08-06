import path from 'path';
import os from 'os';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	useAppRemoteEventListeners,
	type UseAppRemoteEventListenersDeps,
} from '../../../renderer/hooks/remote/useAppRemoteEventListeners';
import { useBatchStore } from '../../../renderer/stores/batchStore';
import { useModalStore } from '../../../renderer/stores/modalStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import type { Session } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';

describe('useAppRemoteEventListeners', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		window.maestro.process.sendRemoteConfigureAutoRunResponse = vi.fn();
		useBatchStore.getState().clearDocumentList();
		useModalStore.setState({ modals: new Map() });
		useUIStore.setState({ rightPanelOpen: false, activeRightTab: 'files' });
	});

	it('opens a preconfigured Batch Runner without launching', async () => {
		const folderPath = path.join(os.tmpdir(), 'maestro-auto-run');
		const documentPath = path.join('nested', 'spec.md');
		const selectedFile = path.join('nested', 'spec');
		const session = createMockSession({ autoRunFolderPath: folderPath });
		const sessionsRef = { current: [session] };
		const setSessions = vi.fn((next: Session[] | ((previous: Session[]) => Session[])) => {
			sessionsRef.current = typeof next === 'function' ? next(sessionsRef.current) : next;
		});
		const setActiveSessionId = vi.fn();
		const startBatchRun = vi.fn().mockResolvedValue(undefined);

		vi.mocked(window.maestro.autorun.readDoc).mockResolvedValue({
			success: true,
			content: '# Spec',
		});

		const deps: UseAppRemoteEventListenersDeps = {
			sessionsRef,
			setActiveSessionId,
			setSessions,
			setGroups: vi.fn(),
			handleOpenFileTab: vi.fn(),
			refreshFileTree: vi.fn(),
			handleAutoRunRefresh: vi.fn(),
			startBatchRun,
			stopBatchRun: vi.fn(),
			resumeAfterError: vi.fn(),
			skipCurrentDocument: vi.fn(),
			abortBatchOnError: vi.fn(),
		};

		renderHook(() => useAppRemoteEventListeners(deps));

		act(() => {
			window.dispatchEvent(
				new CustomEvent('maestro:configureAutoRun', {
					detail: {
						sessionId: session.id,
						config: {
							documents: [{ filename: documentPath, resetOnCompletion: true }],
							prompt: 'Review each task',
							loopEnabled: true,
							maxLoops: 3,
						},
						responseChannel: 'configure-response',
					},
				})
			);
		});

		await waitFor(() => {
			expect(window.maestro.process.sendRemoteConfigureAutoRunResponse).toHaveBeenCalledWith(
				'configure-response',
				{ success: true }
			);
		});

		expect(startBatchRun).not.toHaveBeenCalled();
		expect(window.maestro.autorun.readDoc).toHaveBeenCalledWith(
			folderPath,
			documentPath,
			undefined
		);
		expect(setActiveSessionId).toHaveBeenCalledWith(session.id);
		expect(sessionsRef.current[0]).toMatchObject({
			autoRunSelectedFile: selectedFile,
			autoRunContent: '# Spec',
			batchRunnerPrompt: 'Review each task',
		});
		expect(useBatchStore.getState().documentList).toEqual([selectedFile]);
		expect(useUIStore.getState()).toMatchObject({
			rightPanelOpen: true,
			activeRightTab: 'autorun',
		});
		expect(useModalStore.getState().getData('batchRunner')).toMatchObject({
			initialConfig: {
				documents: [
					{
						filename: selectedFile,
						resetOnCompletion: true,
					},
				],
				prompt: 'Review each task',
				loopEnabled: true,
				maxLoops: 3,
			},
		});
	});

	it('preserves a nested relative document path when launching', async () => {
		const folderPath = path.join(os.tmpdir(), 'maestro-auto-run');
		const session = createMockSession({ autoRunFolderPath: folderPath });
		const startBatchRun = vi.fn().mockResolvedValue(undefined);

		const deps: UseAppRemoteEventListenersDeps = {
			sessionsRef: { current: [session] },
			setActiveSessionId: vi.fn(),
			setSessions: vi.fn(),
			setGroups: vi.fn(),
			handleOpenFileTab: vi.fn(),
			refreshFileTree: vi.fn(),
			handleAutoRunRefresh: vi.fn(),
			startBatchRun,
			stopBatchRun: vi.fn(),
			resumeAfterError: vi.fn(),
			skipCurrentDocument: vi.fn(),
			abortBatchOnError: vi.fn(),
		};

		renderHook(() => useAppRemoteEventListeners(deps));

		act(() => {
			window.dispatchEvent(
				new CustomEvent('maestro:configureAutoRun', {
					detail: {
						sessionId: session.id,
						config: {
							documents: [{ filename: 'nested/spec.md', resetOnCompletion: true }],
							launch: true,
						},
						responseChannel: 'launch-response',
					},
				})
			);
		});

		await waitFor(() => {
			expect(startBatchRun).toHaveBeenCalledWith(
				session.id,
				expect.objectContaining({
					documents: [
						expect.objectContaining({
							filename: 'nested/spec',
							resetOnCompletion: true,
						}),
					],
				}),
				folderPath
			);
		});
	});
});
