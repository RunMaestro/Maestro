/**
 * Tests for settings preload API
 *
 * Coverage:
 * - createSettingsApi: get, set, getAll
 * - createSessionsApi: getAll, setAll
 * - createGroupsApi: getAll, setAll
 * - createAgentErrorApi: clearError, retryAfterError
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

import {
	createSettingsApi,
	createSessionsApi,
	createGroupsApi,
	createAgentErrorApi,
} from '../../main/preload/settings';

describe('Settings Preload API', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('createSettingsApi', () => {
		let api: ReturnType<typeof createSettingsApi>;

		beforeEach(() => {
			api = createSettingsApi();
		});

		describe('get', () => {
			it('should invoke settings:get with key', async () => {
				mockInvoke.mockResolvedValue('test-value');

				const result = await api.get('theme');

				expect(mockInvoke).toHaveBeenCalledWith('settings:get', 'theme');
				expect(result).toBe('test-value');
			});

			it('should return undefined for non-existent key', async () => {
				mockInvoke.mockResolvedValue(undefined);

				const result = await api.get('non-existent');

				expect(result).toBeUndefined();
			});
		});

		describe('set', () => {
			it('should invoke settings:set with key and value and return result', async () => {
				mockInvoke.mockResolvedValue(true);

				const result = await api.set('theme', 'dark');

				expect(mockInvoke).toHaveBeenCalledWith('settings:set', 'theme', 'dark');
				expect(result).toBe(true);
			});

			it('should handle complex values', async () => {
				mockInvoke.mockResolvedValue(true);
				const complexValue = { nested: { key: 'value' }, array: [1, 2, 3] };

				const result = await api.set('config', complexValue);

				expect(mockInvoke).toHaveBeenCalledWith('settings:set', 'config', complexValue);
				expect(result).toBe(true);
			});
		});

		describe('getAll', () => {
			it('should invoke settings:getAll', async () => {
				const allSettings = { theme: 'dark', fontSize: 14 };
				mockInvoke.mockResolvedValue(allSettings);

				const result = await api.getAll();

				expect(mockInvoke).toHaveBeenCalledWith('settings:getAll');
				expect(result).toEqual(allSettings);
			});
		});

		describe('onExternalChange', () => {
			it('should register external settings change listener', () => {
				const callback = vi.fn();

				const cleanup = api.onExternalChange(callback);

				expect(mockOn).toHaveBeenCalledWith('settings:externalChange', expect.any(Function));
				expect(typeof cleanup).toBe('function');
			});

			it('should call callback when external settings change is received', () => {
				const callback = vi.fn();
				let registeredHandler: () => void;

				mockOn.mockImplementation((_channel: string, handler: () => void) => {
					registeredHandler = handler;
				});

				api.onExternalChange(callback);
				registeredHandler!();

				expect(callback).toHaveBeenCalledTimes(1);
			});

			it('should remove external settings listener when cleanup is called', () => {
				const callback = vi.fn();
				let registeredHandler: () => void;

				mockOn.mockImplementation((_channel: string, handler: () => void) => {
					registeredHandler = handler;
				});

				const cleanup = api.onExternalChange(callback);
				cleanup();

				expect(mockRemoveListener).toHaveBeenCalledWith(
					'settings:externalChange',
					registeredHandler!
				);
			});
		});
	});

	describe('createSessionsApi', () => {
		let api: ReturnType<typeof createSessionsApi>;

		beforeEach(() => {
			api = createSessionsApi();
		});

		describe('getAll', () => {
			it('should invoke sessions:getAll', async () => {
				const sessions = [{ id: '1', name: 'Session 1' }];
				mockInvoke.mockResolvedValue(sessions);

				const result = await api.getAll();

				expect(mockInvoke).toHaveBeenCalledWith('sessions:getAll');
				expect(result).toEqual(sessions);
			});
		});

		describe('setAll', () => {
			it('should invoke sessions:setAll with sessions array and return result', async () => {
				const sessions = [
					{ id: '1', name: 'Session 1' },
					{ id: '2', name: 'Session 2' },
				];
				mockInvoke.mockResolvedValue(true);

				const result = await api.setAll(sessions);

				expect(mockInvoke).toHaveBeenCalledWith('sessions:setAll', sessions);
				expect(result).toBe(true);
			});
		});
	});

	describe('createGroupsApi', () => {
		let api: ReturnType<typeof createGroupsApi>;

		beforeEach(() => {
			api = createGroupsApi();
		});

		describe('getAll', () => {
			it('should invoke groups:getAll', async () => {
				const groups = [{ id: '1', name: 'Group 1' }];
				mockInvoke.mockResolvedValue(groups);

				const result = await api.getAll();

				expect(mockInvoke).toHaveBeenCalledWith('groups:getAll');
				expect(result).toEqual(groups);
			});
		});

		describe('setAll', () => {
			it('should invoke groups:setAll with groups array and return result', async () => {
				const groups = [{ id: '1', name: 'Group 1' }];
				mockInvoke.mockResolvedValue(true);

				const result = await api.setAll(groups);

				expect(mockInvoke).toHaveBeenCalledWith('groups:setAll', groups);
				expect(result).toBe(true);
			});
		});
	});

	describe('createAgentErrorApi', () => {
		let api: ReturnType<typeof createAgentErrorApi>;

		beforeEach(() => {
			api = createAgentErrorApi();
		});

		describe('clearError', () => {
			it('should invoke agent:clearError with sessionId and return result', async () => {
				mockInvoke.mockResolvedValue(true);

				const result = await api.clearError('session-123');

				expect(mockInvoke).toHaveBeenCalledWith('agent:clearError', 'session-123');
				expect(result).toBe(true);
			});
		});

		describe('retryAfterError', () => {
			it('should invoke agent:retryAfterError with sessionId and undefined options', async () => {
				mockInvoke.mockResolvedValue(true);

				const result = await api.retryAfterError('session-123');

				expect(mockInvoke).toHaveBeenCalledWith('agent:retryAfterError', 'session-123', undefined);
				expect(result).toBe(true);
			});

			it('should invoke agent:retryAfterError with options', async () => {
				mockInvoke.mockResolvedValue(true);
				const options = { prompt: 'retry prompt', newSession: true };

				const result = await api.retryAfterError('session-123', options);

				expect(mockInvoke).toHaveBeenCalledWith('agent:retryAfterError', 'session-123', options);
				expect(result).toBe(true);
			});
		});
	});
});
