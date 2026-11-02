/**
 * Tests for the File Preview's chat bubble.
 *
 * The panel is a view onto a real AI tab, so what is worth asserting here is the
 * controls that change the wrong conversation, losing history on reopen,
 * and a chat that draws the previous file's messages.
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { DocumentChatMessages } from '../../../../renderer/components/DocumentChat/DocumentChatMessages';
import { DocumentChatOverlay } from '../../../../renderer/components/DocumentChat';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { useVoiceSessionStore } from '../../../../renderer/stores/voiceSessionStore';
import { useVoiceUiStore } from '../../../../renderer/stores/voiceUiStore';
import { sendDocumentChatMessage } from '../../../../renderer/services/documentChat';
import { createMockSession } from '../../../helpers/mockSession';
import { installLocalStorageMock } from '../../../helpers/mockLocalStorage';
import { mockTheme } from '../../../helpers/mockTheme';

const SESSION_ID = 'agent-1';
const DOC_PATH = '/repo/docs/system-overview.md';

function Harness({
	open = true,
	path = DOC_PATH,
	onOpenChange = () => {},
}: {
	open?: boolean;
	path?: string;
	onOpenChange?: (open: boolean) => void;
}) {
	const buttonRef = React.useRef<HTMLButtonElement>(null);
	const overlayRef = React.useRef<HTMLDivElement>(null);
	return (
		<DocumentChatOverlay
			theme={mockTheme}
			path={path}
			open={open}
			onOpenChange={onOpenChange}
			buttonRef={buttonRef}
			overlayRef={overlayRef}
		/>
	);
}

function enableVoice(enabled: boolean): void {
	useSettingsStore.setState({
		encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, aCappella: enabled },
	});
}

beforeEach(() => {
	useVoiceSessionStore.getState().reset();
	// Font size is a persisted reading preference; give each case fresh storage.
	installLocalStorageMock();
	useSessionStore.setState({
		sessions: [createMockSession({ id: SESSION_ID })],
		activeSessionId: SESSION_ID,
	});
	enableVoice(true);
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('DocumentChatOverlay', () => {
	it('anchors the panel above the visible bottom-left icon within the preview', () => {
		render(<Harness />);
		expect(screen.getByTestId('document-chat-button')).toHaveClass(
			'absolute',
			'bottom-4',
			'left-4'
		);
		expect(screen.getByTestId('document-chat-button')).not.toHaveClass('hidden');
		expect(screen.getByTestId('document-chat-panel')).toHaveClass(
			'absolute',
			'bottom-16',
			'left-4'
		);
		expect(screen.getByTestId('document-chat-panel')).not.toHaveClass('mx-auto');
		expect(screen.getByTestId('document-chat-panel')).toHaveStyle({
			width: 'calc(100% - 2rem)',
			maxWidth: '36rem',
		});
	});

	it('stops only its own embedded microphone when the panel closes', async () => {
		const { rerender } = render(<Harness />);
		act(() => {
			useVoiceSessionStore.setState({
				state: 'listening',
				scope: { kind: 'document', sessionId: SESSION_ID, path: DOC_PATH },
			});
		});
		vi.mocked(window.maestro.voice.stop).mockClear();
		rerender(<Harness open={false} />);
		await waitFor(() => expect(window.maestro.voice.stop).toHaveBeenCalledTimes(1));
	});

	it('ends its own document voice session when the preview unmounts', async () => {
		const { unmount } = render(<Harness />);
		act(() => {
			useVoiceSessionStore.setState({
				state: 'listening',
				scope: { kind: 'document', sessionId: SESSION_ID, path: DOC_PATH },
			});
		});
		vi.mocked(window.maestro.voice.stop).mockClear();
		unmount();
		await waitFor(() => expect(window.maestro.voice.stop).toHaveBeenCalledTimes(1));
	});

	it.each([
		{ sessionId: 'other-agent', path: DOC_PATH },
		{ sessionId: SESSION_ID, path: '/repo/other.md' },
	])('leaves another document voice session alone on unmount: %o', async (scope) => {
		const { unmount } = render(<Harness />);
		act(() => {
			useVoiceSessionStore.setState({
				state: 'listening',
				scope: { kind: 'document', ...scope },
			});
		});
		vi.mocked(window.maestro.voice.stop).mockClear();
		unmount();
		await act(async () => {});
		expect(window.maestro.voice.stop).not.toHaveBeenCalled();
	});

	it('holds the document microphone and sends on release without ending the session', async () => {
		useVoiceSessionStore.setState({
			state: 'listening',
			scope: { kind: 'document', sessionId: SESSION_ID, path: DOC_PATH },
		});
		render(<Harness />);
		vi.mocked(window.maestro.voice.setListening).mockClear();
		vi.mocked(window.maestro.voice.stop).mockClear();
		vi.useFakeTimers();
		fireEvent.pointerDown(screen.getByTestId('document-chat-push'));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(useVoiceUiStore.getState().holdThresholdMs);
		});
		expect(window.maestro.voice.setListening).toHaveBeenCalledWith({ listening: true, hold: true });
		await act(async () => {
			fireEvent.pointerUp(window);
		});
		expect(window.maestro.voice.setListening).toHaveBeenLastCalledWith({
			listening: false,
			send: true,
		});
		expect(window.maestro.voice.stop).not.toHaveBeenCalled();
		expect(useVoiceSessionStore.getState().state).toBe('listening');
	});

	it.each([
		{ sessionId: SESSION_ID, path: DOC_PATH, visible: true },
		{ sessionId: 'other-agent', path: DOC_PATH, visible: false },
		{ sessionId: SESSION_ID, path: '/repo/other.md', visible: false },
	])('shows only this document voice error: %o', ({ sessionId, path, visible }) => {
		useVoiceSessionStore.setState({
			state: 'error',
			scope: { kind: 'document', sessionId, path },
			error: { code: 'microphone', message: 'Microphone unavailable', recoverable: true },
		});
		render(<Harness />);
		if (visible) expect(screen.getByRole('alert')).toHaveTextContent('Microphone unavailable');
		else expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});

	it('keeps secondary actions out of the compact composer', () => {
		render(<Harness />);
		expect(screen.getByTestId('document-chat-font-scale')).toBeInTheDocument();
		expect(screen.getByTestId('document-chat-push')).toBeEnabled();
		expect(screen.getByTestId('document-chat-close')).toHaveTextContent('ESC');
		expect(screen.queryByTestId('document-chat-reset')).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Open in tab' })).toBeDisabled();
		expect(screen.queryByRole('button', { name: /^Thinking hidden/ })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /^Keep as a tab/ })).not.toBeInTheDocument();
		expect(screen.getByTestId('document-chat-composer')).not.toContainElement(
			screen.getByRole('button', { name: 'Open in tab' })
		);
		expect(screen.getByRole('button', { name: /^Attach images/ })).toBeEnabled();
		expect(
			screen.queryByRole('button', { name: /Pinned on top|Not pinned/ })
		).not.toBeInTheDocument();
		expect(screen.queryByRole('radiogroup', { name: 'Chat input mode' })).not.toBeInTheDocument();
	});

	it('opens the saved conversation in its full tab from the header', () => {
		sendDocumentChatMessage({ path: DOC_PATH, text: 'open this' });
		const tab = useSessionStore
			.getState()
			.sessions[0].aiTabs?.find((t) => t.documentOrigin?.path === DOC_PATH);
		render(<Harness />);
		fireEvent.click(screen.getByRole('button', { name: 'Open in tab' }));
		const session = useSessionStore.getState().sessions[0];
		expect(session.activeTabId).toBe(tab?.id);
		expect(session.aiTabs?.find((t) => t.id === tab?.id)?.hidden).toBe(false);
		expect(session.unifiedTabOrder).toContainEqual({ type: 'ai', id: tab?.id });
	});
	it('starts a new thread and resumes the earlier thread from history', () => {
		sendDocumentChatMessage({ path: DOC_PATH, text: 'original question' });
		render(<Harness />);
		fireEvent.click(screen.getByRole('button', { name: /^New chat/ }));
		fireEvent.change(screen.getByTestId('document-chat-input'), {
			target: { value: 'new question' },
		});
		fireEvent.click(screen.getByTestId('document-chat-send'));
		expect(screen.queryByText('original question')).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /^Recent chats/ }));
		fireEvent.click(screen.getByText('original question'));
		expect(screen.queryByTestId('document-chat-history-picker')).not.toBeInTheDocument();
		expect(screen.getByText('original question')).toBeInTheDocument();
		expect(screen.queryByText('new question')).not.toBeInTheDocument();
	});
	it('stages an attached image, sends it, and clears the image draft', async () => {
		render(<Harness />);
		const file = new File(['image'], 'example.png', { type: 'image/png' });
		fireEvent.change(screen.getByTestId('document-chat-image-input'), {
			target: { files: [file] },
		});
		await waitFor(() => expect(screen.getByTestId('document-chat-send')).toBeEnabled());
		expect(screen.getByRole('button', { name: 'Staged image 1' })).toBeInTheDocument();
		fireEvent.click(screen.getByTestId('document-chat-send'));
		expect(useSessionStore.getState().sessions[0].executionQueue?.[0].images).toHaveLength(1);
		expect(screen.queryByRole('button', { name: 'Staged image 1' })).not.toBeInTheDocument();
		expect(screen.getByAltText('Attachment 1')).toBeInTheDocument();
	});
	it('keeps typing available when A Cappella is off', () => {
		enableVoice(false);
		render(<Harness />);
		expect(screen.getByTestId('document-chat-input')).toBeEnabled();
	});

	it('remembers the chat font size across unmount and reopen', () => {
		sendDocumentChatMessage({ path: DOC_PATH, text: 'hello' });
		const { unmount } = render(<Harness />);
		const before = screen.getByTestId('document-chat-messages').style.fontSize;
		fireEvent.click(screen.getByRole('button', { name: 'Increase chat font size' }));
		const larger = screen.getByTestId('document-chat-messages').style.fontSize;
		expect(larger).not.toBe(before);
		unmount();
		render(<Harness />);
		expect(screen.getByTestId('document-chat-messages').style.fontSize).toBe(larger);
	});

	it('will not send an empty message', () => {
		render(<Harness />);

		expect(screen.getByTestId('document-chat-send')).toBeDisabled();
		fireEvent.change(screen.getByTestId('document-chat-input'), { target: { value: 'hello' } });
		expect(screen.getByTestId('document-chat-send')).toBeEnabled();
	});

	it('sends on Enter and clears the box', () => {
		render(<Harness />);
		const input = screen.getByTestId('document-chat-input');

		fireEvent.change(input, { target: { value: 'what is this?' } });
		fireEvent.keyDown(input, { key: 'Enter' });

		expect(input).toHaveValue('');
		expect(useSessionStore.getState().sessions[0].executionQueue).toHaveLength(1);
	});

	it('keeps Shift+Enter as a line break', () => {
		render(<Harness />);
		const input = screen.getByTestId('document-chat-input');

		fireEvent.change(input, { target: { value: 'first line' } });
		fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });

		expect(input).toHaveValue('first line');
		expect(useSessionStore.getState().sessions[0].executionQueue ?? []).toHaveLength(0);
	});

	it('closes with ESC and reopens the same conversation', () => {
		sendDocumentChatMessage({ path: DOC_PATH, text: 'keep this question' });
		const before = useSessionStore.getState().sessions[0];
		const onOpenChange = vi.fn();
		const { rerender } = render(<Harness onOpenChange={onOpenChange} />);
		fireEvent.click(screen.getByTestId('document-chat-close'));
		expect(onOpenChange).toHaveBeenLastCalledWith(false);
		rerender(<Harness open={false} onOpenChange={onOpenChange} />);
		expect(screen.queryByTestId('document-chat-panel')).not.toBeInTheDocument();
		fireEvent.click(screen.getByTestId('document-chat-button'));
		expect(onOpenChange).toHaveBeenLastCalledWith(true);
		rerender(<Harness open onOpenChange={onOpenChange} />);
		expect(screen.getByText('keep this question')).toBeInTheDocument();
		expect(useSessionStore.getState().sessions[0]).toBe(before);
	});

	it('shows the conversation for THIS document and no other', () => {
		sendDocumentChatMessage({ path: DOC_PATH, text: 'about the overview' });
		sendDocumentChatMessage({ path: '/repo/README.md', text: 'about the readme' });
		render(<Harness />);

		expect(screen.getByText('about the overview')).toBeInTheDocument();
		expect(screen.getByTestId('document-chat-message-you')).toHaveStyle({
			backgroundColor: mockTheme.colors.bgActivity,
		});
		expect(screen.getByTestId('document-chat-messages')).toHaveClass('overflow-y-auto');
		expect(screen.queryByText('about the readme')).not.toBeInTheDocument();
	});

	it('starts as a compact composer named for the document, without an empty transcript', () => {
		render(<Harness />);

		expect(screen.getByTestId('document-chat-panel')).toHaveTextContent('system-overview.md');
		expect(screen.queryByTestId('document-chat-messages')).not.toBeInTheDocument();
		expect(screen.getByTestId('document-chat-input')).toHaveFocus();
		expect(screen.getByTestId('document-chat-panel').style.height).toBe('');
		expect(screen.getByTestId('document-chat-panel')).toHaveClass('absolute');
		expect(screen.getByTestId('document-chat-composer')).toHaveStyle({
			backgroundColor: mockTheme.colors.bgActivity,
		});
		expect(screen.getByTestId('document-chat-send')).toHaveStyle({
			backgroundColor: mockTheme.colors.accent,
		});
	});
});

describe('DocumentChatMessages', () => {
	it('shows progress even before the first transcript message arrives', () => {
		render(<DocumentChatMessages theme={mockTheme} messages={[]} busy />);
		expect(screen.getByTestId('document-chat-thinking')).toHaveTextContent('Thinking...');
	});

	it('keeps error text literal and distinct from replies', () => {
		render(
			<DocumentChatMessages
				theme={mockTheme}
				messages={[{ id: 'error-1', kind: 'system', text: 'Cannot read **file**', ts: 1 }]}
				busy={false}
			/>
		);
		expect(screen.getByTestId('document-chat-message-system')).toHaveTextContent(
			'Cannot read **file**'
		);
		expect(screen.getByTestId('document-chat-message-system')).toHaveStyle({
			color: mockTheme.colors.error,
		});
	});
});
