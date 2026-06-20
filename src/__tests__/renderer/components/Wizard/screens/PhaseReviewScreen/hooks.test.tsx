import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { initialState } from '../../../../../../renderer/components/Wizard/WizardContext/reducer';
import {
	usePhaseReviewAutosave,
	usePhaseReviewDocumentState,
	usePhaseReviewKeyboard,
	usePhaseReviewLaunch,
} from '../../../../../../renderer/components/Wizard/screens/PhaseReviewScreen/hooks';

const sentryMocks = vi.hoisted(() => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

vi.mock('../../../../../../renderer/utils/sentry', () => sentryMocks);

describe('PhaseReviewScreen hooks', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.mocked(window.maestro.autorun.writeDoc).mockResolvedValue({ success: true });
		vi.mocked(window.maestro.autorun.deleteImage).mockResolvedValue({ success: true });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	const docs = [
		{ filename: 'Phase-01.md', content: '# One\n![image](images/a.png)', taskCount: 1 },
		{ filename: 'Phase-02.md', content: '# Two', taskCount: 2 },
	];

	it('manages document selection, mode switching, and attachment removal', async () => {
		const setCurrentDocumentIndex = vi.fn();
		const { result, rerender } = renderHook(
			({ currentDocumentIndex }) =>
				usePhaseReviewDocumentState({
					state: {
						...initialState,
						directoryPath: '/project',
						generatedDocuments: docs,
						currentDocumentIndex,
					},
					getPhase1Content: () => docs[0].content,
					setCurrentDocumentIndex,
				}),
			{ initialProps: { currentDocumentIndex: 0 } }
		);

		expect(result.current.currentDoc?.filename).toBe('Phase-01.md');
		act(() => result.current.handleDocumentSelect(1));
		expect(setCurrentDocumentIndex).toHaveBeenCalledWith(1);

		rerender({ currentDocumentIndex: 1 });
		expect(result.current.localContent).toBe('# Two');

		act(() => result.current.handleModeChange('edit'));
		act(() => vi.advanceTimersByTime(50));
		expect(result.current.mode).toBe('edit');

		act(() => result.current.handleAddAttachment('images/a.png', 'data:image/png;base64,abc'));
		expect(result.current.attachments).toHaveLength(1);

		await act(async () => {
			await result.current.handleRemoveAttachment('images/a.png');
		});
		expect(window.maestro.autorun.deleteImage).toHaveBeenCalledWith(
			'/project/.maestro/playbooks',
			'images/a.png'
		);
	});

	it('autosaves changed content and updates edited Phase 1 content', async () => {
		const setEditedPhase1Content = vi.fn();
		const { rerender } = renderHook(
			({ localContent }) =>
				usePhaseReviewAutosave({
					localContent,
					folderPath: '/project/.maestro/playbooks',
					currentDoc: docs[0],
					currentDocumentIndex: 0,
					setEditedPhase1Content,
				}),
			{ initialProps: { localContent: docs[0].content } }
		);

		rerender({ localContent: '# Updated' });
		await act(async () => {
			vi.advanceTimersByTime(2000);
			await Promise.resolve();
		});

		expect(window.maestro.autorun.writeDoc).toHaveBeenCalledWith(
			'/project/.maestro/playbooks',
			'Phase-01.md',
			'# Updated'
		);
		expect(setEditedPhase1Content).toHaveBeenCalledWith('# Updated');
	});

	it('saves final content, records metrics, and launches', async () => {
		vi.setSystemTime(5000);
		const saveNow = vi.fn().mockResolvedValue(undefined);
		const setWantsTour = vi.fn();
		const onLaunchSession = vi.fn().mockResolvedValue(undefined);
		const onWizardComplete = vi.fn();
		const { result } = renderHook(() =>
			usePhaseReviewLaunch({
				state: {
					...initialState,
					conversationHistory: [{ id: '1', role: 'user', content: 'Hi', timestamp: 1 }],
					generatedDocuments: docs,
				},
				currentDoc: docs[0],
				localContent: '# Final',
				saveNow,
				setWantsTour,
				onLaunchSession,
				onWizardComplete,
				wizardStartTime: 1000,
			})
		);

		await act(async () => {
			await result.current.handleLaunch(true);
		});

		expect(setWantsTour).toHaveBeenCalledWith(true);
		expect(saveNow).toHaveBeenCalledWith('# Final');
		expect(onWizardComplete).toHaveBeenCalledWith(4000, 1, 2, 0);
		expect(onLaunchSession).toHaveBeenCalledWith(true);
	});

	it('captures launch errors and routes keyboard actions', async () => {
		const saveNow = vi.fn().mockRejectedValue(new Error('no launch'));
		const { result: launch } = renderHook(() =>
			usePhaseReviewLaunch({
				state: { ...initialState, generatedDocuments: docs },
				currentDoc: docs[0],
				localContent: '# Final',
				saveNow,
				setWantsTour: vi.fn(),
				onLaunchSession: vi.fn(),
			})
		);

		await act(async () => {
			await launch.current.handleLaunch(false);
		});
		expect(launch.current.launchError).toBe('no launch');
		expect(sentryMocks.captureException).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'no launch' }),
			expect.objectContaining({
				extra: expect.objectContaining({
					context: 'usePhaseReviewLaunch.handleLaunch',
					wantsTour: false,
				}),
			})
		);

		const handleModeChange = vi.fn();
		const handleDocumentSelect = vi.fn();
		const setIsDropdownOpen = vi.fn();
		const readyButtonRef = { current: document.createElement('button') };
		const tourButtonRef = { current: document.createElement('button') };
		const handleLaunch = vi.fn();
		const { result: keyboard } = renderHook(() =>
			usePhaseReviewKeyboard({
				mode: 'preview',
				generatedDocuments: docs,
				currentDocumentIndex: 0,
				isDropdownOpen: true,
				setIsDropdownOpen,
				handleModeChange,
				handleDocumentSelect,
				readyButtonRef,
				tourButtonRef,
				launchingButton: null,
				handleLaunch,
			})
		);

		act(() => {
			window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
			window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', metaKey: true }));
			window.dispatchEvent(
				new KeyboardEvent('keydown', { key: ']', metaKey: true, shiftKey: true })
			);
		});
		expect(setIsDropdownOpen).toHaveBeenCalledWith(false);
		expect(handleModeChange).toHaveBeenCalledWith('edit');
		expect(handleDocumentSelect).toHaveBeenCalledWith(1);

		document.body.appendChild(readyButtonRef.current);
		document.body.appendChild(tourButtonRef.current);
		readyButtonRef.current.focus();
		const enterPreventDefault = vi.fn();
		const enterStopPropagation = vi.fn();
		act(() => {
			keyboard.current({ key: 'Tab', shiftKey: false, preventDefault: vi.fn() } as any);
			keyboard.current({
				key: 'Enter',
				preventDefault: enterPreventDefault,
				stopPropagation: enterStopPropagation,
			} as any);
		});
		expect(tourButtonRef.current).toHaveFocus();
		expect(handleLaunch).toHaveBeenCalledWith(true);
		expect(enterPreventDefault).toHaveBeenCalled();
		expect(enterStopPropagation).toHaveBeenCalled();
		document.body.removeChild(readyButtonRef.current);
		document.body.removeChild(tourButtonRef.current);
	});
});
