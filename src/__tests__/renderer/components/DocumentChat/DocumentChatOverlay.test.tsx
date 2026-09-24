/**
 * Tests for the File Preview's chat bubble.
 *
 * The panel is a view onto a real AI tab, so what is worth asserting here is the
 * things the user can see go wrong: a mode switch that leaves a microphone
 * running, buttons that claim to work on a conversation that has not started,
 * and a chat that draws the previous file's messages.
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { DocumentChatOverlay } from '../../../../renderer/components/DocumentChat';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { sendDocumentChatMessage } from '../../../../renderer/services/documentChat';
import { createMockSession } from '../../../helpers/mockSession';
import { installLocalStorageMock } from '../../../helpers/mockLocalStorage';
import { mockTheme } from '../../../helpers/mockTheme';

const SESSION_ID = 'agent-1';
const DOC_PATH = '/repo/docs/system-overview.md';

function Harness({ open = true, path = DOC_PATH }: { open?: boolean; path?: string }) {
	const buttonRef = React.useRef<HTMLButtonElement>(null);
	const overlayRef = React.useRef<HTMLDivElement>(null);
	return (
		<DocumentChatOverlay
			theme={mockTheme}
			path={path}
			open={open}
			onOpenChange={() => {}}
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
	// jsdom here has no localStorage, so the persisted mode would silently fall
	// back to in-memory and this suite would pass for the wrong reason on CI.
	installLocalStorageMock();
	useSessionStore.setState({
		sessions: [createMockSession({ id: SESSION_ID })],
		activeSessionId: SESSION_ID,
	});
	enableVoice(true);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe('DocumentChatOverlay', () => {
	it('starts in Type mode, with no microphone in the way', () => {
		render(<Harness />);

		expect(screen.getByTestId('document-chat-mode-type')).toHaveAttribute('aria-checked', 'true');
		expect(screen.queryByTestId('document-chat-push')).not.toBeInTheDocument();
	});

	it('offers a microphone in both push modes', () => {
		render(<Harness />);

		fireEvent.click(screen.getByTestId('document-chat-mode-push-to-type'));
		expect(screen.getByTestId('document-chat-push')).toBeInTheDocument();

		fireEvent.click(screen.getByTestId('document-chat-mode-push-to-conversation'));
		expect(screen.getByTestId('document-chat-push')).toBeInTheDocument();
	});

	it('remembers the mode the user chose', () => {
		const { unmount } = render(<Harness />);
		fireEvent.click(screen.getByTestId('document-chat-mode-push-to-conversation'));
		unmount();

		render(<Harness />);
		expect(screen.getByTestId('document-chat-mode-push-to-conversation')).toHaveAttribute(
			'aria-checked',
			'true'
		);
	});

	it('disables push-to-talk, by name, when A Cappella is off', () => {
		enableVoice(false);
		render(<Harness />);
		fireEvent.click(screen.getByTestId('document-chat-mode-push-to-conversation'));

		const push = screen.getByTestId('document-chat-push');
		expect(push).toBeDisabled();
		// Disabled rather than hidden, so the tooltip can say WHY instead of
		// leaving a mode that appears to do nothing.
		expect(push).toHaveAttribute('title', expect.stringContaining('A Cappella'));
	});

	it('still offers typing with A Cappella off', () => {
		enableVoice(false);
		render(<Harness />);

		expect(screen.getByTestId('document-chat-input')).toBeEnabled();
		expect(screen.getByTestId('document-chat-mode-type')).toBeInTheDocument();
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

	it('disables reset and pop-out until there is a conversation', () => {
		render(<Harness />);

		expect(screen.getByTestId('document-chat-reset')).toBeDisabled();
		expect(screen.getByTestId('document-chat-pop-out')).toBeDisabled();
	});

	it('enables them once something has been said', () => {
		sendDocumentChatMessage({ path: DOC_PATH, text: 'hello' });
		render(<Harness />);

		expect(screen.getByTestId('document-chat-reset')).toBeEnabled();
		expect(screen.getByTestId('document-chat-pop-out')).toBeEnabled();
	});

	it('shows the conversation for THIS document and no other', () => {
		sendDocumentChatMessage({ path: DOC_PATH, text: 'about the overview' });
		sendDocumentChatMessage({ path: '/repo/README.md', text: 'about the readme' });
		render(<Harness />);

		expect(screen.getByText('about the overview')).toBeInTheDocument();
		expect(screen.queryByText('about the readme')).not.toBeInTheDocument();
	});

	it('says what the chat is for before anything has been said', () => {
		render(<Harness />);

		expect(screen.getByTestId('document-chat-messages')).toHaveTextContent('system-overview.md');
	});
});
