import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
	useDirectoryActions,
	useDirectoryKeyboard,
	useDirectorySshRemoteHost,
	useDirectoryValidation,
} from '../../../../../../renderer/components/Wizard/screens/DirectorySelectionScreen/hooks';

const sentryMocks = vi.hoisted(() => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

vi.mock('../../../../../../renderer/utils/sentry', () => sentryMocks);

describe('DirectorySelectionScreen hooks', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.mocked(window.maestro.fs.readDir).mockResolvedValue([]);
		vi.mocked(window.maestro.git.isRepo).mockResolvedValue(true);
		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({ success: true, files: [] });
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [{ id: 'remote-1', name: 'Remote One', host: 'remote.local' }],
		});
		(window.maestro.git as any).init = vi.fn().mockResolvedValue({ success: true });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function renderValidation(overrides: Partial<Parameters<typeof useDirectoryValidation>[0]> = {}) {
		const params = {
			existingDocsChoice: null,
			sessionSshRemoteConfig: undefined,
			setDirectoryPath: vi.fn(),
			setIsGitRepo: vi.fn(),
			setDirectoryError: vi.fn(),
			setHasExistingAutoRunDocs: vi.fn(),
			setInitRepoError: vi.fn(),
			announce: vi.fn(),
			...overrides,
		};
		const hook = renderHook(() => useDirectoryValidation(params));
		return { ...hook, params };
	}

	it('validates a directory with SSH-aware fs, git, and existing-doc checks', async () => {
		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValueOnce({
			success: true,
			files: ['plan.md'],
		});
		const { result, params } = renderValidation({
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});

		await act(async () => {
			await result.current.validateDirectory('/project');
		});

		expect(window.maestro.fs.readDir).toHaveBeenCalledWith('/project', 'remote-1');
		expect(window.maestro.git.isRepo).toHaveBeenCalledWith('/project', 'remote-1');
		expect(params.setIsGitRepo).toHaveBeenCalledWith(true);
		expect(params.setHasExistingAutoRunDocs).toHaveBeenCalledWith(true, 1);
		expect(params.announce).toHaveBeenCalledWith('Directory validated. Git repository detected.');
	});

	it('sets directory errors for inaccessible paths and debounces typed validation', async () => {
		vi.mocked(window.maestro.fs.readDir).mockRejectedValueOnce(new Error('missing'));
		const { result, params } = renderValidation();

		await act(async () => {
			await result.current.validateDirectory('/missing');
		});

		expect(params.setDirectoryError).toHaveBeenCalledWith(
			'Directory not found. Please check the path exists.'
		);
		expect(params.announce).toHaveBeenCalledWith(
			'Error: Directory not found. Please check the path exists.'
		);

		act(() => {
			result.current.handlePathChange({
				target: { value: '/typed' },
			} as React.ChangeEvent<HTMLInputElement>);
		});
		expect(params.setDirectoryPath).toHaveBeenCalledWith('/typed');
		expect(window.maestro.fs.readDir).toHaveBeenCalledTimes(1);

		await act(async () => {
			vi.advanceTimersByTime(800);
		});
		expect(window.maestro.fs.readDir).toHaveBeenCalledWith('/typed', undefined);
	});

	it('ignores stale directory validation results', async () => {
		let resolveFirstRead: (value: string[]) => void = () => {};
		vi.mocked(window.maestro.fs.readDir)
			.mockImplementationOnce(
				() =>
					new Promise<string[]>((resolve) => {
						resolveFirstRead = resolve;
					})
			)
			.mockResolvedValueOnce([]);

		const { result, params } = renderValidation();

		const firstValidation = result.current.validateDirectory('/old');
		await act(async () => {
			await result.current.validateDirectory('/new');
		});

		await act(async () => {
			resolveFirstRead([]);
			await firstValidation;
		});

		expect(window.maestro.git.isRepo).toHaveBeenCalledTimes(1);
		expect(params.announce).toHaveBeenCalledTimes(1);
		expect(params.announce).toHaveBeenCalledWith('Directory validated. Git repository detected.');
	});

	it('loads SSH remote host labels and resets when remote is disabled', async () => {
		const { result, rerender } = renderHook(
			({ enabled }) =>
				useDirectorySshRemoteHost(enabled ? { enabled: true, remoteId: 'remote-1' } : undefined),
			{ initialProps: { enabled: true } }
		);

		await act(async () => {
			await Promise.resolve();
		});
		expect(result.current).toBe('Remote One');

		rerender({ enabled: false });
		expect(result.current).toBeNull();
	});

	it('clears SSH remote host labels on lookup misses and reports lookup failures', async () => {
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValueOnce({
			success: true,
			configs: [],
		});

		const { result, rerender } = renderHook(
			({ remoteId }) => useDirectorySshRemoteHost({ enabled: true, remoteId }),
			{ initialProps: { remoteId: 'missing-remote' } }
		);

		await act(async () => {
			await Promise.resolve();
		});
		expect(result.current).toBe('');
		expect(sentryMocks.captureMessage).toHaveBeenCalledWith(
			'Wizard SSH remote host lookup missed',
			expect.objectContaining({
				extra: expect.objectContaining({ remoteId: 'missing-remote' }),
			})
		);

		vi.mocked(window.maestro.sshRemote.getConfigs).mockRejectedValueOnce(new Error('ssh down'));
		rerender({ remoteId: 'remote-error' });
		await act(async () => {
			await Promise.resolve();
		});
		expect(result.current).toBe('');
		expect(sentryMocks.captureException).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'ssh down' }),
			expect.objectContaining({
				extra: expect.objectContaining({ remoteId: 'remote-error' }),
			})
		);
	});

	it('handles browse, git init, existing-doc modal decisions, and cancellation', async () => {
		const focusInput = vi.fn();
		const focusContinue = vi.fn();
		const nextStep = vi.fn();
		const setDirectoryPath = vi.fn();
		const setHasExistingAutoRunDocs = vi.fn();
		const setExistingDocsChoice = vi.fn();
		vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue('/picked');
		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValueOnce({
			success: true,
			files: ['a.md', 'b.md'],
		});

		const { result } = renderHook(() =>
			useDirectoryActions({
				directoryPath: '/project',
				existingDocsChoice: null,
				isValidating: false,
				canProceedToNext: () => true,
				nextStep,
				setDirectoryPath,
				setIsGitRepo: vi.fn(),
				setDirectoryError: vi.fn(),
				setHasExistingAutoRunDocs,
				setExistingDocsChoice,
				setInitRepoError: vi.fn(),
				getSshRemoteId: () => 'remote-1',
				validateDirectory: vi.fn().mockResolvedValue(undefined),
				focusInput,
				focusContinue,
				announce: vi.fn(),
			})
		);

		await act(async () => {
			await result.current.handleBrowse();
		});
		expect(setDirectoryPath).toHaveBeenCalledWith('/picked');
		act(() => vi.advanceTimersByTime(150));
		expect(focusContinue).toHaveBeenCalled();

		await act(async () => {
			await result.current.handleInitRepo();
		});
		expect(window.maestro.git.init).toHaveBeenCalledWith('/project', 'remote-1');

		await act(async () => {
			await result.current.attemptNextStep();
		});
		expect(setHasExistingAutoRunDocs).toHaveBeenCalledWith(true, 2);
		expect(result.current.showExistingDocsModal).toBe(true);

		act(() => result.current.handleContinueWithDocs());
		expect(setExistingDocsChoice).toHaveBeenCalledWith('continue');
		expect(nextStep).toHaveBeenCalled();

		act(() => result.current.handleModalCancel());
		expect(setDirectoryPath).toHaveBeenCalledWith('');
		expect(focusInput).toHaveBeenCalled();
	});

	it('does not advance when existing-doc lookup fails unexpectedly', async () => {
		const nextStep = vi.fn();
		const setDirectoryError = vi.fn();
		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValueOnce({
			success: false,
			files: [],
			error: 'network timeout',
		});

		const { result } = renderHook(() =>
			useDirectoryActions({
				directoryPath: '/project',
				existingDocsChoice: null,
				isValidating: false,
				canProceedToNext: () => true,
				nextStep,
				setDirectoryPath: vi.fn(),
				setIsGitRepo: vi.fn(),
				setDirectoryError,
				setHasExistingAutoRunDocs: vi.fn(),
				setExistingDocsChoice: vi.fn(),
				setInitRepoError: vi.fn(),
				getSshRemoteId: () => undefined,
				validateDirectory: vi.fn().mockResolvedValue(undefined),
				focusInput: vi.fn(),
				focusContinue: vi.fn(),
				announce: vi.fn(),
			})
		);

		await act(async () => {
			await expect(result.current.attemptNextStep()).rejects.toThrow(
				'Auto Run docs lookup failed: network timeout'
			);
		});

		expect(nextStep).not.toHaveBeenCalled();
		expect(setDirectoryError).toHaveBeenCalledWith(
			'Unable to check existing Auto Run docs. Please try again.'
		);
		expect(sentryMocks.captureException).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'Auto Run docs lookup failed: network timeout' }),
			expect.objectContaining({
				extra: expect.objectContaining({
					context: 'useDirectoryActions.attemptNextStep',
					directoryPath: '/project',
				}),
			})
		);
	});

	it('handles Enter and Escape keyboard routing', () => {
		const browseRef = React.createRef<HTMLButtonElement>();
		const handleBrowse = vi.fn();
		const attemptNextStep = vi.fn();
		const previousStep = vi.fn();
		const { result } = renderHook(() =>
			useDirectoryKeyboard({
				browseButtonRef: browseRef,
				isBrowsing: false,
				isValidating: false,
				canProceedToNext: () => true,
				handleBrowse,
				attemptNextStep,
				previousStep,
			})
		);

		const browseButton = document.createElement('button');
		browseRef.current = browseButton;
		document.body.appendChild(browseButton);
		browseButton.focus();

		act(() => {
			result.current({ key: 'Enter', preventDefault: vi.fn() } as any);
		});
		expect(handleBrowse).toHaveBeenCalled();

		act(() => {
			result.current({ key: 'Escape', preventDefault: vi.fn() } as any);
		});
		expect(previousStep).toHaveBeenCalled();

		document.body.removeChild(browseButton);
	});
});
