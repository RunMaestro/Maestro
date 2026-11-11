import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MessagePinsPanel } from '../../../../renderer/components/TerminalOutput/components/MessagePinsPanel';
import { useUIStore } from '../../../../renderer/stores/uiStore';
import { renamePinnedMessage } from '../../../../renderer/services/messagePins';
import { mockTheme } from '../../../helpers/mockTheme';
import { createMockAITab } from '../../../helpers';
import type { LogEntry } from '../../../../renderer/types';

vi.mock('../../../../renderer/services/messagePins', () => ({
	renamePinnedMessage: vi.fn(),
	unpinMessage: vi.fn(),
}));

describe('MessagePinsPanel', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useUIStore.setState({ messagePinsTabId: 'tab-1' });
	});

	it('leaves Enter to the input method while editing a pin label', () => {
		const tab = createMockAITab({
			id: 'tab-1',
			pinnedMessages: [
				{
					id: 'pin-1',
					messageId: 'msg-1',
					title: 'Test Pin',
					excerpt: 'Test message excerpt',
					timestamp: Date.now(),
					source: 'user',
				},
			],
		});
		const rows: LogEntry[] = [
			{ id: 'msg-1', text: 'Test message', source: 'user', timestamp: Date.now() },
		];

		render(
			<MessagePinsPanel
				theme={mockTheme}
				sessionId="session-1"
				tab={tab}
				rows={rows}
				scrollContainerRef={{ current: document.createElement('div') }}
				onScrollToBottom={vi.fn()}
				onJumpToRow={vi.fn()}
				returnFocusRef={{ current: document.createElement('button') }}
			/>
		);

		const renameBtn = screen.getByLabelText('Rename pin');
		fireEvent.click(renameBtn);

		const input = screen.getByTestId('message-pin-rename-input');
		expect(input).toBeInTheDocument();

		for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
			fireEvent.keyDown(input, { key: 'Enter', ...ime });
			expect(renamePinnedMessage).not.toHaveBeenCalled();
			expect(screen.getByTestId('message-pin-rename-input')).toBeInTheDocument();
		}

		fireEvent.change(input, { target: { value: 'New Label' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(renamePinnedMessage).toHaveBeenCalledWith('session-1', 'tab-1', 'pin-1', 'New Label');
	});
});
