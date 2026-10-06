import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	requestDesktopTabClose,
	requestDesktopTabCloses,
	reopenDesktopTabIfNeeded,
} from '../../../renderer/services/desktopTabClose';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useTabStore } from '../../../renderer/stores/tabStore';
import { getLiveDraft, setLiveDraft } from '../../../renderer/utils/liveDraftStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import {
	createMockAITab,
	getSession,
	resetTabHandlerStores,
	setupSession,
} from '../hooks/tabs/internal/testUtils';

vi.mock('../../../renderer/utils/runtimeContext', () => ({ isWebDesktop: () => true }));
vi.mock('../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));

describe('desktop conversation lifecycle', () => {
	beforeEach(() => {
		resetTabHandlerStores();
		vi.mocked(notifyToast).mockClear();
		window.maestro.web.requestCloseTab = vi.fn().mockResolvedValue(true);
		window.maestro.web.requestReopenTab = vi.fn().mockResolvedValue({ tabId: 'restored' });
		window.maestro.agentSessions.snapshotStarredTranscript = vi.fn().mockResolvedValue(undefined);
		setupSession({
			id: 'session-1',
			aiTabs: [
				createMockAITab({ id: 'original', agentSessionId: 'provider-1', starred: true }),
				createMockAITab({ id: 'other' }),
			],
		});
	});

	it('preserves drafts, wizard progress and transcripts until the owner confirms closure', async () => {
		const tab = createMockAITab({
			id: 'original',
			starred: true,
			agentSessionId: 'provider-1',
			wizardState: { isActive: true } as any,
		});
		setupSession({ id: 'session-1', aiTabs: [tab] });
		setLiveDraft(tab.id, 'unsent');
		const endWizard = vi.fn().mockResolvedValue(undefined);
		let reply!: (closed: boolean) => void;
		window.maestro.web.requestCloseTab = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					reply = resolve;
				})
		);
		const pending = requestDesktopTabClose('session-1', tab.id, endWizard);
		await vi.waitFor(() => expect(window.maestro.web.requestCloseTab).toHaveBeenCalled());
		expect(getLiveDraft(tab.id)).toBe('unsent');
		expect(endWizard).not.toHaveBeenCalled();
		expect(window.maestro.agentSessions.snapshotStarredTranscript).not.toHaveBeenCalled();
		reply(false);
		expect(await pending).toBe(false);
		expect(getLiveDraft(tab.id)).toBe('unsent');
		expect(endWizard).not.toHaveBeenCalled();
		expect(getSession().unifiedClosedTabHistory).toEqual([]);

		window.maestro.web.requestCloseTab = vi.fn().mockResolvedValue(true);
		await requestDesktopTabClose('session-1', tab.id, endWizard);
		expect(getLiveDraft(tab.id)).toBeUndefined();
		expect(endWizard).toHaveBeenCalledWith(tab.id);
		expect(window.maestro.agentSessions.snapshotStarredTranscript).toHaveBeenCalledOnce();
		expect(getSession().unifiedClosedTabHistory).toEqual([]);
	});

	it('records local history even if inventory removes the tab before the acknowledgement', async () => {
		window.maestro.web.requestCloseTab = vi.fn(async () => {
			useSessionStore.setState({
				sessions: [{ ...getSession(), aiTabs: [getSession().aiTabs[1]] }],
			});
			return true;
		});
		await requestDesktopTabClose('session-1', 'original');
		expect(getSession().unifiedClosedTabHistory).toEqual([
			expect.objectContaining({
				type: 'ai',
				tab: expect.objectContaining({ id: 'original' }),
				unifiedIndex: 0,
			}),
		]);
	});

	it('aggregates batch errors and keeps only confirmed closes in local history', async () => {
		window.maestro.web.requestCloseTab = vi
			.fn()
			.mockResolvedValueOnce(true)
			.mockResolvedValue(false);
		setupSession({
			id: 'session-1',
			aiTabs: ['original', 'other', 'third'].map((id) => createMockAITab({ id })),
		});
		setLiveDraft('other', 'keep');
		expect(await requestDesktopTabCloses('session-1', ['original', 'other', 'third'])).toBe(false);
		expect(notifyToast).toHaveBeenCalledOnce();
		expect(getLiveDraft('other')).toBe('keep');
		expect(getSession().unifiedClosedTabHistory.map((entry) => entry.tab.id)).toEqual(['original']);
	});

	it.each([false, true])(
		'reopens with the owner id and cached transcript (inventory first: %s)',
		async (inventoryFirst) => {
			const log = {
				id: 'log-1',
				timestamp: 1,
				source: 'ai',
				text: 'Original conversation',
			} as const;
			setupSession({ id: 'session-1', aiTabs: [createMockAITab({ id: 'original', logs: [log] })] });
			await requestDesktopTabClose('session-1', 'original');
			window.maestro.web.requestReopenTab = vi.fn(async () => {
				if (inventoryFirst) {
					useSessionStore.setState({
						sessions: [
							{
								...getSession(),
								aiTabs: [createMockAITab({ id: 'restored' })],
								unifiedTabOrder: [{ type: 'ai', id: 'restored' }],
							},
						],
					});
				}
				return { tabId: 'restored' };
			});
			// The same service is used by the keyboard handler and the store action.
			useTabStore.getState().reopenClosedTab();
			await vi.waitFor(() => expect(getSession().activeTabId).toBe('restored'));
			expect(window.maestro.web.requestReopenTab).toHaveBeenCalledWith('session-1', 'original');
			expect(getSession().aiTabs.map((tab) => tab.id)).toEqual(['restored']);
			expect(getSession().aiTabs[0].logs).toEqual([log]);
			expect(getSession().unifiedClosedTabHistory).toEqual([]);
			expect(getSession().unifiedTabOrder).toEqual([{ type: 'ai', id: 'restored' }]);
		}
	);

	it('merges an early inventory and live output with browser-only settings and cached messages', async () => {
		const cached = { id: 'cached', timestamp: 1, source: 'ai', text: 'before close' } as const;
		const live = { id: 'live', timestamp: 2, source: 'ai', text: 'after reopen' } as const;
		setupSession({
			id: 'session-1',
			aiTabs: [
				createMockAITab({
					id: 'original',
					logs: [cached],
					saveToHistory: false,
					showThinking: 'sticky',
					inputValue: 'draft',
				}),
			],
		});
		await requestDesktopTabClose('session-1', 'original');
		window.maestro.web.requestReopenTab = vi.fn(async () => {
			useSessionStore.setState({
				sessions: [
					{
						...getSession(),
						inputMode: 'terminal',
						activeTerminalTabId: 'terminal',
						aiTabs: [
							createMockAITab({
								id: 'restored',
								logs: [live],
								saveToHistory: true,
								showThinking: 'off',
							}),
						],
					},
				],
			});
			return { tabId: 'restored' };
		});
		reopenDesktopTabIfNeeded(getSession());
		await vi.waitFor(() => expect(getSession().activeTabId).toBe('restored'));
		expect(getSession().aiTabs[0]).toMatchObject({
			logs: [cached, live],
			saveToHistory: false,
			showThinking: 'sticky',
			inputValue: 'draft',
		});
		expect(getSession().inputMode).toBe('ai');
		expect(getSession().activeTerminalTabId).toBeNull();
	});

	it('preserves deferred transcript loading under the owner-minted id', async () => {
		setupSession({
			id: 'session-1',
			aiTabs: [createMockAITab({ id: 'original' })],
			deferredContent: { tabIds: ['original'], commands: true },
		});
		await requestDesktopTabClose('session-1', 'original');
		expect(reopenDesktopTabIfNeeded(getSession())).toBe(true);
		await vi.waitFor(() => expect(getSession().activeTabId).toBe('restored'));
		expect(getSession().deferredContent?.tabIds).toContain('restored');
	});

	it('keeps history when restore fails so the browser can retry', async () => {
		await requestDesktopTabClose('session-1', 'original');
		window.maestro.web.requestReopenTab = vi.fn().mockResolvedValue(null);
		reopenDesktopTabIfNeeded(getSession());
		await vi.waitFor(() => expect(notifyToast).toHaveBeenCalled());
		expect(getSession().unifiedClosedTabHistory[0].tab.id).toBe('original');
	});

	it('does not reopen the same entry twice when the shortcut is repeated before its reply', async () => {
		await requestDesktopTabClose('session-1', 'original');
		reopenDesktopTabIfNeeded(getSession());
		reopenDesktopTabIfNeeded(getSession());
		await vi.waitFor(() => expect(getSession().activeTabId).toBe('restored'));
		expect(window.maestro.web.requestReopenTab).toHaveBeenCalledOnce();
	});
});
