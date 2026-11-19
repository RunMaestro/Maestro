// Source: src/__tests__/renderer/components/Wizard/screens/PhaseReviewScreen/components.test.tsx
// Source: src/__tests__/renderer/components/Wizard/screens/PhaseReviewScreen/hooks.test.tsx
import React from 'react';
import { fireEvent } from '@testing-library/react';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { mockTheme } from '../../../../../helpers/mockTheme';
import { LaunchErrorBanner } from '../../../../../../renderer/components/Wizard/screens/PhaseReviewScreen/components';
import { PhaseReviewFooter } from '../../../../../../renderer/components/Wizard/screens/PhaseReviewScreen/components';
import { renderHook } from '@testing-library/react';
import { act } from '@testing-library/react';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import { initialState } from '../../../../../../renderer/components/Wizard/WizardContext/reducer';
import { usePhaseReviewAutosave } from '../../../../../../renderer/components/Wizard/screens/PhaseReviewScreen/hooks';
import { usePhaseReviewDocumentState } from '../../../../../../renderer/components/Wizard/screens/PhaseReviewScreen/hooks';
import { usePhaseReviewKeyboard } from '../../../../../../renderer/components/Wizard/screens/PhaseReviewScreen/hooks';
import { usePhaseReviewLaunch } from '../../../../../../renderer/components/Wizard/screens/PhaseReviewScreen/hooks';
const sentryMocks = vi.hoisted(() => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));
vi.mock('../../../../../../renderer/utils/sentry', () => sentryMocks);
describe('components', () => {
	describe('PhaseReviewScreen components', () => {
		it('renders and dismisses launch errors', () => {
			const onDismiss = vi.fn();
			render(<LaunchErrorBanner error="Launch failed" theme={mockTheme} onDismiss={onDismiss} />);

			expect(screen.getByText('Launch failed')).toBeInTheDocument();
			fireEvent.click(screen.getByRole('button'));
			expect(onDismiss).toHaveBeenCalled();
		});

		it('renders launch controls, Auto Run modes, and hints', () => {
			const setAutoRunMode = vi.fn();
			const onLaunch = vi.fn();
			render(
				<PhaseReviewFooter
					theme={mockTheme}
					generatedDocuments={[
						{ filename: 'Phase-01.md', content: '# One', taskCount: 1 },
						{ filename: 'Phase-02.md', content: '# Two', taskCount: 2 },
					]}
					autoRunMode="all"
					setAutoRunMode={setAutoRunMode}
					launchingButton={null}
					readyButtonRef={React.createRef<HTMLButtonElement>()}
					tourButtonRef={React.createRef<HTMLButtonElement>()}
					onLaunch={onLaunch}
				/>
			);

			expect(screen.getByText('Execute all Auto Run phases')).toBeInTheDocument();
			expect(screen.getByText('Start first Auto Run phase')).toBeInTheDocument();
			expect(screen.getByText("Don't start Auto Run")).toBeInTheDocument();

			fireEvent.click(screen.getByRole('button', { name: /ready to go/i }));
			fireEvent.click(screen.getByRole('button', { name: /walk me through/i }));
			expect(onLaunch).toHaveBeenCalledWith(false);
			expect(onLaunch).toHaveBeenCalledWith(true);
			expect(screen.getByText('Toggle Edit/Preview')).toBeInTheDocument();
			expect(screen.getByText('Cycle documents')).toBeInTheDocument();
		});

		it('disables first-phase mode when only one document exists and shows launching state', () => {
			render(
				<PhaseReviewFooter
					theme={mockTheme}
					generatedDocuments={[{ filename: 'Phase-01.md', content: '# One', taskCount: 1 }]}
					autoRunMode="all"
					setAutoRunMode={vi.fn()}
					launchingButton="ready"
					readyButtonRef={React.createRef<HTMLButtonElement>()}
					tourButtonRef={React.createRef<HTMLButtonElement>()}
					onLaunch={vi.fn()}
				/>
			);

			expect(screen.getByRole('button', { name: /launching/i })).toBeDisabled();
			expect(screen.queryByText('Cycle documents')).not.toBeInTheDocument();
		});
	});
});
describe('hooks', () => {
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
				await expect(launch.current.handleLaunch(false)).rejects.toThrow('no launch');
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
});
