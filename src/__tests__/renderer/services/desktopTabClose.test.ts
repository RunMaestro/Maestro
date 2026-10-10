import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	requestDesktopTabClose,
	requestDesktopTabCloses,
	reopenDesktopTabIfNeeded,
} from '../../../renderer/services/desktopTabClose';
import { updateAiTab, useSessionStore } from '../../../renderer/stores/sessionStore';
import { useComposerInputStore } from '../../../renderer/stores/composerInputStore';
import { useTabStore } from '../../../renderer/stores/tabStore';
import { clearLiveDraft, getLiveDraft, setLiveDraft } from '../../../renderer/utils/liveDraftStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import {
	createMockAITab,
	createMockFileTab,
	getSession,
	resetTabHandlerStores,
	setupSession,
} from '../hooks/tabs/internal/testUtils';

vi.mock('../../../renderer/utils/runtimeContext', () => ({ isWebDesktop: () => true }));
vi.mock('../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));

describe('desktop conversation lifecycle', () => {
	beforeEach(() => {
		resetTabHandlerStores();
		clearLiveDraft('restored');
		useComposerInputStore.setState(useComposerInputStore.getInitialState(), true);
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

	it.each(['ai', 'file', 'empty'] as const)(
		'reopens the newest conversation after a queued close (previous history: %s)',
		async (previousHistory) => {
			const older = createMockAITab({ id: 'older', agentSessionId: 'older-provider' });
			setupSession({
				id: 'session-1',
				aiTabs: [createMockAITab({ id: 'original' }), createMockAITab({ id: 'other' })],
				unifiedClosedTabHistory:
					previousHistory === 'empty'
						? []
						: previousHistory === 'ai'
							? [{ type: 'ai', tab: older, closedAt: 1, unifiedIndex: 0 }]
							: [
									{
										type: 'file',
										tab: createMockFileTab({ id: 'old-file' }),
										closedAt: 1,
										unifiedIndex: 0,
									},
								],
			});
			const olderHistory = getSession().unifiedClosedTabHistory;
			let confirm!: (closed: boolean) => void;
			window.maestro.web.requestCloseTab = vi.fn(
				() =>
					new Promise<boolean>((resolve) => {
						confirm = resolve;
					})
			);
			const closing = requestDesktopTabClose('session-1', 'original');
			await vi.waitFor(() => expect(window.maestro.web.requestCloseTab).toHaveBeenCalledOnce());
			// Both the store and keyboard path must enqueue behind the unconfirmed close.
			useTabStore.getState().reopenClosedTab();
			expect(window.maestro.web.requestReopenTab).not.toHaveBeenCalled();
			confirm(true);
			await closing;
			await vi.waitFor(() => expect(getSession().activeTabId).toBe('restored'));
			expect(window.maestro.web.requestReopenTab).toHaveBeenCalledWith('session-1', 'original');
			expect(getSession().unifiedClosedTabHistory).toEqual(olderHistory);
			expect(getSession().filePreviewTabs).toEqual([]);
		}
	);

	it.each(['persisted', 'live', 'cleared'] as const)(
		'preserves newer %s browser text and images between inventory and reopen acknowledgement',
		async (edit) => {
			const cached = { id: 'cached', timestamp: 1, source: 'ai', text: 'before' } as const;
			const live = { id: 'live', timestamp: 2, source: 'ai', text: 'after' } as const;
			setupSession({
				id: 'session-1',
				aiTabs: [
					createMockAITab({
						id: 'original',
						inputValue: 'old draft',
						stagedImages: ['old-image'],
						logs: [cached],
					}),
				],
			});
			await requestDesktopTabClose('session-1', 'original');
			let confirm!: (value: { tabId: string }) => void;
			window.maestro.web.requestReopenTab = vi.fn(
				() =>
					new Promise((resolve) => {
						confirm = resolve;
					})
			);
			reopenDesktopTabIfNeeded(getSession());
			await vi.waitFor(() => expect(window.maestro.web.requestReopenTab).toHaveBeenCalledOnce());
			// Desktop inventory exposes the canonical tab before the RPC response.
			useSessionStore.setState({
				sessions: [
					{
						...getSession(),
						aiTabs: [createMockAITab({ id: 'restored', inputValue: 'owner draft', logs: [live] })],
						unifiedTabOrder: [{ type: 'ai', id: 'restored' }],
					},
				],
			});
			const text = edit === 'cleared' ? '' : 'new browser draft';
			if (edit === 'persisted')
				updateAiTab('session-1', 'restored', (tab) => ({ ...tab, inputValue: text }));
			else setLiveDraft('restored', text); // Keystrokes have not flushed to tab.inputValue yet.
			const images = edit === 'cleared' ? [] : ['new-image'];
			updateAiTab('session-1', 'restored', (tab) => ({ ...tab, stagedImages: images }));
			confirm({ tabId: 'restored' });
			await vi.waitFor(() => expect(getSession().unifiedClosedTabHistory).toEqual([]));
			expect(getSession().aiTabs[0]).toMatchObject({
				inputValue: text,
				stagedImages: images,
				logs: [cached, live],
			});
			expect(getSession().aiTabs.map((tab) => tab.id)).toEqual(['restored']);
		}
	);

	it.each(['text', 'images'] as const)(
		'restores untouched snapshot fields while preserving changed %s',
		async (field) => {
			setupSession({
				id: 'session-1',
				aiTabs: [
					createMockAITab({
						id: 'original',
						inputValue: 'saved draft',
						stagedImages: ['saved-image'],
					}),
				],
			});
			await requestDesktopTabClose('session-1', 'original');
			window.maestro.web.requestReopenTab = vi.fn(async () => {
				useSessionStore.setState({
					sessions: [{ ...getSession(), aiTabs: [createMockAITab({ id: 'restored' })] }],
				});
				updateAiTab('session-1', 'restored', (tab) => ({
					...tab,
					...(field === 'text' ? { inputValue: 'new text' } : { stagedImages: ['new-image'] }),
				}));
				return { tabId: 'restored' };
			});
			reopenDesktopTabIfNeeded(getSession());
			await vi.waitFor(() => expect(getSession().unifiedClosedTabHistory).toEqual([]));
			expect(getSession().aiTabs[0]).toMatchObject({
				inputValue: field === 'text' ? 'new text' : 'saved draft',
				stagedImages: field === 'images' ? ['new-image'] : ['saved-image'],
			});
		}
	);

	it('preserves a live draft typed and then emptied even when inventory began empty', async () => {
		setupSession({
			id: 'session-1',
			aiTabs: [createMockAITab({ id: 'original', inputValue: 'old snapshot' })],
		});
		await requestDesktopTabClose('session-1', 'original');
		window.maestro.web.requestReopenTab = vi.fn(async () => {
			useSessionStore.setState({
				sessions: [{ ...getSession(), aiTabs: [createMockAITab({ id: 'restored' })] }],
			});
			const composer = useComposerInputStore.getState();
			composer.loadAiDraft('restored', '', 'off');
			composer.setAiValue('typed after inventory');
			setLiveDraft('restored', 'typed after inventory');
			composer.setAiValue('');
			setLiveDraft('restored', '');
			return { tabId: 'restored' };
		});
		reopenDesktopTabIfNeeded(getSession());
		await vi.waitFor(() => expect(getSession().unifiedClosedTabHistory).toEqual([]));
		expect(getSession().aiTabs[0].inputValue).toBe('');
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
		window.maestro.web.requestReopenTab = vi.fn().mockResolvedValue({ tabId: 'restored' });
		reopenDesktopTabIfNeeded(getSession());
		await vi.waitFor(() => expect(getSession().activeTabId).toBe('restored'));
	});

	it('does not reopen the same entry twice when the shortcut is repeated before its reply', async () => {
		await requestDesktopTabClose('session-1', 'other');
		await requestDesktopTabClose('session-1', 'original');
		reopenDesktopTabIfNeeded(getSession());
		reopenDesktopTabIfNeeded(getSession());
		await vi.waitFor(() => expect(getSession().activeTabId).toBe('restored'));
		expect(window.maestro.web.requestReopenTab).toHaveBeenCalledOnce();
		expect(getSession().unifiedClosedTabHistory.map((entry) => entry.tab.id)).toEqual(['other']);
	});
});
