/**
 * The shared composer toolbar as Group Chat renders it: the room's capabilities,
 * its Read-Only toggle in every layout, voice, upload, and the phone row with
 * the room's Send rules.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	GROUP_CHAT_PHONE_COMPOSER_COLLAPSED_KEY,
	GroupChatInput,
} from '../../../renderer/components/GroupChatInput';
import { PHONE_COMPOSER_COLLAPSED_KEY } from '../../../renderer/components/InputArea/InputArea';
import { useQuitWhenIdleStore } from '../../../renderer/stores/quitWhenIdleStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { usePhoneLayout } from '../../../renderer/hooks/ui/useViewportBreakpoint';
import { isWebDesktop } from '../../../renderer/utils/runtimeContext';
import { shortcutSuffix } from '../../../renderer/components/ui/ShortcutHint';
import { createMockTheme } from '../../helpers/mockTheme';
import { restorePointer, setCoarsePointer } from '../../helpers/mockPointer';

vi.mock('../../../renderer/hooks/ui/useViewportBreakpoint', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/hooks/ui/useViewportBreakpoint')>()),
	usePhoneLayout: vi.fn(() => false),
}));
vi.mock('../../../renderer/utils/runtimeContext', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/utils/runtimeContext')>()),
	isWebDesktop: vi.fn(() => false),
}));

const mockedUsePhoneLayout = vi.mocked(usePhoneLayout);
const mockedIsWebDesktop = vi.mocked(isWebDesktop);
const theme = createMockTheme();

function renderRoom(overrides: Partial<Parameters<typeof GroupChatInput>[0]> = {}) {
	useSessionStore.setState({ sessions: [] });
	const props = {
		theme,
		state: 'idle' as const,
		onSend: vi.fn(),
		participants: [],
		groupChatId: 'room-1',
		readOnlyMode: false,
		setReadOnlyMode: vi.fn(),
		onOpenPromptComposer: vi.fn(),
		...overrides,
	};
	const view = render(<GroupChatInput {...props} />);
	return { ...view, props, textarea: screen.getByRole('textbox') as HTMLTextAreaElement };
}

/** Buttons for the per-tab agent settings a room leaves out (rows 33-36). */
function expectNoAgentPills() {
	expect(screen.queryByTitle(/Save to History/)).not.toBeInTheDocument();
	expect(screen.queryByTitle(/^Full Access|^Read Only|^Plan/)).not.toBeInTheDocument();
	expect(screen.queryByTitle(/Thinking/)).not.toBeInTheDocument();
	expect(screen.queryByTitle('Change model')).not.toBeInTheDocument();
	expect(screen.queryByTitle('Change effort level')).not.toBeInTheDocument();
}

describe('GroupChatInput toolbar', () => {
	const originalWidth = window.innerWidth;

	afterEach(() => {
		mockedUsePhoneLayout.mockReturnValue(false);
		mockedIsWebDesktop.mockReturnValue(false);
		useQuitWhenIdleStore.setState({ armed: false });
		try {
			window.localStorage?.removeItem(GROUP_CHAT_PHONE_COMPOSER_COLLAPSED_KEY);
			window.localStorage?.removeItem(PHONE_COMPOSER_COLLAPSED_KEY);
		} catch {
			/* storage may be absent */
		}
		restorePointer();
		Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
		vi.unstubAllGlobals();
	});

	describe('desktop', () => {
		it('draws Read-Only in the toggle group, just before the Enter toggle', () => {
			const setReadOnlyMode = vi.fn();
			renderRoom({ setReadOnlyMode });

			const readOnly = screen.getByRole('button', { name: /Read-Only/ });
			const enterToggle = screen.getByTitle(/Switch to/);
			expect(readOnly.nextElementSibling).toBe(enterToggle);

			fireEvent.click(readOnly);
			expect(setReadOnlyMode).toHaveBeenCalledWith(true);
		});

		it("shows the Read-Only chord from the user's live binding", () => {
			const tabShortcuts = useSettingsStore.getState().tabShortcuts;
			const keys = ['Meta', 'Alt', 'r'];
			useSettingsStore.setState({
				tabShortcuts: {
					...tabShortcuts,
					toggleReadOnlyMode: { ...tabShortcuts.toggleReadOnlyMode, keys },
				},
			});
			renderRoom();

			expect(screen.getByRole('button', { name: /Read-Only/ })).toHaveAttribute(
				'title',
				`Toggle Read-Only mode (agents won't modify files)${shortcutSuffix(keys)}`
			);
			useSettingsStore.setState({ tabShortcuts });
		});

		it('never renders the per-tab agent settings', () => {
			renderRoom();
			expectNoAgentPills();
		});

		// jsdom does no layout, so a width bug cannot be measured here. What it can
		// see is the structure the width depends on: the bordered box is a column
		// flex container, which stretches a direct child to its full width. A
		// wrapper row in between made ComposerTextarea's root a row flex item
		// without flex-1, so it shrank to the textarea's intrinsic ~200px.
		it("mounts the textarea's root directly in the bordered composer box", () => {
			const { textarea } = renderRoom();
			const root = textarea.parentElement!;
			expect(root).toHaveClass('relative', 'flex', 'items-start');
			expect(root.parentElement).toHaveClass('border', 'rounded-lg', 'flex', 'flex-col');
		});

		it('keeps the room send column with its bell beside the composer', () => {
			renderRoom();
			expect(screen.getByTitle('Notification Settings')).toBeInTheDocument();
		});

		it('draws no phone fold handle on desktop', () => {
			renderRoom();
			expect(screen.queryByTestId('phone-composer-handle')).not.toBeInTheDocument();
			expect(screen.getByRole('textbox')).toBeInTheDocument();
		});

		it('shows the quit-when-idle pill in a room only while a quit is armed', () => {
			const { rerender, props } = renderRoom();
			expect(screen.queryByText('Quitting When All Operations Finish')).not.toBeInTheDocument();

			act(() => useQuitWhenIdleStore.getState().arm());
			rerender(<GroupChatInput {...props} />);
			expect(screen.getByText('Quitting When All Operations Finish')).toBeInTheDocument();

			fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
			expect(useQuitWhenIdleStore.getState().armed).toBe(false);
			expect(screen.queryByText('Quitting When All Operations Finish')).not.toBeInTheDocument();
		});
	});

	describe('narrow viewport', () => {
		it('folds Read-Only and the Enter toggle behind "Show options"', () => {
			Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 });
			renderRoom();

			const readOnly = screen.getByRole('button', { name: /Read-Only/, hidden: true });
			expect(readOnly.parentElement).toHaveClass('hidden');

			fireEvent.click(screen.getByRole('button', { name: 'Show toolbar options' }));
			expect(readOnly.parentElement).not.toHaveClass('hidden');
		});
	});

	describe('voice', () => {
		interface FakeRecognitionInstance {
			onstart?: () => void;
			onresult?: (event: unknown) => void;
			onend?: () => void;
			abort: ReturnType<typeof vi.fn>;
		}
		let recognition: FakeRecognitionInstance | null = null;

		/** A mock recognizer whose abort, like a real one, still lets a queued result and onend fire. */
		function stubRecognition() {
			class FakeRecognition {
				start = vi.fn(() => this.onstart?.());
				stop = vi.fn();
				abort = vi.fn();
				onstart?: () => void;
				onresult?: (event: unknown) => void;
				onend?: () => void;
				constructor() {
					// eslint-disable-next-line @typescript-eslint/no-this-alias
					recognition = this;
				}
			}
			vi.stubGlobal('SpeechRecognition', FakeRecognition);
			setCoarsePointer(true);
		}

		function speak(target: FakeRecognitionInstance | null, transcript: string) {
			act(() =>
				target?.onresult?.({
					resultIndex: 0,
					results: [Object.assign([{ transcript }], { isFinal: true })],
				})
			);
		}

		/** A result and onend arriving after the dictation was cancelled. */
		function deliverLate(target: FakeRecognitionInstance | null, transcript: string) {
			speak(target, transcript);
			act(() => target?.onend?.());
		}

		it('offers the mic on a coarse pointer and writes dictation into the draft', () => {
			vi.useFakeTimers();
			stubRecognition();
			const onDraftChange = vi.fn();
			const { textarea } = renderRoom({ onDraftChange });

			fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
			speak(recognition, 'hello room');

			expect(textarea.value).toBe('hello room');
			act(() => vi.advanceTimersByTime(300));
			expect(onDraftChange).toHaveBeenLastCalledWith('hello room', 'room-1');
			vi.useRealTimers();
		});

		it('ignores a result that arrives after a room switch', () => {
			vi.useFakeTimers();
			stubRecognition();
			const onDraftChange = vi.fn();
			const { textarea, props, rerender } = renderRoom({ onDraftChange, draftMessage: 'one' });

			fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
			const dictation = recognition;
			rerender(<GroupChatInput {...props} groupChatId="room-2" draftMessage="two" />);

			expect(dictation?.abort).toHaveBeenCalled();
			expect(screen.getByRole('button', { name: 'Start voice input' })).toBeInTheDocument();
			deliverLate(dictation, 'late words');
			act(() => vi.advanceTimersByTime(300));

			expect(textarea.value).toBe('two');
			expect(onDraftChange).not.toHaveBeenCalledWith(
				expect.stringContaining('late words'),
				'room-1'
			);
			expect(onDraftChange).not.toHaveBeenCalledWith(
				expect.stringContaining('late words'),
				'room-2'
			);
			vi.useRealTimers();
		});

		it('ignores a result that arrives after a send', () => {
			vi.useFakeTimers();
			stubRecognition();
			const onDraftChange = vi.fn();
			const onSend = vi.fn();
			const { textarea } = renderRoom({ onDraftChange, onSend });

			fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
			const dictation = recognition;
			speak(dictation, 'send this');
			fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

			expect(onSend).toHaveBeenCalledWith('send this', undefined, false);
			expect(dictation?.abort).toHaveBeenCalled();
			expect(screen.getByRole('button', { name: 'Start voice input' })).toBeInTheDocument();
			deliverLate(dictation, ' and more');
			act(() => vi.advanceTimersByTime(300));

			expect(textarea.value).toBe('');
			expect(onDraftChange).toHaveBeenLastCalledWith('', 'room-1');
			vi.useRealTimers();
		});

		it('hides the mic on a mouse pointer', () => {
			vi.stubGlobal('SpeechRecognition', class {});
			setCoarsePointer(false);
			renderRoom();
			expect(screen.queryByRole('button', { name: /voice input/ })).not.toBeInTheDocument();
		});
	});

	describe('upload', () => {
		it('offers upload on web-desktop and publishes the draft before uploading', () => {
			vi.useFakeTimers();
			mockedIsWebDesktop.mockReturnValue(true);
			const onDraftChange = vi.fn();
			const onUploadFiles = vi.fn(() => {
				// The upload appends mentions to the stored draft, so the typed text
				// must already be there.
				expect(onDraftChange).toHaveBeenLastCalledWith('typed', 'room-1');
			});
			const { textarea } = renderRoom({ onDraftChange, onUploadFiles });
			fireEvent.change(textarea, { target: { value: 'typed' } });

			const file = new File(['x'], 'notes.txt', { type: 'text/plain' });
			fireEvent.change(screen.getByLabelText('Choose local files to upload to the host'), {
				target: { files: [file] },
			});

			expect(onUploadFiles).toHaveBeenCalledWith([file]);
			vi.useRealTimers();
		});

		it('offers no upload outside web-desktop', () => {
			renderRoom({ onUploadFiles: vi.fn() });
			expect(screen.queryByLabelText('Upload local files to the host')).not.toBeInTheDocument();
		});
	});

	describe('phone', () => {
		beforeEach(() => {
			mockedUsePhoneLayout.mockReturnValue(true);
			window.localStorage?.setItem(GROUP_CHAT_PHONE_COMPOSER_COLLAPSED_KEY, 'false');
		});

		it('starts folded by default, unfolds on a tap, and folds back', () => {
			window.localStorage?.removeItem(GROUP_CHAT_PHONE_COMPOSER_COLLAPSED_KEY);
			useSessionStore.setState({ sessions: [] });
			render(
				<GroupChatInput
					theme={theme}
					state="idle"
					onSend={vi.fn()}
					participants={[]}
					groupChatId="room-1"
				/>
			);

			const handle = screen.getByTestId('phone-composer-handle');
			expect(handle).toHaveAttribute('aria-expanded', 'false');
			expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

			fireEvent.click(handle);
			expect(screen.getByRole('textbox')).toBeInTheDocument();
			expect(screen.getByTestId('phone-composer-handle')).toHaveAttribute('aria-expanded', 'true');

			fireEvent.click(screen.getByTestId('phone-composer-handle'));
			expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
		});

		it('persists the room fold separately from AI chat', () => {
			window.localStorage?.removeItem(GROUP_CHAT_PHONE_COMPOSER_COLLAPSED_KEY);
			window.localStorage?.setItem(PHONE_COMPOSER_COLLAPSED_KEY, 'false');
			useSessionStore.setState({ sessions: [] });
			render(
				<GroupChatInput
					theme={theme}
					state="idle"
					onSend={vi.fn()}
					participants={[]}
					groupChatId="room-1"
				/>
			);

			// AI chat being unfolded does not unfold the room.
			expect(screen.getByTestId('phone-composer-handle')).toHaveAttribute('aria-expanded', 'false');
			expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

			fireEvent.click(screen.getByTestId('phone-composer-handle'));
			expect(window.localStorage?.getItem(GROUP_CHAT_PHONE_COMPOSER_COLLAPSED_KEY)).toBe('false');
			// Folding the room back leaves AI chat's key untouched.
			fireEvent.click(screen.getByTestId('phone-composer-handle'));
			expect(window.localStorage?.getItem(GROUP_CHAT_PHONE_COMPOSER_COLLAPSED_KEY)).toBe('true');
			expect(window.localStorage?.getItem(PHONE_COMPOSER_COLLAPSED_KEY)).toBe('false');
		});

		it('keeps the draft and staged images across a fold and marks the handle', () => {
			const { textarea } = renderRoom({
				state: 'moderator-thinking',
				stagedImages: ['data:image/png;base64,AAA'],
			});
			fireEvent.change(textarea, { target: { value: 'keep me' } });

			// Fold the composer.
			fireEvent.click(screen.getByTestId('phone-composer-handle'));
			expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
			expect(screen.getByTestId('phone-composer-handle-busy')).toBeInTheDocument();
			expect(screen.getByTestId('phone-composer-handle-draft')).toBeInTheDocument();

			// Unfold: both the typed text and the staged image are still there.
			fireEvent.click(screen.getByTestId('phone-composer-handle'));
			expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('keep me');
			expect(screen.getByRole('button', { name: 'Staged image 1' })).toBeInTheDocument();
		});

		it('marks the folded handle when only staged images are waiting', () => {
			window.localStorage?.removeItem(GROUP_CHAT_PHONE_COMPOSER_COLLAPSED_KEY);
			useSessionStore.setState({ sessions: [] });
			render(
				<GroupChatInput
					theme={theme}
					state="idle"
					onSend={vi.fn()}
					participants={[]}
					groupChatId="room-1"
					stagedImages={['data:image/png;base64,AAA']}
				/>
			);
			expect(screen.getByTestId('phone-composer-handle-draft')).toBeInTheDocument();
		});

		it('moves Send into the row, disabled until there is text', () => {
			const onSend = vi.fn();
			const { textarea } = renderRoom({ onSend });

			expect(screen.queryByTitle('Notification Settings')).not.toBeInTheDocument();
			const send = screen.getByRole('button', { name: 'Send message' });
			expect(send).toBeDisabled();
			expect(send).toHaveStyle({ backgroundColor: theme.colors.border });

			fireEvent.change(textarea, { target: { value: 'hello' } });
			expect(send).not.toBeDisabled();
			fireEvent.click(send);
			expect(onSend).toHaveBeenCalledWith('hello', undefined, false);
		});

		it('offers to queue while the room is busy, in the warning tint', () => {
			const { textarea } = renderRoom({ state: 'agent-working' });
			fireEvent.change(textarea, { target: { value: 'next' } });

			expect(screen.getByRole('button', { name: 'Queue message' })).toHaveStyle({
				backgroundColor: theme.colors.warning,
			});
		});

		it('reaches Read-Only through the options sheet', () => {
			const setReadOnlyMode = vi.fn();
			renderRoom({ setReadOnlyMode });

			// Not in the row: the toggle group is not drawn on a phone.
			expect(screen.queryByRole('button', { name: /Read-Only/ })).not.toBeInTheDocument();

			fireEvent.click(screen.getByTestId('composer-options-button'));
			const sheet = screen.getByTestId('composer-options-sheet');
			const row = within(sheet).getByTestId('composer-options-read-only');
			expect(row).toHaveAttribute('aria-checked', 'false');

			fireEvent.click(row);
			expect(setReadOnlyMode).toHaveBeenCalledWith(true);
		});

		it('opens a sheet with something in it every time, and no agent settings', () => {
			renderRoom({ readOnlyMode: true });

			fireEvent.click(screen.getByTestId('composer-options-button'));
			const sheet = screen.getByTestId('composer-options-sheet');
			expect(within(sheet).getByTestId('composer-options-read-only')).toHaveAttribute(
				'aria-checked',
				'true'
			);
			expect(within(sheet).queryByTestId('composer-options-history')).not.toBeInTheDocument();
			expect(within(sheet).queryByTestId('composer-options-access')).not.toBeInTheDocument();
			expect(within(sheet).queryByTestId('composer-options-thinking')).not.toBeInTheDocument();
			expect(within(sheet).queryByTestId('composer-options-model')).not.toBeInTheDocument();
			expect(within(sheet).queryByTestId('composer-options-effort')).not.toBeInTheDocument();
			expectNoAgentPills();
		});

		it('keeps attach in the row', () => {
			renderRoom();
			expect(screen.getByRole('button', { name: 'Attach Image' })).toBeInTheDocument();
		});
	});
});
