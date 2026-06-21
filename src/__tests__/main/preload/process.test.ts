/**
 * Tests for process preload API
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron ipcRenderer
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();
const mockSend = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
		send: (...args: unknown[]) => mockSend(...args),
	},
}));

import { createProcessApi, type ProcessConfig } from '../../../main/preload/process';

describe('Process Preload API', () => {
	let api: ReturnType<typeof createProcessApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createProcessApi();
	});

	describe('spawn', () => {
		it('should invoke process:spawn with config', async () => {
			const config: ProcessConfig = {
				sessionId: 'session-123',
				toolType: 'claude-code',
				cwd: '/home/user/project',
				command: 'claude',
				args: ['--json'],
			};
			mockInvoke.mockResolvedValue({ pid: 1234, success: true });

			const result = await api.spawn(config);

			expect(mockInvoke).toHaveBeenCalledWith('process:spawn', config);
			expect(result.pid).toBe(1234);
			expect(result.success).toBe(true);
		});

		it('should handle SSH remote response', async () => {
			const config: ProcessConfig = {
				sessionId: 'session-123',
				toolType: 'claude-code',
				cwd: '/home/user/project',
				command: 'claude',
				args: [],
			};
			mockInvoke.mockResolvedValue({
				pid: 1234,
				success: true,
				sshRemote: { id: 'remote-1', name: 'My Server', host: 'example.com' },
			});

			const result = await api.spawn(config);

			expect(result.sshRemote).toEqual({ id: 'remote-1', name: 'My Server', host: 'example.com' });
		});
	});

	describe('spawnTerminalTab', () => {
		it('should invoke process:spawnTerminalTab with terminal config', async () => {
			const config = {
				sessionId: 'session-123',
				cwd: '/home/user/project',
				shell: '/bin/zsh',
				shellArgs: '-l',
				toolType: 'terminal',
				cols: 120,
				rows: 40,
			};
			mockInvoke.mockResolvedValue({ pid: 5678, success: true });

			const result = await api.spawnTerminalTab(config);

			expect(mockInvoke).toHaveBeenCalledWith('process:spawnTerminalTab', config);
			expect(result).toEqual({ pid: 5678, success: true });
		});
	});

	describe('write', () => {
		it('should invoke process:write with sessionId and data', async () => {
			mockInvoke.mockResolvedValue(true);

			const result = await api.write('session-123', 'Hello');

			expect(mockInvoke).toHaveBeenCalledWith('process:write', 'session-123', 'Hello');
			expect(result).toBe(true);
		});
	});

	describe('interrupt', () => {
		it('should invoke process:interrupt with sessionId', async () => {
			mockInvoke.mockResolvedValue(true);

			const result = await api.interrupt('session-123');

			expect(mockInvoke).toHaveBeenCalledWith('process:interrupt', 'session-123');
			expect(result).toBe(true);
		});
	});

	describe('kill', () => {
		it('should invoke process:kill with sessionId', async () => {
			mockInvoke.mockResolvedValue(true);

			const result = await api.kill('session-123');

			expect(mockInvoke).toHaveBeenCalledWith('process:kill', 'session-123');
			expect(result).toBe(true);
		});
	});

	describe('resize', () => {
		it('should invoke process:resize with sessionId, cols, and rows', async () => {
			mockInvoke.mockResolvedValue(true);

			const result = await api.resize('session-123', 120, 40);

			expect(mockInvoke).toHaveBeenCalledWith('process:resize', 'session-123', 120, 40);
			expect(result).toBe(true);
		});
	});

	describe('runCommand', () => {
		it('should invoke process:runCommand with config', async () => {
			const config = {
				sessionId: 'session-123',
				command: 'ls -la',
				cwd: '/home/user',
				shell: '/bin/bash',
			};
			mockInvoke.mockResolvedValue({ exitCode: 0 });

			const result = await api.runCommand(config);

			expect(mockInvoke).toHaveBeenCalledWith('process:runCommand', config);
			expect(result.exitCode).toBe(0);
		});

		it('should handle SSH remote config', async () => {
			const config = {
				sessionId: 'session-123',
				command: 'ls -la',
				cwd: '/home/user',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '/remote/path',
				},
			};
			mockInvoke.mockResolvedValue({ exitCode: 0 });

			await api.runCommand(config);

			expect(mockInvoke).toHaveBeenCalledWith('process:runCommand', config);
		});
	});

	describe('getActiveProcesses', () => {
		it('should invoke process:getActiveProcesses', async () => {
			const mockProcesses = [
				{
					sessionId: 'session-123',
					toolType: 'claude-code',
					pid: 1234,
					cwd: '/home/user',
					isTerminal: false,
					isBatchMode: false,
					startTime: Date.now(),
				},
			];
			mockInvoke.mockResolvedValue(mockProcesses);

			const result = await api.getActiveProcesses();

			expect(mockInvoke).toHaveBeenCalledWith('process:getActiveProcesses');
			expect(result).toEqual(mockProcesses);
		});
	});

	describe('isTerminalBusy', () => {
		it('should invoke process:isTerminalBusy with the session id', async () => {
			mockInvoke.mockResolvedValue(true);

			const result = await api.isTerminalBusy('session-1-terminal-tab-1');

			expect(mockInvoke).toHaveBeenCalledWith('process:isTerminalBusy', 'session-1-terminal-tab-1');
			expect(result).toBe(true);
		});
	});

	describe('onData', () => {
		it('should register event listener for process:data', () => {
			const callback = vi.fn();

			const cleanup = api.onData(callback);

			expect(mockOn).toHaveBeenCalledWith('process:data', expect.any(Function));
			expect(typeof cleanup).toBe('function');
		});

		it('should call callback with sessionId and data', () => {
			const callback = vi.fn();
			let registeredHandler: (event: unknown, sessionId: string, data: string) => void;

			mockOn.mockImplementation((channel: string, handler: typeof registeredHandler) => {
				if (channel === 'process:data') {
					registeredHandler = handler;
				}
			});

			api.onData(callback);
			registeredHandler!({}, 'session-123', 'output data');

			expect(callback).toHaveBeenCalledWith('session-123', 'output data');
		});
	});

	describe('onExit', () => {
		it('should register event listener for process:exit', () => {
			const callback = vi.fn();

			const cleanup = api.onExit(callback);

			expect(mockOn).toHaveBeenCalledWith('process:exit', expect.any(Function));
			expect(typeof cleanup).toBe('function');
		});
	});

	describe('onUsage', () => {
		it('should register event listener for process:usage', () => {
			const callback = vi.fn();
			let registeredHandler: (event: unknown, sessionId: string, usageStats: unknown) => void;

			mockOn.mockImplementation((channel: string, handler: typeof registeredHandler) => {
				if (channel === 'process:usage') {
					registeredHandler = handler;
				}
			});

			api.onUsage(callback);

			const usageStats = {
				inputTokens: 100,
				outputTokens: 200,
				cacheReadInputTokens: 50,
				cacheCreationInputTokens: 25,
				totalCostUsd: 0.01,
				contextWindow: 100000,
			};
			registeredHandler!({}, 'session-123', usageStats);

			expect(callback).toHaveBeenCalledWith('session-123', usageStats);
		});
	});

	describe('onAgentError', () => {
		it('should register event listener for agent:error', () => {
			const callback = vi.fn();
			let registeredHandler: (event: unknown, sessionId: string, error: unknown) => void;

			mockOn.mockImplementation((channel: string, handler: typeof registeredHandler) => {
				if (channel === 'agent:error') {
					registeredHandler = handler;
				}
			});

			api.onAgentError(callback);

			const error = {
				type: 'auth_expired',
				message: 'Authentication expired',
				recoverable: true,
				agentId: 'claude-code',
				timestamp: Date.now(),
			};
			registeredHandler!({}, 'session-123', error);

			expect(callback).toHaveBeenCalledWith('session-123', error);
		});
	});

	describe('sendRemoteNewTabResponse', () => {
		it('should send response via ipcRenderer.send', () => {
			api.sendRemoteNewTabResponse('response-channel', { tabId: 'tab-123' });

			expect(mockSend).toHaveBeenCalledWith('response-channel', { tabId: 'tab-123' });
		});

		it('should send null result', () => {
			api.sendRemoteNewTabResponse('response-channel', null);

			expect(mockSend).toHaveBeenCalledWith('response-channel', null);
		});
	});

	describe('onRemoteCommand', () => {
		it('should register listener and invoke callback with all parameters including tabId, force, and images', () => {
			const callback = vi.fn();
			let registeredHandler: (
				event: unknown,
				sessionId: string,
				command: string,
				inputMode?: 'ai' | 'terminal',
				tabId?: string,
				force?: boolean,
				images?: string[]
			) => void;

			mockOn.mockImplementation((channel: string, handler: typeof registeredHandler) => {
				if (channel === 'remote:executeCommand') {
					registeredHandler = handler;
				}
			});

			api.onRemoteCommand(callback);
			const images = ['data:image/png;base64,abc'];
			registeredHandler!({}, 'session-123', 'test command', 'ai', 'tab-7', true, images);

			expect(callback).toHaveBeenCalledWith(
				'session-123',
				'test command',
				'ai',
				'tab-7',
				true,
				images
			);
		});

		it('forwards undefined tabId/force/images when the IPC sender omits them (legacy callers)', () => {
			const callback = vi.fn();
			let registeredHandler: (
				event: unknown,
				sessionId: string,
				command: string,
				inputMode?: 'ai' | 'terminal',
				tabId?: string,
				force?: boolean,
				images?: string[]
			) => void;

			mockOn.mockImplementation((channel: string, handler: typeof registeredHandler) => {
				if (channel === 'remote:executeCommand') {
					registeredHandler = handler;
				}
			});

			api.onRemoteCommand(callback);
			registeredHandler!({}, 'session-123', 'test command', 'ai');

			expect(callback).toHaveBeenCalledWith(
				'session-123',
				'test command',
				'ai',
				undefined,
				undefined,
				undefined
			);
		});
	});

	describe('listener wrappers', () => {
		type ListenerCase = {
			method: string;
			channel: string;
			eventArgs: unknown[];
			expectedArgs?: unknown[];
		};

		const captureHandler = (method: string, channel: string, callback = vi.fn()) => {
			let registeredHandler: ((event: unknown, ...args: unknown[]) => void) | undefined;
			mockOn.mockImplementation((registeredChannel: string, handler: typeof registeredHandler) => {
				if (registeredChannel === channel) {
					registeredHandler = handler;
				}
			});

			const cleanup = (api as Record<string, any>)[method](callback);

			expect(mockOn).toHaveBeenCalledWith(channel, expect.any(Function));
			expect(typeof cleanup).toBe('function');
			expect(registeredHandler).toBeDefined();

			return { callback, cleanup, handler: registeredHandler! };
		};

		const listenerCases: ListenerCase[] = [
			{
				method: 'onExit',
				channel: 'process:exit',
				eventArgs: ['session-123', 0],
			},
			{
				method: 'onSessionId',
				channel: 'process:session-id',
				eventArgs: ['session-123', 'agent-session-456'],
			},
			{
				method: 'onSlashCommands',
				channel: 'process:slash-commands',
				eventArgs: ['session-123', ['/help', '/clear']],
			},
			{
				method: 'onThinkingChunk',
				channel: 'process:thinking-chunk',
				eventArgs: ['session-123', 'thinking'],
			},
			{
				method: 'onToolExecution',
				channel: 'process:tool-execution',
				eventArgs: ['session-123', { toolName: 'Read', timestamp: 1 }],
			},
			{
				method: 'onSshRemote',
				channel: 'process:ssh-remote',
				eventArgs: ['session-123', { id: 'remote-1', name: 'Remote', host: 'example.com' }],
			},
			{
				method: 'onClaudeModeResolved',
				channel: 'process:claude-mode-resolved',
				eventArgs: ['session-123', { mode: 'api', reason: 'auto', configDirKey: '/tmp/claude' }],
			},
			{
				method: 'onRemoteSwitchMode',
				channel: 'remote:switchMode',
				eventArgs: ['session-123', 'terminal'],
			},
			{
				method: 'onRemoteInterrupt',
				channel: 'remote:interrupt',
				eventArgs: ['session-123'],
			},
			{
				method: 'onRemoteSelectSession',
				channel: 'remote:selectSession',
				eventArgs: ['session-123', 'tab-1'],
			},
			{
				method: 'onRemoteSelectTab',
				channel: 'remote:selectTab',
				eventArgs: ['session-123', 'tab-1'],
			},
			{
				method: 'onRemoteNewTab',
				channel: 'remote:newTab',
				eventArgs: ['session-123', 'reply:new-tab'],
			},
			{
				method: 'onRemoteCloseTab',
				channel: 'remote:closeTab',
				eventArgs: ['session-123', 'tab-1'],
			},
			{
				method: 'onRemoteRenameTab',
				channel: 'remote:renameTab',
				eventArgs: ['session-123', 'tab-1', 'New name'],
			},
			{
				method: 'onRemoteStarTab',
				channel: 'remote:starTab',
				eventArgs: ['session-123', 'tab-1', true],
			},
			{
				method: 'onRemoteReorderTab',
				channel: 'remote:reorderTab',
				eventArgs: ['session-123', 0, 2],
			},
			{
				method: 'onRemoteToggleBookmark',
				channel: 'remote:toggleBookmark',
				eventArgs: ['session-123'],
			},
			{
				method: 'onRemoteOpenFileTab',
				channel: 'remote:openFileTab',
				eventArgs: ['session-123', '/tmp/file.md'],
				expectedArgs: ['session-123', '/tmp/file.md', true],
			},
			{
				method: 'onRemoteOpenFileTab',
				channel: 'remote:openFileTab',
				eventArgs: ['session-123', '/tmp/file.md', false],
			},
			{
				method: 'onRemoteRefreshFileTree',
				channel: 'remote:refreshFileTree',
				eventArgs: ['session-123'],
			},
			{
				method: 'onRemoteNotifyToast',
				channel: 'remote:notifyToast',
				eventArgs: [{ title: 'Title', message: 'Message', color: 'green' }],
			},
			{
				method: 'onRemoteNotifyCenterFlash',
				channel: 'remote:notifyCenterFlash',
				eventArgs: [{ message: 'Saved', color: 'theme' }],
			},
			{
				method: 'onRemoteRefreshAutoRunDocs',
				channel: 'remote:refreshAutoRunDocs',
				eventArgs: ['session-123'],
			},
			{
				method: 'onRemoteStopAutoRun',
				channel: 'remote:stopAutoRun',
				eventArgs: ['session-123'],
			},
			{
				method: 'onRemoteSetSetting',
				channel: 'remote:setSetting',
				eventArgs: ['theme', 'dark', 'reply:setting'],
			},
			{
				method: 'onRemoteCreateSession',
				channel: 'remote:createSession',
				eventArgs: [
					'Agent',
					'codex',
					'/tmp/project',
					'group-1',
					{ modelId: 'gpt-5' },
					'reply:create',
				],
			},
			{
				method: 'onRemoteDeleteSession',
				channel: 'remote:deleteSession',
				eventArgs: ['session-123'],
			},
			{
				method: 'onRemoteRenameSession',
				channel: 'remote:renameSession',
				eventArgs: ['session-123', 'Renamed', 'reply:rename'],
			},
			{
				method: 'onRemoteUpdateSessionCwd',
				channel: 'remote:updateSessionCwd',
				eventArgs: ['session-123', '/tmp/next', 'reply:cwd'],
			},
			{
				method: 'onRemoteUpdateSessionSsh',
				channel: 'remote:updateSessionSsh',
				eventArgs: ['session-123', { enabled: true }, 'reply:ssh'],
			},
			{
				method: 'onRemoteCreateGroup',
				channel: 'remote:createGroup',
				eventArgs: ['Group', 'G', 'reply:group'],
			},
			{
				method: 'onRemoteRenameGroup',
				channel: 'remote:renameGroup',
				eventArgs: ['group-1', 'Renamed', 'reply:rename-group'],
			},
			{
				method: 'onRemoteDeleteGroup',
				channel: 'remote:deleteGroup',
				eventArgs: ['group-1'],
			},
			{
				method: 'onRemoteMoveSessionToGroup',
				channel: 'remote:moveSessionToGroup',
				eventArgs: ['session-123', null, 'reply:move'],
			},
			{
				method: 'onRemoteGetGroupChats',
				channel: 'remote:getGroupChats',
				eventArgs: ['reply:group-chats'],
			},
			{
				method: 'onRemoteStartGroupChat',
				channel: 'remote:startGroupChat',
				eventArgs: ['Topic', ['session-1', 'session-2'], 'reply:start-chat'],
			},
			{
				method: 'onRemoteGetGroupChatState',
				channel: 'remote:getGroupChatState',
				eventArgs: ['chat-1', 'reply:chat-state'],
			},
			{
				method: 'onRemoteStopGroupChat',
				channel: 'remote:stopGroupChat',
				eventArgs: ['chat-1', 'reply:stop-chat'],
			},
			{
				method: 'onRemoteSendGroupChatMessage',
				channel: 'remote:sendGroupChatMessage',
				eventArgs: ['chat-1', 'hello', 'reply:send-chat'],
			},
			{
				method: 'onRemoteMergeContext',
				channel: 'remote:mergeContext',
				eventArgs: ['source-session', 'target-session', 'reply:merge'],
			},
			{
				method: 'onRemoteTransferContext',
				channel: 'remote:transferContext',
				eventArgs: ['source-session', 'target-session', 'reply:transfer'],
			},
			{
				method: 'onRemoteSummarizeContext',
				channel: 'remote:summarizeContext',
				eventArgs: ['session-123', 'reply:summarize'],
			},
			{
				method: 'onStderr',
				channel: 'process:stderr',
				eventArgs: ['session-123', 'stderr data'],
			},
			{
				method: 'onCommandExit',
				channel: 'process:command-exit',
				eventArgs: ['session-123', 1],
			},
		];

		it.each(listenerCases)(
			'$method forwards $channel payloads and unregisters cleanup',
			(testCase) => {
				const { callback, cleanup, handler } = captureHandler(testCase.method, testCase.channel);

				handler({}, ...testCase.eventArgs);
				cleanup();

				expect(callback).toHaveBeenCalledWith(...(testCase.expectedArgs ?? testCase.eventArgs));
				expect(mockRemoveListener).toHaveBeenCalledWith(testCase.channel, handler);
			}
		);
	});

	describe('request-response listeners', () => {
		const register = (method: string, channel: string, callback = vi.fn()) => {
			let registeredHandler: ((event: unknown, ...args: unknown[]) => void) | undefined;
			mockOn.mockImplementation((registeredChannel: string, handler: typeof registeredHandler) => {
				if (registeredChannel === channel) {
					registeredHandler = handler;
				}
			});

			(api as Record<string, any>)[method](callback);

			expect(registeredHandler).toBeDefined();
			return { callback, handler: registeredHandler! };
		};

		it.each([
			{
				method: 'onRemoteOpenBrowserTab',
				channel: 'remote:openBrowserTab',
				eventArgs: ['session-123', 'https://example.com', 'reply:browser'],
			},
			{
				method: 'onRemoteOpenTerminalTab',
				channel: 'remote:openTerminalTab',
				eventArgs: [
					'session-123',
					{ cwd: '/tmp', shell: '/bin/zsh', name: 'Shell' },
					'reply:terminal',
				],
			},
			{
				method: 'onRemoteNewAITabWithPrompt',
				channel: 'remote:newAITabWithPrompt',
				eventArgs: ['session-123', 'Summarize this', 'reply:new-ai'],
			},
			{
				method: 'onRemoteConfigureAutoRun',
				channel: 'remote:configureAutoRun',
				eventArgs: ['session-123', { enabled: true }, 'reply:auto-run'],
			},
			{
				method: 'onRemoteCreateWorktreeSession',
				channel: 'remote:createWorktreeSession',
				eventArgs: ['session-123', { branch: 'feature' }, 'reply:worktree'],
			},
			{
				method: 'onRemoteSetAutoRunFolder',
				channel: 'remote:setAutoRunFolder',
				eventArgs: ['session-123', '/tmp/.maestro', 'reply:set-folder'],
			},
			{
				method: 'onRemoteGetAutoRunDocs',
				channel: 'remote:getAutoRunDocs',
				eventArgs: ['session-123', 'reply:get-docs'],
			},
			{
				method: 'onRemoteGetAutoRunDocContent',
				channel: 'remote:getAutoRunDocContent',
				eventArgs: ['session-123', 'plan.md', 'reply:get-doc-content'],
			},
			{
				method: 'onRemoteSaveAutoRunDoc',
				channel: 'remote:saveAutoRunDoc',
				eventArgs: ['session-123', 'plan.md', 'content', 'reply:save-doc'],
			},
			{
				method: 'onRemoteResetAutoRunDocTasks',
				channel: 'remote:resetAutoRunDocTasks',
				eventArgs: ['session-123', 'plan.md', 'reply:reset-doc'],
			},
			{
				method: 'onRemoteResumeAutoRunError',
				channel: 'remote:resumeAutoRunError',
				eventArgs: ['session-123', 'reply:resume'],
			},
			{
				method: 'onRemoteSkipAutoRunDocument',
				channel: 'remote:skipAutoRunDocument',
				eventArgs: ['session-123', 'reply:skip'],
			},
			{
				method: 'onRemoteAbortAutoRunError',
				channel: 'remote:abortAutoRunError',
				eventArgs: ['session-123', 'reply:abort'],
			},
			{
				method: 'onRemoteListPlaybooks',
				channel: 'remote:listPlaybooks',
				eventArgs: ['session-123', 'reply:list-playbooks'],
			},
			{
				method: 'onRemoteCreatePlaybook',
				channel: 'remote:createPlaybook',
				eventArgs: ['session-123', { name: 'Playbook' }, 'reply:create-playbook'],
			},
			{
				method: 'onRemoteUpdatePlaybook',
				channel: 'remote:updatePlaybook',
				eventArgs: ['session-123', 'playbook-1', { name: 'Updated' }, 'reply:update-playbook'],
			},
			{
				method: 'onRemoteDeletePlaybook',
				channel: 'remote:deletePlaybook',
				eventArgs: ['session-123', 'playbook-1', 'reply:delete-playbook'],
			},
			{
				method: 'onRemoteGetGitStatus',
				channel: 'remote:getGitStatus',
				eventArgs: ['session-123', 'reply:git-status'],
			},
			{
				method: 'onRemoteGetGitDiff',
				channel: 'remote:getGitDiff',
				eventArgs: ['session-123', 'src/App.tsx', 'reply:git-diff'],
			},
			{
				method: 'onRemoteCreateGist',
				channel: 'remote:createGist',
				eventArgs: ['session-123', 'Debug bundle', false, 'reply:gist'],
			},
			{
				method: 'onRemoteTriggerCueSubscription',
				channel: 'remote:triggerCueSubscription',
				eventArgs: ['Daily', 'Prompt', 'reply:cue', 'session-123'],
			},
		])('$method calls callback for $channel', ({ method, channel, eventArgs }) => {
			const { callback, handler } = register(method, channel);

			handler({}, ...eventArgs);

			expect(callback).toHaveBeenCalledWith(...eventArgs);
		});

		it.each([
			{
				method: 'onRemoteConfigureAutoRun',
				channel: 'remote:configureAutoRun',
				eventArgs: ['session-123', { enabled: true }, 'reply:auto-run'],
				fallback: { success: false, error: 'bad config' },
			},
			{
				method: 'onRemoteCreateWorktreeSession',
				channel: 'remote:createWorktreeSession',
				eventArgs: ['session-123', { branch: 'feature' }, 'reply:worktree'],
				fallback: { success: false, error: 'bad config' },
			},
			{
				method: 'onRemoteGetAutoRunDocs',
				channel: 'remote:getAutoRunDocs',
				eventArgs: ['session-123', 'reply:get-docs'],
				fallback: [],
			},
			{
				method: 'onRemoteGetAutoRunDocContent',
				channel: 'remote:getAutoRunDocContent',
				eventArgs: ['session-123', 'plan.md', 'reply:get-doc-content'],
				fallback: '',
			},
			{
				method: 'onRemoteSaveAutoRunDoc',
				channel: 'remote:saveAutoRunDoc',
				eventArgs: ['session-123', 'plan.md', 'content', 'reply:save-doc'],
				fallback: false,
			},
			{
				method: 'onRemoteGetGitStatus',
				channel: 'remote:getGitStatus',
				eventArgs: ['session-123', 'reply:git-status'],
				fallback: { branch: '', files: [], ahead: 0, behind: 0 },
			},
			{
				method: 'onRemoteGetGitDiff',
				channel: 'remote:getGitDiff',
				eventArgs: ['session-123', 'src/App.tsx', 'reply:git-diff'],
				fallback: { diff: '', files: [] },
			},
		])(
			'$method sends fallback response when callback throws',
			({ method, channel, eventArgs, fallback }) => {
				const callback = vi.fn(() => {
					throw new Error('bad config');
				});
				const { handler } = register(method, channel, callback);
				const responseChannel = eventArgs[eventArgs.length - 1];

				handler({}, ...eventArgs);

				expect(mockSend).toHaveBeenCalledWith(responseChannel, fallback);
			}
		);

		it.each([
			{
				method: 'onRemoteOpenBrowserTab',
				channel: 'remote:openBrowserTab',
				eventArgs: ['session-123', 'https://example.com', 'reply:browser'],
				fallback: false,
			},
			{
				method: 'onRemoteOpenTerminalTab',
				channel: 'remote:openTerminalTab',
				eventArgs: ['session-123', { cwd: '/tmp' }, 'reply:terminal'],
				fallback: false,
			},
			{
				method: 'onRemoteNewAITabWithPrompt',
				channel: 'remote:newAITabWithPrompt',
				eventArgs: ['session-123', 'Prompt', 'reply:new-ai'],
				fallback: false,
			},
			{
				method: 'onRemoteSetAutoRunFolder',
				channel: 'remote:setAutoRunFolder',
				eventArgs: ['session-123', '/tmp/.maestro', 'reply:set-folder'],
				fallback: { success: false, error: 'boom' },
			},
			{
				method: 'onRemoteResetAutoRunDocTasks',
				channel: 'remote:resetAutoRunDocTasks',
				eventArgs: ['session-123', 'plan.md', 'reply:reset-doc'],
				fallback: false,
			},
			{
				method: 'onRemoteResumeAutoRunError',
				channel: 'remote:resumeAutoRunError',
				eventArgs: ['session-123', 'reply:resume'],
				fallback: false,
			},
			{
				method: 'onRemoteSkipAutoRunDocument',
				channel: 'remote:skipAutoRunDocument',
				eventArgs: ['session-123', 'reply:skip'],
				fallback: false,
			},
			{
				method: 'onRemoteAbortAutoRunError',
				channel: 'remote:abortAutoRunError',
				eventArgs: ['session-123', 'reply:abort'],
				fallback: false,
			},
			{
				method: 'onRemoteListPlaybooks',
				channel: 'remote:listPlaybooks',
				eventArgs: ['session-123', 'reply:list-playbooks'],
				fallback: [],
			},
			{
				method: 'onRemoteCreatePlaybook',
				channel: 'remote:createPlaybook',
				eventArgs: ['session-123', { name: 'Playbook' }, 'reply:create-playbook'],
				fallback: null,
			},
			{
				method: 'onRemoteUpdatePlaybook',
				channel: 'remote:updatePlaybook',
				eventArgs: ['session-123', 'playbook-1', {}, 'reply:update-playbook'],
				fallback: null,
			},
			{
				method: 'onRemoteDeletePlaybook',
				channel: 'remote:deletePlaybook',
				eventArgs: ['session-123', 'playbook-1', 'reply:delete-playbook'],
				fallback: false,
			},
			{
				method: 'onRemoteCreateGist',
				channel: 'remote:createGist',
				eventArgs: ['session-123', 'Bundle', false, 'reply:gist'],
				fallback: { success: false, error: 'boom' },
			},
		])(
			'$method acks then rethrows synchronous callback errors',
			({ method, channel, eventArgs, fallback }) => {
				const callback = vi.fn(() => {
					throw new Error('boom');
				});
				const { handler } = register(method, channel, callback);
				const responseChannel = eventArgs[eventArgs.length - 1];

				expect(() => handler({}, ...eventArgs)).toThrow('boom');
				expect(mockSend).toHaveBeenCalledWith(responseChannel, fallback);
			}
		);
	});

	describe('send response wrappers', () => {
		it.each([
			['sendRemoteOpenBrowserTabResponse', ['reply:browser', true]],
			['sendRemoteOpenTerminalTabResponse', ['reply:terminal', true]],
			[
				'sendRemoteNewAITabWithPromptResponse',
				['reply:new-ai', true, 'tab-1'],
				{ success: true, tabId: 'tab-1' },
			],
			[
				'sendRemoteConfigureAutoRunResponse',
				['reply:auto-run', { success: true, playbookId: 'pb-1' }],
			],
			[
				'sendRemoteCreateWorktreeSessionResponse',
				['reply:worktree', { success: true, sessionId: 'session-1' }],
			],
			['sendRemoteSetAutoRunFolderResponse', ['reply:set-folder', { success: true }]],
			['sendRemoteGetAutoRunDocsResponse', ['reply:get-docs', [{ filename: 'plan.md' }]]],
			['sendRemoteGetAutoRunDocContentResponse', ['reply:get-doc-content', '# Plan']],
			['sendRemoteSaveAutoRunDocResponse', ['reply:save-doc', true]],
			['sendRemoteResetAutoRunDocTasksResponse', ['reply:reset-doc', true]],
			['sendRemoteResumeAutoRunErrorResponse', ['reply:resume', true]],
			['sendRemoteSkipAutoRunDocumentResponse', ['reply:skip', true]],
			['sendRemoteAbortAutoRunErrorResponse', ['reply:abort', true]],
			['sendRemoteListPlaybooksResponse', ['reply:list-playbooks', [{ id: 'pb-1' }]]],
			['sendRemoteCreatePlaybookResponse', ['reply:create-playbook', { id: 'pb-1' }]],
			['sendRemoteUpdatePlaybookResponse', ['reply:update-playbook', { id: 'pb-1' }]],
			['sendRemoteDeletePlaybookResponse', ['reply:delete-playbook', true]],
			['sendRemoteSetSettingResponse', ['reply:setting', true]],
			['sendRemoteCreateSessionResponse', ['reply:create', { sessionId: 'session-1' }]],
			['sendRemoteRenameSessionResponse', ['reply:rename', true]],
			['sendRemoteUpdateSessionCwdResponse', ['reply:cwd', { success: true }]],
			['sendRemoteUpdateSessionSshResponse', ['reply:ssh', { success: true }]],
			['sendRemoteCreateGroupResponse', ['reply:group', { id: 'group-1' }]],
			['sendRemoteRenameGroupResponse', ['reply:rename-group', true]],
			['sendRemoteMoveSessionToGroupResponse', ['reply:move', true]],
			['sendRemoteGetGitStatusResponse', ['reply:git-status', { branch: 'main', files: [] }]],
			['sendRemoteGetGitDiffResponse', ['reply:git-diff', { diff: 'diff --git', files: [] }]],
			['sendRemoteGetGroupChatsResponse', ['reply:group-chats', [{ id: 'chat-1' }]]],
			['sendRemoteStartGroupChatResponse', ['reply:start-chat', { chatId: 'chat-1' }]],
			['sendRemoteGetGroupChatStateResponse', ['reply:chat-state', { status: 'running' }]],
			['sendRemoteStopGroupChatResponse', ['reply:stop-chat', true]],
			['sendRemoteSendGroupChatMessageResponse', ['reply:send-chat', true]],
			['sendRemoteMergeContextResponse', ['reply:merge', true]],
			['sendRemoteTransferContextResponse', ['reply:transfer', true]],
			['sendRemoteSummarizeContextResponse', ['reply:summarize', true]],
			[
				'sendRemoteCreateGistResponse',
				['reply:gist', { success: true, gistUrl: 'https://gist.github.com/1' }],
			],
			['sendRemoteTriggerCueSubscriptionResponse', ['reply:cue', { success: true }]],
		])('%s sends the expected IPC response', (method, args, expectedPayload = args[1]) => {
			(api as Record<string, any>)[method](...(args as unknown[]));

			expect(mockSend).toHaveBeenCalledWith(args[0], expectedPayload);
		});
	});
});
