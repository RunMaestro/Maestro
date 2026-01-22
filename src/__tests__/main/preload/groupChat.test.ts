/**
 * Tests for groupChat preload API
 *
 * Coverage:
 * - createGroupChatApi: Storage, chat log, moderator, participant, history, export operations
 * - Event subscriptions: onMessage, onStateChange, onParticipantsChanged, onModeratorUsage,
 *   onHistoryEntry, onParticipantState, onModeratorSessionIdChanged
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron ipcRenderer
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
	},
}));

import { createGroupChatApi } from '../../../main/preload/groupChat';

describe('GroupChat Preload API', () => {
	let api: ReturnType<typeof createGroupChatApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createGroupChatApi();
	});

	describe('Storage operations', () => {
		describe('create', () => {
			it('should invoke groupChat:create', async () => {
				mockInvoke.mockResolvedValue({ id: 'gc-123' });

				const result = await api.create('My Group Chat', 'claude-code');

				expect(mockInvoke).toHaveBeenCalledWith(
					'groupChat:create',
					'My Group Chat',
					'claude-code',
					undefined
				);
				expect(result).toEqual({ id: 'gc-123' });
			});

			it('should invoke with moderator config', async () => {
				mockInvoke.mockResolvedValue({ id: 'gc-123' });
				const moderatorConfig = { customPath: '/custom/path' };

				await api.create('My Group Chat', 'claude-code', moderatorConfig);

				expect(mockInvoke).toHaveBeenCalledWith(
					'groupChat:create',
					'My Group Chat',
					'claude-code',
					moderatorConfig
				);
			});
		});

		describe('list', () => {
			it('should invoke groupChat:list', async () => {
				mockInvoke.mockResolvedValue([{ id: 'gc-1', name: 'Chat 1' }]);

				const result = await api.list();

				expect(mockInvoke).toHaveBeenCalledWith('groupChat:list');
				expect(result).toEqual([{ id: 'gc-1', name: 'Chat 1' }]);
			});
		});

		describe('load', () => {
			it('should invoke groupChat:load', async () => {
				mockInvoke.mockResolvedValue({ id: 'gc-123', name: 'My Chat', participants: [] });

				const result = await api.load('gc-123');

				expect(mockInvoke).toHaveBeenCalledWith('groupChat:load', 'gc-123');
				expect(result.id).toBe('gc-123');
			});
		});

		describe('delete', () => {
			it('should invoke groupChat:delete', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				await api.delete('gc-123');

				expect(mockInvoke).toHaveBeenCalledWith('groupChat:delete', 'gc-123');
			});
		});

		describe('rename', () => {
			it('should invoke groupChat:rename', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				await api.rename('gc-123', 'New Name');

				expect(mockInvoke).toHaveBeenCalledWith('groupChat:rename', 'gc-123', 'New Name');
			});
		});

		describe('update', () => {
			it('should invoke groupChat:update', async () => {
				mockInvoke.mockResolvedValue({ success: true });
				const updates = { name: 'Updated', moderatorAgentId: 'opencode' };

				await api.update('gc-123', updates);

				expect(mockInvoke).toHaveBeenCalledWith('groupChat:update', 'gc-123', updates);
			});
		});
	});

	describe('Chat log operations', () => {
		describe('appendMessage', () => {
			it('should invoke groupChat:appendMessage', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				await api.appendMessage('gc-123', 'Moderator', 'Hello everyone!');

				expect(mockInvoke).toHaveBeenCalledWith(
					'groupChat:appendMessage',
					'gc-123',
					'Moderator',
					'Hello everyone!'
				);
			});
		});

		describe('getMessages', () => {
			it('should invoke groupChat:getMessages', async () => {
				const messages = [{ timestamp: '2024-01-01', from: 'User', content: 'Hi' }];
				mockInvoke.mockResolvedValue(messages);

				const result = await api.getMessages('gc-123');

				expect(mockInvoke).toHaveBeenCalledWith('groupChat:getMessages', 'gc-123');
				expect(result).toEqual(messages);
			});
		});

		describe('saveImage', () => {
			it('should invoke groupChat:saveImage', async () => {
				mockInvoke.mockResolvedValue({ path: 'images/img.png' });

				await api.saveImage('gc-123', 'base64data', 'image.png');

				expect(mockInvoke).toHaveBeenCalledWith(
					'groupChat:saveImage',
					'gc-123',
					'base64data',
					'image.png'
				);
			});
		});
	});

	describe('Moderator operations', () => {
		describe('startModerator', () => {
			it('should invoke groupChat:startModerator', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				await api.startModerator('gc-123');

				expect(mockInvoke).toHaveBeenCalledWith('groupChat:startModerator', 'gc-123');
			});
		});

		describe('sendToModerator', () => {
			it('should invoke groupChat:sendToModerator', async () => {
				mockInvoke.mockResolvedValue({ response: 'Moderator response' });

				await api.sendToModerator('gc-123', 'Please coordinate', undefined, false);

				expect(mockInvoke).toHaveBeenCalledWith(
					'groupChat:sendToModerator',
					'gc-123',
					'Please coordinate',
					undefined,
					false
				);
			});

			it('should invoke with images and readOnly', async () => {
				mockInvoke.mockResolvedValue({ response: 'Response' });

				await api.sendToModerator('gc-123', 'Message', ['image1.png'], true);

				expect(mockInvoke).toHaveBeenCalledWith(
					'groupChat:sendToModerator',
					'gc-123',
					'Message',
					['image1.png'],
					true
				);
			});
		});

		describe('stopModerator', () => {
			it('should invoke groupChat:stopModerator', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				await api.stopModerator('gc-123');

				expect(mockInvoke).toHaveBeenCalledWith('groupChat:stopModerator', 'gc-123');
			});
		});

		describe('getModeratorSessionId', () => {
			it('should invoke groupChat:getModeratorSessionId', async () => {
				mockInvoke.mockResolvedValue('mod-session-456');

				const result = await api.getModeratorSessionId('gc-123');

				expect(mockInvoke).toHaveBeenCalledWith('groupChat:getModeratorSessionId', 'gc-123');
				expect(result).toBe('mod-session-456');
			});
		});
	});

	describe('Participant operations', () => {
		describe('addParticipant', () => {
			it('should invoke groupChat:addParticipant', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				await api.addParticipant('gc-123', 'Agent1', 'claude-code');

				expect(mockInvoke).toHaveBeenCalledWith(
					'groupChat:addParticipant',
					'gc-123',
					'Agent1',
					'claude-code',
					undefined
				);
			});

			it('should invoke with cwd', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				await api.addParticipant('gc-123', 'Agent1', 'claude-code', '/project');

				expect(mockInvoke).toHaveBeenCalledWith(
					'groupChat:addParticipant',
					'gc-123',
					'Agent1',
					'claude-code',
					'/project'
				);
			});
		});

		describe('sendToParticipant', () => {
			it('should invoke groupChat:sendToParticipant', async () => {
				mockInvoke.mockResolvedValue({ response: 'Participant response' });

				await api.sendToParticipant('gc-123', 'Agent1', 'Do this task');

				expect(mockInvoke).toHaveBeenCalledWith(
					'groupChat:sendToParticipant',
					'gc-123',
					'Agent1',
					'Do this task',
					undefined
				);
			});

			it('should invoke with images', async () => {
				mockInvoke.mockResolvedValue({ response: 'Response' });

				await api.sendToParticipant('gc-123', 'Agent1', 'Look at this', ['screenshot.png']);

				expect(mockInvoke).toHaveBeenCalledWith(
					'groupChat:sendToParticipant',
					'gc-123',
					'Agent1',
					'Look at this',
					['screenshot.png']
				);
			});
		});

		describe('removeParticipant', () => {
			it('should invoke groupChat:removeParticipant', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				await api.removeParticipant('gc-123', 'Agent1');

				expect(mockInvoke).toHaveBeenCalledWith('groupChat:removeParticipant', 'gc-123', 'Agent1');
			});
		});

		describe('resetParticipantContext', () => {
			it('should invoke groupChat:resetParticipantContext', async () => {
				mockInvoke.mockResolvedValue({ newAgentSessionId: 'new-session-789' });

				const result = await api.resetParticipantContext('gc-123', 'Agent1');

				expect(mockInvoke).toHaveBeenCalledWith(
					'groupChat:resetParticipantContext',
					'gc-123',
					'Agent1',
					undefined
				);
				expect(result.newAgentSessionId).toBe('new-session-789');
			});
		});
	});

	describe('History operations', () => {
		describe('getHistory', () => {
			it('should invoke groupChat:getHistory', async () => {
				const history = [{ id: 'h-1', timestamp: Date.now(), summary: 'Test' }];
				mockInvoke.mockResolvedValue(history);

				const result = await api.getHistory('gc-123');

				expect(mockInvoke).toHaveBeenCalledWith('groupChat:getHistory', 'gc-123');
				expect(result).toEqual(history);
			});
		});

		describe('addHistoryEntry', () => {
			it('should invoke groupChat:addHistoryEntry', async () => {
				mockInvoke.mockResolvedValue({ id: 'h-new' });
				const entry = {
					timestamp: Date.now(),
					summary: 'Task completed',
					participantName: 'Agent1',
					participantColor: '#ff0000',
					type: 'response' as const,
				};

				await api.addHistoryEntry('gc-123', entry);

				expect(mockInvoke).toHaveBeenCalledWith('groupChat:addHistoryEntry', 'gc-123', entry);
			});
		});

		describe('deleteHistoryEntry', () => {
			it('should invoke groupChat:deleteHistoryEntry', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				await api.deleteHistoryEntry('gc-123', 'h-1');

				expect(mockInvoke).toHaveBeenCalledWith('groupChat:deleteHistoryEntry', 'gc-123', 'h-1');
			});
		});

		describe('clearHistory', () => {
			it('should invoke groupChat:clearHistory', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				await api.clearHistory('gc-123');

				expect(mockInvoke).toHaveBeenCalledWith('groupChat:clearHistory', 'gc-123');
			});
		});

		describe('getHistoryFilePath', () => {
			it('should invoke groupChat:getHistoryFilePath', async () => {
				mockInvoke.mockResolvedValue('/path/to/history.json');

				const result = await api.getHistoryFilePath('gc-123');

				expect(mockInvoke).toHaveBeenCalledWith('groupChat:getHistoryFilePath', 'gc-123');
				expect(result).toBe('/path/to/history.json');
			});
		});
	});

	describe('Export operations', () => {
		describe('getImages', () => {
			it('should invoke groupChat:getImages', async () => {
				const images = { 'img1.png': 'base64data1', 'img2.png': 'base64data2' };
				mockInvoke.mockResolvedValue(images);

				const result = await api.getImages('gc-123');

				expect(mockInvoke).toHaveBeenCalledWith('groupChat:getImages', 'gc-123');
				expect(result).toEqual(images);
			});
		});
	});

	describe('Event subscriptions', () => {
		describe('onMessage', () => {
			it('should register and handle message events', () => {
				const callback = vi.fn();
				let registeredHandler: (event: unknown, groupChatId: string, message: unknown) => void;

				mockOn.mockImplementation(
					(
						_channel: string,
						handler: (event: unknown, groupChatId: string, message: unknown) => void
					) => {
						registeredHandler = handler;
					}
				);

				const cleanup = api.onMessage(callback);

				expect(mockOn).toHaveBeenCalledWith('groupChat:message', expect.any(Function));

				const message = { timestamp: '2024-01-01', from: 'User', content: 'Hi' };
				registeredHandler!({}, 'gc-123', message);

				expect(callback).toHaveBeenCalledWith('gc-123', message);
				expect(typeof cleanup).toBe('function');
			});

			it('should remove listener when cleanup is called', () => {
				const callback = vi.fn();
				let registeredHandler: (event: unknown, groupChatId: string, message: unknown) => void;

				mockOn.mockImplementation(
					(
						_channel: string,
						handler: (event: unknown, groupChatId: string, message: unknown) => void
					) => {
						registeredHandler = handler;
					}
				);

				const cleanup = api.onMessage(callback);
				cleanup();

				expect(mockRemoveListener).toHaveBeenCalledWith('groupChat:message', registeredHandler!);
			});
		});

		describe('onStateChange', () => {
			it('should register and handle state change events', () => {
				const callback = vi.fn();
				let registeredHandler: (event: unknown, groupChatId: string, state: string) => void;

				mockOn.mockImplementation(
					(
						_channel: string,
						handler: (event: unknown, groupChatId: string, state: string) => void
					) => {
						registeredHandler = handler;
					}
				);

				api.onStateChange(callback);
				registeredHandler!({}, 'gc-123', 'moderator-thinking');

				expect(callback).toHaveBeenCalledWith('gc-123', 'moderator-thinking');
			});

			it('should remove listener when cleanup is called', () => {
				const callback = vi.fn();
				let registeredHandler: (event: unknown, groupChatId: string, state: string) => void;

				mockOn.mockImplementation(
					(
						_channel: string,
						handler: (event: unknown, groupChatId: string, state: string) => void
					) => {
						registeredHandler = handler;
					}
				);

				const cleanup = api.onStateChange(callback);
				cleanup();

				expect(mockRemoveListener).toHaveBeenCalledWith(
					'groupChat:stateChange',
					registeredHandler!
				);
			});
		});

		describe('onParticipantsChanged', () => {
			it('should register and handle participants changed events', () => {
				const callback = vi.fn();
				let registeredHandler: (
					event: unknown,
					groupChatId: string,
					participants: unknown[]
				) => void;

				mockOn.mockImplementation(
					(
						_channel: string,
						handler: (event: unknown, groupChatId: string, participants: unknown[]) => void
					) => {
						registeredHandler = handler;
					}
				);

				api.onParticipantsChanged(callback);

				const participants = [{ name: 'Agent1', agentId: 'claude-code' }];
				registeredHandler!({}, 'gc-123', participants);

				expect(callback).toHaveBeenCalledWith('gc-123', participants);
			});

			it('should remove listener when cleanup is called', () => {
				const callback = vi.fn();
				let registeredHandler: (
					event: unknown,
					groupChatId: string,
					participants: unknown[]
				) => void;

				mockOn.mockImplementation(
					(
						_channel: string,
						handler: (event: unknown, groupChatId: string, participants: unknown[]) => void
					) => {
						registeredHandler = handler;
					}
				);

				const cleanup = api.onParticipantsChanged(callback);
				cleanup();

				expect(mockRemoveListener).toHaveBeenCalledWith(
					'groupChat:participantsChanged',
					registeredHandler!
				);
			});
		});

		describe('onModeratorUsage', () => {
			it('should register and handle moderator usage events', () => {
				const callback = vi.fn();
				let registeredHandler: (event: unknown, groupChatId: string, usage: unknown) => void;

				mockOn.mockImplementation(
					(
						_channel: string,
						handler: (event: unknown, groupChatId: string, usage: unknown) => void
					) => {
						registeredHandler = handler;
					}
				);

				api.onModeratorUsage(callback);

				const usage = { contextUsage: 50, totalCost: 0.05, tokenCount: 1000 };
				registeredHandler!({}, 'gc-123', usage);

				expect(callback).toHaveBeenCalledWith('gc-123', usage);
			});

			it('should remove listener when cleanup is called', () => {
				const callback = vi.fn();
				let registeredHandler: (event: unknown, groupChatId: string, usage: unknown) => void;

				mockOn.mockImplementation(
					(
						_channel: string,
						handler: (event: unknown, groupChatId: string, usage: unknown) => void
					) => {
						registeredHandler = handler;
					}
				);

				const cleanup = api.onModeratorUsage(callback);
				cleanup();

				expect(mockRemoveListener).toHaveBeenCalledWith(
					'groupChat:moderatorUsage',
					registeredHandler!
				);
			});
		});

		describe('onHistoryEntry', () => {
			it('should register and handle history entry events', () => {
				const callback = vi.fn();
				let registeredHandler: (event: unknown, groupChatId: string, entry: unknown) => void;

				mockOn.mockImplementation(
					(
						_channel: string,
						handler: (event: unknown, groupChatId: string, entry: unknown) => void
					) => {
						registeredHandler = handler;
					}
				);

				api.onHistoryEntry(callback);

				const entry = { id: 'h-1', summary: 'Task done' };
				registeredHandler!({}, 'gc-123', entry);

				expect(callback).toHaveBeenCalledWith('gc-123', entry);
			});

			it('should remove listener when cleanup is called', () => {
				const callback = vi.fn();
				let registeredHandler: (event: unknown, groupChatId: string, entry: unknown) => void;

				mockOn.mockImplementation(
					(
						_channel: string,
						handler: (event: unknown, groupChatId: string, entry: unknown) => void
					) => {
						registeredHandler = handler;
					}
				);

				const cleanup = api.onHistoryEntry(callback);
				cleanup();

				expect(mockRemoveListener).toHaveBeenCalledWith(
					'groupChat:historyEntry',
					registeredHandler!
				);
			});
		});

		describe('onParticipantState', () => {
			it('should register and handle participant state events', () => {
				const callback = vi.fn();
				let registeredHandler: (
					event: unknown,
					groupChatId: string,
					participantName: string,
					state: string
				) => void;

				mockOn.mockImplementation(
					(
						_channel: string,
						handler: (
							event: unknown,
							groupChatId: string,
							participantName: string,
							state: string
						) => void
					) => {
						registeredHandler = handler;
					}
				);

				api.onParticipantState(callback);
				registeredHandler!({}, 'gc-123', 'Agent1', 'working');

				expect(callback).toHaveBeenCalledWith('gc-123', 'Agent1', 'working');
			});

			it('should remove listener when cleanup is called', () => {
				const callback = vi.fn();
				let registeredHandler: (
					event: unknown,
					groupChatId: string,
					participantName: string,
					state: string
				) => void;

				mockOn.mockImplementation(
					(
						_channel: string,
						handler: (
							event: unknown,
							groupChatId: string,
							participantName: string,
							state: string
						) => void
					) => {
						registeredHandler = handler;
					}
				);

				const cleanup = api.onParticipantState(callback);
				cleanup();

				expect(mockRemoveListener).toHaveBeenCalledWith(
					'groupChat:participantState',
					registeredHandler!
				);
			});
		});

		describe('onModeratorSessionIdChanged', () => {
			it('should register and handle moderator session id changed events', () => {
				const callback = vi.fn();
				let registeredHandler: (event: unknown, groupChatId: string, sessionId: string) => void;

				mockOn.mockImplementation(
					(
						_channel: string,
						handler: (event: unknown, groupChatId: string, sessionId: string) => void
					) => {
						registeredHandler = handler;
					}
				);

				api.onModeratorSessionIdChanged(callback);
				registeredHandler!({}, 'gc-123', 'new-session-id');

				expect(callback).toHaveBeenCalledWith('gc-123', 'new-session-id');
			});

			it('should remove listener when cleanup is called', () => {
				const callback = vi.fn();
				let registeredHandler: (event: unknown, groupChatId: string, sessionId: string) => void;

				mockOn.mockImplementation(
					(
						_channel: string,
						handler: (event: unknown, groupChatId: string, sessionId: string) => void
					) => {
						registeredHandler = handler;
					}
				);

				const cleanup = api.onModeratorSessionIdChanged(callback);
				cleanup();

				expect(mockRemoveListener).toHaveBeenCalledWith(
					'groupChat:moderatorSessionIdChanged',
					registeredHandler!
				);
			});
		});
	});
});
