import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	WebSocketMessageHandler,
	type MessageHandlerCallbacks,
	type WebClient,
	type WebClientMessage,
} from '../../main/web-server/handlers/messageHandlers';

vi.mock('../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
}));

function createClient(): WebClient & { socket: { send: ReturnType<typeof vi.fn> } } {
	return {
		id: 'web-client-1',
		connectedAt: Date.now(),
		socket: { send: vi.fn() },
	} as unknown as WebClient & { socket: { send: ReturnType<typeof vi.fn> } };
}

function sent(client: WebClient & { socket: { send: ReturnType<typeof vi.fn> } }) {
	return client.socket.send.mock.calls.map(([payload]) => JSON.parse(payload as string));
}

function lastSent(client: WebClient & { socket: { send: ReturnType<typeof vi.fn> } }) {
	const messages = sent(client);
	return messages[messages.length - 1];
}

async function flushPromises() {
	await Promise.resolve();
	await Promise.resolve();
}

function makeCallbacks(): MessageHandlerCallbacks {
	return {
		getSessionDetail: vi.fn((sessionId: string) => {
			if (sessionId === 'missing') return null;
			if (sessionId === 'busy') return { state: 'busy', inputMode: 'ai' };
			return {
				state: 'idle',
				inputMode: sessionId === 'terminal-session' ? 'terminal' : 'ai',
				agentSessionId: 'agent-session-1',
				cwd: '/repo',
			};
		}),
		executeCommand: vi.fn(async () => true),
		switchMode: vi.fn(async () => true),
		spawnTerminalForWeb: vi.fn(async () => ({ success: true })),
		selectSession: vi.fn(async () => true),
		selectTab: vi.fn(async () => true),
		newTab: vi.fn(async () => ({ tabId: 'new-tab-1' })),
		closeTab: vi.fn(async () => true),
		renameTab: vi.fn(async () => true),
		starTab: vi.fn(async () => true),
		reorderTab: vi.fn(async () => true),
		toggleBookmark: vi.fn(async () => true),
		getSessions: vi.fn(() => [
			{
				id: 'session-1',
				name: 'Session One',
				toolType: 'claude-code',
				state: 'idle',
				inputMode: 'ai',
				cwd: '/repo',
				agentSessionId: null,
			},
			{
				id: 'session-2',
				name: 'Session Two',
				toolType: 'terminal',
				state: 'idle',
				inputMode: 'terminal',
				cwd: '/repo',
				agentSessionId: 'stored-agent-session',
			},
		]),
		getLiveSessionInfo: vi.fn((sessionId: string) =>
			sessionId === 'session-1'
				? { sessionId, agentSessionId: 'live-agent-session', enabledAt: 123 }
				: undefined
		),
		isSessionLive: vi.fn((sessionId: string) => sessionId === 'session-1'),
		openFileTab: vi.fn(async () => true),
		refreshFileTree: vi.fn(async () => true),
		openBrowserTab: vi.fn(async () => true),
		openTerminalTab: vi.fn(async () => true),
		newAITabWithPrompt: vi.fn(async () => ({ success: true, tabId: 'ai-tab-1' })),
		refreshAutoRunDocs: vi.fn(async () => true),
		configureAutoRun: vi.fn(async () => ({ success: true, playbookId: 'playbook-1' })),
		setSessionAutoRunFolder: vi.fn(async () => ({ success: true })),
		getAutoRunDocs: vi.fn(async () => [{ filename: 'plan.md', title: 'Plan' }]),
		getAutoRunDocContent: vi.fn(async () => '# Plan'),
		saveAutoRunDoc: vi.fn(async () => true),
		stopAutoRun: vi.fn(async () => true),
		resetAutoRunDocTasks: vi.fn(async () => true),
		resumeAutoRunError: vi.fn(async () => true),
		skipAutoRunDocument: vi.fn(async () => true),
		abortAutoRunError: vi.fn(async () => true),
		listPlaybooks: vi.fn(async () => [{ id: 'playbook-1', name: 'Playbook' }]),
		createPlaybook: vi.fn(async () => ({ id: 'playbook-1', name: 'Playbook' })),
		updatePlaybook: vi.fn(async () => ({ id: 'playbook-1', name: 'Updated' })),
		deletePlaybook: vi.fn(async () => true),
		getSettings: vi.fn(() => ({ theme: 'dracula', autoScroll: true }) as any),
		setSetting: vi.fn(async () => true),
		getGroups: vi.fn(() => [
			{ id: 'group-1', name: 'Team', emoji: '*', sessionIds: ['session-1'] },
		]),
		createGroup: vi.fn(async () => ({ id: 'group-new' })),
		renameGroup: vi.fn(async () => true),
		deleteGroup: vi.fn(async () => true),
		moveSessionToGroup: vi.fn(async () => true),
		createSession: vi.fn(async () => ({ sessionId: 'session-new' })),
		createWorktreeSession: vi.fn(async () => ({ success: true, sessionId: 'worktree-1' })),
		deleteSession: vi.fn(async () => true),
		renameSession: vi.fn(async () => true),
		updateSessionCwd: vi.fn(async () => ({ success: true })),
		updateSessionSsh: vi.fn(async () => ({ success: true })),
		getGitStatus: vi.fn(async () => ({ branch: 'main', files: [], ahead: 0, behind: 0 })),
		getGitDiff: vi.fn(async () => ({ diff: 'diff --git', files: ['src/a.ts'] })),
		getGitBranchesForSession: vi.fn(async () => ({ branches: ['main'], currentBranch: 'main' })),
		listWorktreesForSession: vi.fn(async () => ({
			worktrees: [{ path: '/workspace', branch: 'main', isBare: false }],
		})),
		getGroupChats: vi.fn(async () => [{ id: 'chat-1' } as any]),
		startGroupChat: vi.fn(async () => ({ chatId: 'chat-2' })),
		getGroupChatState: vi.fn(async () => ({ id: 'chat-1' }) as any),
		stopGroupChat: vi.fn(async () => true),
		sendGroupChatMessage: vi.fn(async () => true),
		mergeContext: vi.fn(async () => true),
		transferContext: vi.fn(async () => true),
		summarizeContext: vi.fn(async () => true),
		createGist: vi.fn(async () => ({ success: true, gistUrl: 'https://gist.example/1' })),
		getCueSubscriptions: vi.fn(async () => [{ id: 'sub-1', name: 'Daily' } as any]),
		toggleCueSubscription: vi.fn(async () => true),
		getCueActivity: vi.fn(async () => [{ id: 'run-1' } as any]),
		triggerCueSubscription: vi.fn(async () => true),
		listCuePipelines: vi.fn(async () => ({ pipelines: [{ id: 'pipe-1' }] })),
		getCuePipeline: vi.fn(async () => ({ id: 'pipe-1' })),
		setCuePipeline: vi.fn(async () => ({ ok: true })),
		removeCuePipeline: vi.fn(async () => ({ ok: true })),
		getUsageDashboard: vi.fn(async () => ({ totalTokensIn: 1 }) as any),
		getAchievements: vi.fn(async () => [{ id: 'achievement-1' } as any]),
		generateDirectorNotesSynopsis: vi.fn(async () => ({
			success: true,
			synopsis: '# Notes',
			generatedAt: Date.now(),
		})),
		writeToTerminal: vi.fn(() => true),
		resizeTerminal: vi.fn(() => true),
		spawnTerminalForWeb: vi.fn(async () => ({ success: true, pid: 123 })),
		killTerminalForWeb: vi.fn(() => true),
		notifyToast: vi.fn(async () => true),
		notifyCenterFlash: vi.fn(async () => true),
		getMarketplaceManifest: vi.fn(async () => ({ playbooks: [] }) as any),
		getMarketplaceDocument: vi.fn(async () => ({ content: '# Doc' })),
		getMarketplaceReadme: vi.fn(async () => ({ content: '# Readme' })),
		importMarketplacePlaybook: vi.fn(async () => ({ success: true }) as any),
		listDesktopSessions: vi.fn(() => [{ sessionId: 'session-1', tabId: 'tab-1' } as any]),
		getSessionHistory: vi.fn(() => ({ tabId: 'tab-1', entries: [] }) as any),
	} as unknown as MessageHandlerCallbacks;
}

describe('WebSocketMessageHandler integration', () => {
	let handler: WebSocketMessageHandler;
	let callbacks: MessageHandlerCallbacks;
	let client: ReturnType<typeof createClient>;

	beforeEach(() => {
		handler = new WebSocketMessageHandler();
		callbacks = makeCallbacks();
		client = createClient();
		handler.setCallbacks(callbacks);
	});

	it('routes health, subscription, command, session, and session-list messages', async () => {
		handler.handleMessage(client, { type: 'ping' });
		expect(lastSent(client)).toMatchObject({ type: 'pong' });

		handler.handleMessage(client, { type: 'subscribe', sessionId: 'session-1' });
		expect(client.subscribedSessionId).toBe('session-1');
		expect(lastSent(client)).toMatchObject({ type: 'subscribed', sessionId: 'session-1' });

		handler.handleMessage(client, { type: 'subscribe' });
		expect(lastSent(client)).toMatchObject({ type: 'subscribed' });

		handler.handleMessage(client, {
			type: 'send_command',
			sessionId: 'session-1',
			command: 'explain status',
			inputMode: 'ai',
		});
		await flushPromises();
		expect(callbacks.executeCommand).toHaveBeenCalledWith(
			'session-1',
			'explain status',
			'ai',
			undefined,
			false,
			undefined
		);
		expect(lastSent(client)).toMatchObject({
			type: 'command_result',
			success: true,
			sessionId: 'session-1',
		});

		handler.handleMessage(client, {
			type: 'send_command',
			sessionId: 'terminal-session',
			command: 'pwd',
		});
		await flushPromises();
		expect(callbacks.executeCommand).toHaveBeenLastCalledWith(
			'terminal-session',
			'pwd',
			undefined,
			undefined,
			false,
			undefined
		);

		handler.handleMessage(client, {
			type: 'switch_mode',
			sessionId: 'session-1',
			mode: 'terminal',
		});
		await flushPromises();
		expect(lastSent(client)).toMatchObject({
			type: 'mode_switch_result',
			success: true,
			mode: 'terminal',
		});

		handler.handleMessage(client, {
			type: 'select_session',
			sessionId: 'session-1',
			tabId: 'tab-1',
		});
		await flushPromises();
		expect(client.subscribedSessionId).toBe('session-1');
		expect(callbacks.selectSession).toHaveBeenCalledWith('session-1', 'tab-1', undefined);
		expect(lastSent(client)).toMatchObject({ type: 'select_session_result', success: true });

		handler.handleMessage(client, { type: 'get_sessions' });
		expect(lastSent(client)).toMatchObject({
			type: 'sessions_list',
			sessions: [
				expect.objectContaining({
					id: 'session-1',
					agentSessionId: 'live-agent-session',
					liveEnabledAt: 123,
					isLive: true,
				}),
				expect.objectContaining({
					id: 'session-2',
					agentSessionId: 'stored-agent-session',
					isLive: false,
				}),
			],
		});

		handler.handleMessage(client, { type: 'unknown_type', payload: 1 });
		expect(lastSent(client)).toMatchObject({
			type: 'echo',
			originalType: 'unknown_type',
			data: { type: 'unknown_type', payload: 1 },
		});
	});

	it('reports command validation, busy, missing callback, rejection, and false-result paths', async () => {
		handler.handleMessage(client, { type: 'send_command', sessionId: 'session-1' });
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Missing sessionId or command',
		});

		handler.handleMessage(client, {
			type: 'send_command',
			sessionId: 'missing',
			command: 'hello',
		});
		expect(lastSent(client)).toMatchObject({ type: 'error', message: 'Session not found' });

		handler.handleMessage(client, {
			type: 'send_command',
			sessionId: 'busy',
			command: 'hello',
		});
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Session is busy - please wait for the current operation to complete',
			sessionId: 'busy',
		});

		callbacks.executeCommand = vi.fn(async () => false);
		handler.setCallbacks({ executeCommand: callbacks.executeCommand });
		handler.handleMessage(client, {
			type: 'send_command',
			sessionId: 'session-1',
			command: 'reject me',
		});
		await flushPromises();
		expect(lastSent(client)).toMatchObject({ type: 'command_result', success: false });

		callbacks.executeCommand = vi.fn(async () => {
			throw new Error('runner failed');
		});
		handler.setCallbacks({ executeCommand: callbacks.executeCommand });
		handler.handleMessage(client, {
			type: 'send_command',
			sessionId: 'session-1',
			command: 'throw',
		});
		await flushPromises();
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Failed to execute command: runner failed',
		});

		const noCommandHandler = new WebSocketMessageHandler();
		noCommandHandler.setCallbacks({ getSessionDetail: callbacks.getSessionDetail });
		noCommandHandler.handleMessage(client, {
			type: 'send_command',
			sessionId: 'session-1',
			command: 'no callback',
		});
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Command execution not configured',
		});
	});

	it('routes tab lifecycle messages through success, missing-input, missing-callback, and rejection paths', async () => {
		const cases: Array<{
			message: WebClientMessage;
			callback: keyof MessageHandlerCallbacks;
			resultType: string;
			successPayload: Record<string, unknown>;
			errorMessage: string;
			missingMessage: WebClientMessage;
			noCallbackMessage: string;
		}> = [
			{
				message: { type: 'select_tab', sessionId: 'session-1', tabId: 'tab-1' },
				callback: 'selectTab',
				resultType: 'select_tab_result',
				successPayload: { tabId: 'tab-1' },
				errorMessage: 'Failed to select tab: select failed',
				missingMessage: { type: 'select_tab', sessionId: 'session-1' },
				noCallbackMessage: 'Tab selection not configured',
			},
			{
				message: { type: 'close_tab', sessionId: 'session-1', tabId: 'tab-1' },
				callback: 'closeTab',
				resultType: 'close_tab_result',
				successPayload: { tabId: 'tab-1' },
				errorMessage: 'Failed to close tab: close failed',
				missingMessage: { type: 'close_tab', sessionId: 'session-1' },
				noCallbackMessage: 'Tab closing not configured',
			},
			{
				message: {
					type: 'rename_tab',
					sessionId: 'session-1',
					tabId: 'tab-1',
					newName: '',
				},
				callback: 'renameTab',
				resultType: 'rename_tab_result',
				successPayload: { tabId: 'tab-1', newName: '' },
				errorMessage: 'Failed to rename tab: rename failed',
				missingMessage: { type: 'rename_tab', sessionId: 'session-1' },
				noCallbackMessage: 'Tab renaming not configured',
			},
			{
				message: { type: 'star_tab', sessionId: 'session-1', tabId: 'tab-1', starred: true },
				callback: 'starTab',
				resultType: 'star_tab_result',
				successPayload: { tabId: 'tab-1', starred: true },
				errorMessage: 'Failed to star tab: star failed',
				missingMessage: { type: 'star_tab', sessionId: 'session-1' },
				noCallbackMessage: 'Tab starring not configured',
			},
		];

		for (const item of cases) {
			handler.handleMessage(client, item.message);
			await flushPromises();
			expect(lastSent(client)).toMatchObject({
				type: item.resultType,
				success: true,
				sessionId: 'session-1',
				...item.successPayload,
			});

			handler.handleMessage(client, item.missingMessage);
			expect(lastSent(client)).toMatchObject({
				type: 'error',
				message: expect.stringContaining('Missing sessionId'),
			});

			const noCallbackHandler = new WebSocketMessageHandler();
			noCallbackHandler.handleMessage(client, item.message);
			expect(lastSent(client)).toMatchObject({
				type: 'error',
				message: item.noCallbackMessage,
			});

			handler.setCallbacks({
				[item.callback]: vi.fn(async () => {
					throw new Error(item.callback.replace(/Tab$/, '').toLowerCase() + ' failed');
				}),
			});
			handler.handleMessage(client, item.message);
			await flushPromises();
			expect(lastSent(client)).toMatchObject({
				type: 'error',
				message: item.errorMessage,
			});
			handler.setCallbacks({ [item.callback]: callbacks[item.callback] as any });
		}
	});

	it('routes new-tab, reorder, bookmark, mode, and session error edges', async () => {
		handler.handleMessage(client, { type: 'new_tab', sessionId: 'session-1' });
		await flushPromises();
		expect(lastSent(client)).toMatchObject({
			type: 'new_tab_result',
			success: true,
			tabId: 'new-tab-1',
		});

		callbacks.newTab = vi.fn(async () => null);
		handler.setCallbacks({ newTab: callbacks.newTab });
		handler.handleMessage(client, { type: 'new_tab', sessionId: 'session-1' });
		await flushPromises();
		expect(lastSent(client)).toMatchObject({ type: 'new_tab_result', success: false });

		callbacks.newTab = vi.fn(async () => {
			throw new Error('new failed');
		});
		handler.setCallbacks({ newTab: callbacks.newTab });
		handler.handleMessage(client, { type: 'new_tab', sessionId: 'session-1' });
		await flushPromises();
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Failed to create tab: new failed',
		});

		handler.handleMessage(client, { type: 'new_tab' });
		expect(lastSent(client)).toMatchObject({ type: 'error', message: 'Missing sessionId' });
		new WebSocketMessageHandler().handleMessage(client, {
			type: 'new_tab',
			sessionId: 'session-1',
		});
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Tab creation not configured',
		});

		handler.setCallbacks({ reorderTab: callbacks.reorderTab });
		handler.handleMessage(client, {
			type: 'reorder_tab',
			sessionId: 'session-1',
			fromIndex: 0,
			toIndex: 2,
		});
		await flushPromises();
		expect(lastSent(client)).toMatchObject({
			type: 'reorder_tab_result',
			success: true,
			fromIndex: 0,
			toIndex: 2,
		});
		handler.handleMessage(client, { type: 'reorder_tab', sessionId: 'session-1', fromIndex: 0 });
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Missing sessionId, fromIndex, or toIndex',
		});
		new WebSocketMessageHandler().handleMessage(client, {
			type: 'reorder_tab',
			sessionId: 'session-1',
			fromIndex: 0,
			toIndex: 1,
		});
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Tab reordering not configured',
		});
		handler.setCallbacks({
			reorderTab: vi.fn(async () => {
				throw new Error('reorder failed');
			}),
		});
		handler.handleMessage(client, {
			type: 'reorder_tab',
			sessionId: 'session-1',
			fromIndex: 0,
			toIndex: 1,
		});
		await flushPromises();
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Failed to reorder tab: reorder failed',
		});

		handler.setCallbacks({ toggleBookmark: callbacks.toggleBookmark });
		handler.handleMessage(client, { type: 'toggle_bookmark', sessionId: 'session-1' });
		await flushPromises();
		expect(lastSent(client)).toMatchObject({ type: 'toggle_bookmark_result', success: true });
		handler.handleMessage(client, { type: 'toggle_bookmark' });
		expect(lastSent(client)).toMatchObject({ type: 'error', message: 'Missing sessionId' });
		new WebSocketMessageHandler().handleMessage(client, {
			type: 'toggle_bookmark',
			sessionId: 'session-1',
		});
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Bookmark toggling not configured',
		});
		handler.setCallbacks({
			toggleBookmark: vi.fn(async () => {
				throw new Error('bookmark failed');
			}),
		});
		handler.handleMessage(client, { type: 'toggle_bookmark', sessionId: 'session-1' });
		await flushPromises();
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Failed to toggle bookmark: bookmark failed',
		});

		handler.handleMessage(client, { type: 'switch_mode', sessionId: 'session-1' });
		expect(lastSent(client)).toMatchObject({ type: 'error', message: 'Missing sessionId or mode' });
		new WebSocketMessageHandler().handleMessage(client, {
			type: 'switch_mode',
			sessionId: 'session-1',
			mode: 'ai',
		});
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Mode switching not configured',
		});
		handler.setCallbacks({
			switchMode: vi.fn(async () => {
				throw new Error('mode failed');
			}),
		});
		handler.handleMessage(client, { type: 'switch_mode', sessionId: 'session-1', mode: 'ai' });
		await flushPromises();
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Failed to switch mode: mode failed',
		});

		handler.handleMessage(client, { type: 'select_session' });
		expect(lastSent(client)).toMatchObject({ type: 'error', message: 'Missing sessionId' });
		new WebSocketMessageHandler().handleMessage(client, {
			type: 'select_session',
			sessionId: 'session-1',
		});
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Session selection not configured',
		});
		handler.setCallbacks({ selectSession: vi.fn(async () => false) });
		handler.handleMessage(client, { type: 'select_session', sessionId: 'session-1' });
		await flushPromises();
		expect(lastSent(client)).toMatchObject({
			type: 'select_session_result',
			success: false,
		});
		handler.setCallbacks({
			selectSession: vi.fn(async () => {
				throw new Error('select failed');
			}),
		});
		handler.handleMessage(client, { type: 'select_session', sessionId: 'session-1' });
		await flushPromises();
		expect(lastSent(client)).toMatchObject({
			type: 'error',
			message: 'Failed to select session: select failed',
		});
	});

	it('routes remaining web, automation, git, chat, cue, terminal, notification, and marketplace messages', async () => {
		const validPlaybook = {
			name: 'Playbook',
			documents: [{ filename: 'plan.md', resetOnCompletion: true }],
			loopEnabled: true,
			maxLoops: 2,
			prompt: 'Run it',
		};
		const messages: WebClientMessage[] = [
			{ type: 'open_file_tab', sessionId: 'session-1', filePath: '/repo/src/App.tsx', focus: true },
			{ type: 'open_browser_tab', sessionId: 'session-1', url: 'https://example.com' },
			{
				type: 'open_terminal_tab',
				sessionId: 'session-1',
				config: { cwd: '/repo', shell: '/bin/zsh', name: 'Shell' },
			},
			{ type: 'new_ai_tab_with_prompt', sessionId: 'session-1', prompt: 'Summarize' },
			{ type: 'refresh_file_tree', sessionId: 'session-1' },
			{ type: 'refresh_auto_run_docs', sessionId: 'session-1' },
			{
				type: 'configure_auto_run',
				sessionId: 'session-1',
				documents: [{ filename: 'plan.md', resetOnCompletion: true }],
				prompt: 'Run plan',
				loopEnabled: true,
				maxLoops: 2,
				saveAsPlaybook: 'Saved Playbook',
				launch: true,
				worktree: {
					enabled: true,
					path: '/repo-worktree',
					branchName: 'feature/test',
					baseBranch: 'main',
					createPROnCompletion: true,
					prTargetBranch: 'main',
				},
			},
			{ type: 'create_worktree_session', parentSessionId: 'session-1', branchName: 'feature/test' },
			{ type: 'set_auto_run_folder', sessionId: 'session-1', folderPath: '/repo/docs' },
			{ type: 'get_auto_run_docs', sessionId: 'session-1' },
			{ type: 'get_auto_run_state', sessionId: 'session-1' },
			{ type: 'get_auto_run_document', sessionId: 'session-1', filename: 'plan.md' },
			{
				type: 'save_auto_run_document',
				sessionId: 'session-1',
				filename: 'plan.md',
				content: '# Updated',
			},
			{ type: 'stop_auto_run', sessionId: 'session-1' },
			{ type: 'reset_auto_run_doc_tasks', sessionId: 'session-1', filename: 'plan.md' },
			{ type: 'resume_auto_run_error', sessionId: 'session-1' },
			{ type: 'skip_auto_run_document', sessionId: 'session-1' },
			{ type: 'abort_auto_run_error', sessionId: 'session-1' },
			{ type: 'list_playbooks', sessionId: 'session-1' },
			{ type: 'create_playbook', sessionId: 'session-1', playbook: validPlaybook },
			{
				type: 'update_playbook',
				sessionId: 'session-1',
				playbookId: 'playbook-1',
				updates: { name: 'Updated' },
			},
			{ type: 'delete_playbook', sessionId: 'session-1', playbookId: 'playbook-1' },
			{ type: 'get_settings' },
			{ type: 'set_setting', key: 'activeThemeId', value: 'dracula' },
			{
				type: 'create_session',
				name: 'New Agent',
				toolType: 'claude-code',
				cwd: '/repo',
				groupId: 'group-1',
				config: { model: 'sonnet' },
			},
			{ type: 'delete_session', sessionId: 'session-1' },
			{ type: 'rename_session', sessionId: 'session-1', newName: 'Renamed' },
			{ type: 'update_session_cwd', sessionId: 'session-1', newCwd: '/tmp' },
			{ type: 'update_session_ssh', sessionId: 'session-1', sshPatch: { enabled: true } },
			{ type: 'get_groups' },
			{ type: 'create_group', name: 'Group', emoji: '*' },
			{ type: 'rename_group', groupId: 'group-1', name: 'Group' },
			{ type: 'delete_group', groupId: 'group-1' },
			{ type: 'move_session_to_group', sessionId: 'session-1', groupId: null },
			{ type: 'get_git_status', sessionId: 'session-1' },
			{ type: 'get_git_diff', sessionId: 'session-1', filePath: 'src/a.ts' },
			{ type: 'get_git_branches', sessionId: 'session-1' },
			{ type: 'list_worktrees', sessionId: 'session-1' },
			{ type: 'get_group_chats' },
			{ type: 'start_group_chat', topic: 'Plan', participantIds: ['session-1', 'session-2'] },
			{ type: 'get_group_chat_state', chatId: 'chat-1' },
			{ type: 'send_group_chat_message', chatId: 'chat-1', message: 'hello' },
			{ type: 'stop_group_chat', chatId: 'chat-1' },
			{ type: 'merge_context', sourceSessionId: 'session-1', targetSessionId: 'session-2' },
			{ type: 'transfer_context', sourceSessionId: 'session-1', targetSessionId: 'session-2' },
			{ type: 'summarize_context', sessionId: 'session-1' },
			{ type: 'create_gist', sessionId: 'session-1', description: 'Summary', public: false },
			{ type: 'get_cue_subscriptions', sessionId: 'session-1' },
			{ type: 'toggle_cue_subscription', subscriptionId: 'sub-1', enabled: false },
			{ type: 'get_cue_activity', sessionId: 'session-1', limit: 5 },
			{ type: 'trigger_cue_subscription', subscriptionName: 'Daily', prompt: 'Run' },
			{ type: 'cue_pipeline_list' },
			{ type: 'cue_pipeline_get', identifier: 'pipe-1' },
			{ type: 'cue_pipeline_set', identifier: 'pipe-1', pipeline: {}, policy: 'replace' },
			{ type: 'cue_pipeline_remove', identifier: 'pipe-1' },
			{ type: 'get_usage_dashboard', timeRange: 'week' },
			{ type: 'get_achievements' },
			{ type: 'generate_director_notes_synopsis', lookbackDays: 7, provider: 'claude-code' },
			{ type: 'terminal_write', sessionId: 'session-1', data: 'ls' },
			{ type: 'terminal_resize', sessionId: 'session-1', cols: 100, rows: 30 },
			{
				type: 'notify_toast',
				message: 'Saved',
				kind: 'success',
				color: 'green',
				durationSeconds: 5,
			},
			{
				type: 'notify_center_flash',
				message: 'Heads up',
				color: 'theme',
				durationMs: 1000,
			},
			{ type: 'marketplace_get_manifest', refresh: true },
			{ type: 'marketplace_get_document', playbookPath: 'pack/playbook', filename: 'README.md' },
			{ type: 'marketplace_get_readme', playbookPath: 'pack/playbook' },
			{
				type: 'marketplace_import_playbook',
				sessionId: 'session-1',
				playbookId: 'playbook-1',
				targetFolderName: 'imported',
			},
			{ type: 'list_desktop_sessions' },
			{ type: 'get_session_history', tabId: 'tab-1', tail: 10 },
		];

		for (const message of messages) {
			handler.handleMessage(client, message);
			await flushPromises();
			expect(lastSent(client), message.type).not.toMatchObject({ type: 'error' });
		}
	});
});
