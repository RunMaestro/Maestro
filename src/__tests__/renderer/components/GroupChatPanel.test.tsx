import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GroupChatPanel } from '../../../renderer/components/GroupChatPanel';
import type { Theme } from '../../../renderer/types';

const componentMocks = vi.hoisted(() => ({
	GroupChatHeader: vi.fn(() => null),
	GroupChatInput: vi.fn(() => null),
	GroupChatMessages: vi.fn(() => null),
}));

vi.mock('../../../renderer/components/GroupChatHeader', () => ({
	GroupChatHeader: componentMocks.GroupChatHeader,
}));
vi.mock('../../../renderer/components/GroupChatInput', () => ({
	GroupChatInput: componentMocks.GroupChatInput,
}));
vi.mock('../../../renderer/components/GroupChatMessages', async () => {
	const ReactActual = await vi.importActual<typeof import('react')>('react');
	return {
		GroupChatMessages: ReactActual.forwardRef((props, ref) => {
			componentMocks.GroupChatMessages(props, ref);
			return null;
		}),
	};
});

const mockTheme: Theme = {
	id: 'test-dark',
	name: 'Test Dark',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#202020',
		bgActivity: '#2a2a2a',
		border: '#333333',
		textMain: '#ffffff',
		textDim: '#999999',
		textFaint: '#666666',
		accent: '#4a9eff',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
		buttonBg: '#333333',
		buttonHover: '#444444',
		headerBg: '#202020',
		scrollbarTrack: '#111111',
		scrollbarThumb: '#444444',
	},
};

describe('GroupChatPanel', () => {
	it('composes header, messages, and input with the expected group chat props', () => {
		const onSendMessage = vi.fn();
		const onStopAll = vi.fn();
		const onRename = vi.fn();
		const onShowInfo = vi.fn();
		const onToggleRightPanel = vi.fn();
		const onDraftChange = vi.fn();
		const onOpenPromptComposer = vi.fn();
		const setStagedImages = vi.fn();
		const setReadOnlyMode = vi.fn();
		const handlePaste = vi.fn();
		const handleDrop = vi.fn();
		const onOpenLightbox = vi.fn();
		const onRemoveQueuedItem = vi.fn();
		const onReorderQueuedItems = vi.fn();
		const onToggleMarkdownEditMode = vi.fn();
		const setEnterToSendAI = vi.fn();
		const showFlashNotification = vi.fn();
		const inputRef = React.createRef<HTMLTextAreaElement>();
		const messagesRef = React.createRef<never>();
		const shortcuts = { stop: { key: 'Escape', label: 'Stop' } };
		const participants = [
			{ sessionId: 'agent-1', name: 'Agent One' },
			{ sessionId: 'agent-2', name: 'Agent Two' },
		];
		const messages = [{ id: 'msg-1', content: 'Hello' }];
		const state = { isRunning: true };
		const sessions = [{ id: 'agent-1', name: 'Agent One' }];
		const groups = [{ id: 'group-a', name: 'Group A' }];
		const executionQueue = [{ id: 'queue-1', prompt: 'Queued work' }];
		const participantColors = { 'agent-1': '#f00' };

		render(
			<GroupChatPanel
				theme={mockTheme}
				groupChat={{
					id: 'group-1',
					name: 'Planning Room',
					participants,
					draftMessage: 'Draft message',
				}}
				messages={messages as never}
				state={state as never}
				totalCost={1.23}
				costIncomplete={true}
				onSendMessage={onSendMessage}
				onStopAll={onStopAll}
				onRename={onRename}
				onShowInfo={onShowInfo}
				rightPanelOpen={false}
				onToggleRightPanel={onToggleRightPanel}
				shortcuts={shortcuts as never}
				sessions={sessions as never}
				groups={groups as never}
				onDraftChange={onDraftChange}
				onOpenPromptComposer={onOpenPromptComposer}
				stagedImages={['image-a']}
				setStagedImages={setStagedImages}
				readOnlyMode={true}
				setReadOnlyMode={setReadOnlyMode}
				inputRef={inputRef}
				handlePaste={handlePaste}
				handleDrop={handleDrop}
				onOpenLightbox={onOpenLightbox}
				executionQueue={executionQueue as never}
				onRemoveQueuedItem={onRemoveQueuedItem}
				onReorderQueuedItems={onReorderQueuedItems}
				markdownEditMode={true}
				onToggleMarkdownEditMode={onToggleMarkdownEditMode}
				maxOutputLines={50}
				enterToSendAI={false}
				setEnterToSendAI={setEnterToSendAI}
				showFlashNotification={showFlashNotification}
				participantColors={participantColors}
				messagesRef={messagesRef}
			/>
		);

		expect(componentMocks.GroupChatHeader.mock.calls[0][0]).toEqual(
			expect.objectContaining({
				theme: mockTheme,
				name: 'Planning Room',
				participantCount: 2,
				totalCost: 1.23,
				costIncomplete: true,
				state,
				onStopAll,
				onRename,
				onShowInfo,
				rightPanelOpen: false,
				onToggleRightPanel,
				shortcuts,
			})
		);
		expect(componentMocks.GroupChatMessages.mock.calls[0][0]).toEqual(
			expect.objectContaining({
				theme: mockTheme,
				messages,
				participants,
				state,
				markdownEditMode: true,
				onToggleMarkdownEditMode,
				maxOutputLines: 50,
				participantColors,
			})
		);
		expect(componentMocks.GroupChatInput.mock.calls[0][0]).toEqual(
			expect.objectContaining({
				theme: mockTheme,
				state,
				onSend: onSendMessage,
				participants,
				sessions,
				groups,
				groupChatId: 'group-1',
				draftMessage: 'Draft message',
				onDraftChange,
				onOpenPromptComposer,
				stagedImages: ['image-a'],
				setStagedImages,
				readOnlyMode: true,
				setReadOnlyMode,
				inputRef,
				handlePaste,
				handleDrop,
				onOpenLightbox,
				executionQueue,
				onRemoveQueuedItem,
				onReorderQueuedItems,
				enterToSendAI: false,
				setEnterToSendAI,
				showFlashNotification,
				shortcuts,
			})
		);
	});
});
