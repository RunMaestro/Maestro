// Source: src/__tests__/renderer/components/TerminalOutput/MessagePinsPanel.test.tsx
// Source: src/__tests__/renderer/services/messagePins.test.ts
import type {} from '../../../../renderer/global';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { MessagePinsPanel } from '../../../../renderer/components/TerminalOutput/components/MessagePinsPanel';
import { useUIStore } from '../../../../renderer/stores/uiStore';
import { renamePinnedMessage } from '../../../../renderer/services/messagePins';
import { mockTheme } from '../../../helpers/mockTheme';
import { createMockAITab } from '../../../helpers';
import type { LogEntry } from '../../../../renderer/types';
import * as messagePins from '../../../../renderer/services/messagePins';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { pinnableRows } from '../../../../renderer/services/messagePins';
import { runRemoteMessagePinCommand } from '../../../../renderer/services/messagePins';
import { summarizeTabPins } from '../../../../renderer/services/messagePins';
import { toggleMessagePin } from '../../../../renderer/services/messagePins';
import { unpinMessage } from '../../../../renderer/services/messagePins';
import { createMockSession } from '../../../helpers/mockSession';
import type { AITab } from '../../../../renderer/types';
describe('MessagePinsPanel', () => {
	describe('MessagePinsPanel', () => {
		afterEach(() => vi.restoreAllMocks());
		beforeEach(() => {
			vi.clearAllMocks();
			vi.spyOn(messagePins, 'renamePinnedMessage').mockReturnValue(false);
			vi.spyOn(messagePins, 'unpinMessage').mockReturnValue(false);
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
});
describe('messagePins', () => {
	const logs: LogEntry[] = [
		{ id: 'u1', timestamp: 100, source: 'user', text: 'What is the plan?' },
		{ id: 'a1', timestamp: 110, source: 'stdout', text: '## The plan\n\nFirst ' },
		{ id: 'a2', timestamp: 111, source: 'stdout', text: 'we build it.' },
		{ id: 't1', timestamp: 112, source: 'tool', text: 'ran ls' },
		{ id: 'u2', timestamp: 200, source: 'user', text: 'Thanks' },
	];

	function seed(tab: Partial<AITab> = {}) {
		const aiTab = createMockAITab({ id: 'tab-1', agentSessionId: 'prov-1', logs, ...tab });
		const session = createMockSession({
			id: 'agent-1',
			toolType: 'claude-code',
			projectRoot: '/project',
			aiTabs: [aiTab],
			activeTabId: 'tab-1',
		});
		useSessionStore.setState({ sessions: [session], activeSessionId: 'agent-1' });
	}

	const tab = () => useSessionStore.getState().sessions[0].aiTabs[0];
	const setSessionPins = () =>
		window.maestro.agentSessions.setSessionPins as ReturnType<typeof vi.fn>;

	describe('messagePins service', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			useUIStore.setState({ messagePinsTabId: null });
			seed();
		});

		it('offers one row per reply and per user message, as the transcript draws them', () => {
			const rows = pinnableRows(logs);
			expect(rows.map((r) => r.id)).toEqual(['u1', 'a1', 'u2']);
			expect(rows[1].text).toBe('## The plan\n\nFirst we build it.');
		});

		it('pins a row, mirrors it, and unpins it on the second toggle', () => {
			const reply = pinnableRows(logs)[1];
			expect(toggleMessagePin('agent-1', 'tab-1', reply)).toBe('pinned');
			expect(tab().pinnedMessages).toHaveLength(1);
			expect(tab().pinnedMessages?.[0]).toMatchObject({ logId: 'a1', title: 'The plan' });
			expect(setSessionPins()).toHaveBeenLastCalledWith(
				'claude-code',
				'/project',
				'prov-1',
				tab().pinnedMessages
			);

			expect(toggleMessagePin('agent-1', 'tab-1', reply)).toBe('unpinned');
			expect(tab().pinnedMessages).toBeUndefined();
			expect(setSessionPins()).toHaveBeenLastCalledWith('claude-code', '/project', 'prov-1', []);
		});

		it('refuses a row that cannot be pinned', () => {
			expect(toggleMessagePin('agent-1', 'tab-1', logs[3])).toBeNull();
			expect(tab().pinnedMessages).toBeUndefined();
		});

		it('keeps pins on the tab but skips the mirror before the tab has a provider session', () => {
			seed({ agentSessionId: null });
			toggleMessagePin('agent-1', 'tab-1', pinnableRows(logs)[0]);
			expect(tab().pinnedMessages).toHaveLength(1);
			expect(setSessionPins()).not.toHaveBeenCalled();
		});

		it('renames and unpins by pin id, and closes the panel with the last pin', () => {
			toggleMessagePin('agent-1', 'tab-1', pinnableRows(logs)[0]);
			const pinId = tab().pinnedMessages![0].id;
			useUIStore.setState({ messagePinsTabId: 'tab-1' });

			renamePinnedMessage('agent-1', 'tab-1', pinId, 'Kickoff');
			expect(summarizeTabPins(tab())[0]).toMatchObject({ label: 'Kickoff', renamed: true });

			unpinMessage('agent-1', 'tab-1', pinId);
			expect(tab().pinnedMessages).toBeUndefined();
			expect(useUIStore.getState().messagePinsTabId).toBeNull();
		});

		describe('runRemoteMessagePinCommand', () => {
			const run = (request: Record<string, unknown>) =>
				runRemoteMessagePinCommand({ sessionId: 'agent-1', tabId: 'tab-1', ...request } as never);

			it('answers an unknown tab instead of throwing', () => {
				expect(run({ action: 'list', tabId: 'nope' })).toEqual({
					success: false,
					error: 'AI tab not found: nope',
				});
			});

			it('pins the newest agent reply with --last, and reports a repeat as already pinned', () => {
				const first = run({ action: 'add', last: 'agent' });
				expect(first).toMatchObject({ success: true, pin: { messageId: 'a1', loaded: true } });
				const again = run({ action: 'add', last: 'agent' });
				expect(again).toMatchObject({ success: true, alreadyPinned: true });
				expect(tab().pinnedMessages).toHaveLength(1);
			});

			it('pins by a raw entry id, folding a later reply chunk into its reply', () => {
				const result = run({ action: 'add', messageId: 'a2' });
				expect(result).toMatchObject({ success: true, pin: { messageId: 'a1' } });
			});

			it('refuses a tool entry and an ambiguous prefix', () => {
				expect(run({ action: 'add', messageId: 't1' })).toMatchObject({ success: false });
				expect(run({ action: 'add', messageId: 'u' })).toMatchObject({
					success: false,
					error: expect.stringContaining('matches 2 messages'),
				});
			});

			it('renames and removes by pin id prefix', () => {
				run({ action: 'add', messageId: 'u1' });
				const pinId = tab().pinnedMessages![0].id;
				expect(run({ action: 'rename', pinId: pinId.slice(0, 6), label: 'Start' })).toMatchObject({
					success: true,
					pin: { label: 'Start' },
				});
				expect(run({ action: 'remove', pinId })).toMatchObject({ success: true, pins: [] });
			});

			it('show focuses the tab and opens its panel, and refuses a tab with no pins', () => {
				expect(run({ action: 'show' })).toMatchObject({ success: false });
				run({ action: 'add', messageId: 'u1' });
				const selectAgent = vi.fn();
				expect(
					runRemoteMessagePinCommand(
						{ action: 'show', sessionId: 'agent-1', tabId: 'tab-1' },
						{ selectAgent }
					)
				).toMatchObject({ success: true });
				expect(selectAgent).toHaveBeenCalledWith('agent-1');
				expect(useUIStore.getState().messagePinsTabId).toBe('tab-1');
			});
		});
	});
});
