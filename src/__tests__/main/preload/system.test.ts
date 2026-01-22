/**
 * Tests for system preload API
 *
 * Coverage:
 * - createDialogApi: selectFolder, saveFile
 * - createFontsApi: detect
 * - createShellsApi: detect
 * - createShellApi: openExternal, trashItem
 * - createTunnelApi: isCloudflaredInstalled, start, stop, getStatus
 * - createSyncApi: getDefaultPath, getSettings, getCurrentStoragePath, selectSyncFolder, setCustomPath
 * - createDevtoolsApi: open, close, toggle
 * - createPowerApi: setEnabled, isEnabled, getStatus, addReason, removeReason
 * - createUpdatesApi: check, download, install, getStatus, onStatus, setAllowPrerelease
 * - createAppApi: onQuitConfirmationRequest, confirmQuit, cancelQuit
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

import {
	createDialogApi,
	createFontsApi,
	createShellsApi,
	createShellApi,
	createTunnelApi,
	createSyncApi,
	createDevtoolsApi,
	createPowerApi,
	createUpdatesApi,
	createAppApi,
} from '../../../main/preload/system';

describe('System Preload API', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('createDialogApi', () => {
		let api: ReturnType<typeof createDialogApi>;

		beforeEach(() => {
			api = createDialogApi();
		});

		describe('selectFolder', () => {
			it('should invoke dialog:selectFolder', async () => {
				mockInvoke.mockResolvedValue('/selected/path');

				const result = await api.selectFolder();

				expect(mockInvoke).toHaveBeenCalledWith('dialog:selectFolder');
				expect(result).toBe('/selected/path');
			});
		});

		describe('saveFile', () => {
			it('should invoke dialog:saveFile with options', async () => {
				mockInvoke.mockResolvedValue('/saved/file.txt');
				const options = {
					defaultPath: '/default/path.txt',
					filters: [{ name: 'Text', extensions: ['txt'] }],
					title: 'Save File',
				};

				const result = await api.saveFile(options);

				expect(mockInvoke).toHaveBeenCalledWith('dialog:saveFile', options);
				expect(result).toBe('/saved/file.txt');
			});
		});
	});

	describe('createFontsApi', () => {
		let api: ReturnType<typeof createFontsApi>;

		beforeEach(() => {
			api = createFontsApi();
		});

		describe('detect', () => {
			it('should invoke fonts:detect', async () => {
				mockInvoke.mockResolvedValue(['Arial', 'Helvetica', 'Monaco']);

				const result = await api.detect();

				expect(mockInvoke).toHaveBeenCalledWith('fonts:detect');
				expect(result).toEqual(['Arial', 'Helvetica', 'Monaco']);
			});
		});
	});

	describe('createShellsApi', () => {
		let api: ReturnType<typeof createShellsApi>;

		beforeEach(() => {
			api = createShellsApi();
		});

		describe('detect', () => {
			it('should invoke shells:detect', async () => {
				const shells = [
					{ id: 'bash', name: 'Bash', available: true, path: '/bin/bash' },
					{ id: 'zsh', name: 'Zsh', available: true, path: '/bin/zsh' },
				];
				mockInvoke.mockResolvedValue(shells);

				const result = await api.detect();

				expect(mockInvoke).toHaveBeenCalledWith('shells:detect');
				expect(result).toEqual(shells);
			});
		});
	});

	describe('createShellApi', () => {
		let api: ReturnType<typeof createShellApi>;

		beforeEach(() => {
			api = createShellApi();
		});

		describe('openExternal', () => {
			it('should invoke shell:openExternal with url', async () => {
				mockInvoke.mockResolvedValue(undefined);

				await api.openExternal('https://example.com');

				expect(mockInvoke).toHaveBeenCalledWith('shell:openExternal', 'https://example.com');
			});
		});

		describe('trashItem', () => {
			it('should invoke shell:trashItem with path', async () => {
				mockInvoke.mockResolvedValue(undefined);

				await api.trashItem('/path/to/file');

				expect(mockInvoke).toHaveBeenCalledWith('shell:trashItem', '/path/to/file');
			});
		});
	});

	describe('createTunnelApi', () => {
		let api: ReturnType<typeof createTunnelApi>;

		beforeEach(() => {
			api = createTunnelApi();
		});

		describe('isCloudflaredInstalled', () => {
			it('should invoke tunnel:isCloudflaredInstalled', async () => {
				mockInvoke.mockResolvedValue(true);

				const result = await api.isCloudflaredInstalled();

				expect(mockInvoke).toHaveBeenCalledWith('tunnel:isCloudflaredInstalled');
				expect(result).toBe(true);
			});
		});

		describe('start', () => {
			it('should invoke tunnel:start', async () => {
				mockInvoke.mockResolvedValue({ url: 'https://tunnel.example.com' });

				const result = await api.start();

				expect(mockInvoke).toHaveBeenCalledWith('tunnel:start');
				expect(result).toEqual({ url: 'https://tunnel.example.com' });
			});
		});

		describe('stop', () => {
			it('should invoke tunnel:stop', async () => {
				mockInvoke.mockResolvedValue(undefined);

				await api.stop();

				expect(mockInvoke).toHaveBeenCalledWith('tunnel:stop');
			});
		});

		describe('getStatus', () => {
			it('should invoke tunnel:getStatus', async () => {
				mockInvoke.mockResolvedValue({ running: true, url: 'https://tunnel.example.com' });

				const result = await api.getStatus();

				expect(mockInvoke).toHaveBeenCalledWith('tunnel:getStatus');
				expect(result).toEqual({ running: true, url: 'https://tunnel.example.com' });
			});
		});
	});

	describe('createSyncApi', () => {
		let api: ReturnType<typeof createSyncApi>;

		beforeEach(() => {
			api = createSyncApi();
		});

		describe('getDefaultPath', () => {
			it('should invoke sync:getDefaultPath', async () => {
				mockInvoke.mockResolvedValue('/default/sync/path');

				const result = await api.getDefaultPath();

				expect(mockInvoke).toHaveBeenCalledWith('sync:getDefaultPath');
				expect(result).toBe('/default/sync/path');
			});
		});

		describe('getSettings', () => {
			it('should invoke sync:getSettings', async () => {
				mockInvoke.mockResolvedValue({ customSyncPath: '/custom/path' });

				const result = await api.getSettings();

				expect(mockInvoke).toHaveBeenCalledWith('sync:getSettings');
				expect(result).toEqual({ customSyncPath: '/custom/path' });
			});
		});

		describe('getCurrentStoragePath', () => {
			it('should invoke sync:getCurrentStoragePath', async () => {
				mockInvoke.mockResolvedValue('/current/storage/path');

				const result = await api.getCurrentStoragePath();

				expect(mockInvoke).toHaveBeenCalledWith('sync:getCurrentStoragePath');
				expect(result).toBe('/current/storage/path');
			});
		});

		describe('selectSyncFolder', () => {
			it('should invoke sync:selectSyncFolder', async () => {
				mockInvoke.mockResolvedValue('/selected/sync/folder');

				const result = await api.selectSyncFolder();

				expect(mockInvoke).toHaveBeenCalledWith('sync:selectSyncFolder');
				expect(result).toBe('/selected/sync/folder');
			});
		});

		describe('setCustomPath', () => {
			it('should invoke sync:setCustomPath', async () => {
				mockInvoke.mockResolvedValue({ success: true, migrated: 5 });

				const result = await api.setCustomPath('/new/custom/path');

				expect(mockInvoke).toHaveBeenCalledWith('sync:setCustomPath', '/new/custom/path');
				expect(result).toEqual({ success: true, migrated: 5 });
			});

			it('should handle null to reset path', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				const result = await api.setCustomPath(null);

				expect(mockInvoke).toHaveBeenCalledWith('sync:setCustomPath', null);
				expect(result.success).toBe(true);
			});
		});
	});

	describe('createDevtoolsApi', () => {
		let api: ReturnType<typeof createDevtoolsApi>;

		beforeEach(() => {
			api = createDevtoolsApi();
		});

		describe('open', () => {
			it('should invoke devtools:open', async () => {
				mockInvoke.mockResolvedValue(undefined);

				await api.open();

				expect(mockInvoke).toHaveBeenCalledWith('devtools:open');
			});
		});

		describe('close', () => {
			it('should invoke devtools:close', async () => {
				mockInvoke.mockResolvedValue(undefined);

				await api.close();

				expect(mockInvoke).toHaveBeenCalledWith('devtools:close');
			});
		});

		describe('toggle', () => {
			it('should invoke devtools:toggle', async () => {
				mockInvoke.mockResolvedValue(undefined);

				await api.toggle();

				expect(mockInvoke).toHaveBeenCalledWith('devtools:toggle');
			});
		});
	});

	describe('createPowerApi', () => {
		let api: ReturnType<typeof createPowerApi>;

		beforeEach(() => {
			api = createPowerApi();
		});

		describe('setEnabled', () => {
			it('should invoke power:setEnabled', async () => {
				mockInvoke.mockResolvedValue(undefined);

				await api.setEnabled(true);

				expect(mockInvoke).toHaveBeenCalledWith('power:setEnabled', true);
			});
		});

		describe('isEnabled', () => {
			it('should invoke power:isEnabled', async () => {
				mockInvoke.mockResolvedValue(true);

				const result = await api.isEnabled();

				expect(mockInvoke).toHaveBeenCalledWith('power:isEnabled');
				expect(result).toBe(true);
			});
		});

		describe('getStatus', () => {
			it('should invoke power:getStatus', async () => {
				const status = {
					enabled: true,
					blocking: true,
					reasons: ['Auto Run in progress'],
					platform: 'darwin' as const,
				};
				mockInvoke.mockResolvedValue(status);

				const result = await api.getStatus();

				expect(mockInvoke).toHaveBeenCalledWith('power:getStatus');
				expect(result).toEqual(status);
			});
		});

		describe('addReason', () => {
			it('should invoke power:addReason', async () => {
				mockInvoke.mockResolvedValue(undefined);

				await api.addReason('Auto Run in progress');

				expect(mockInvoke).toHaveBeenCalledWith('power:addReason', 'Auto Run in progress');
			});
		});

		describe('removeReason', () => {
			it('should invoke power:removeReason', async () => {
				mockInvoke.mockResolvedValue(undefined);

				await api.removeReason('Auto Run in progress');

				expect(mockInvoke).toHaveBeenCalledWith('power:removeReason', 'Auto Run in progress');
			});
		});
	});

	describe('createUpdatesApi', () => {
		let api: ReturnType<typeof createUpdatesApi>;

		beforeEach(() => {
			api = createUpdatesApi();
		});

		describe('check', () => {
			it('should invoke updates:check', async () => {
				const updateInfo = {
					currentVersion: '1.0.0',
					latestVersion: '1.1.0',
					updateAvailable: true,
					versionsBehind: 1,
					releases: [],
					releasesUrl: 'https://github.com/example/releases',
				};
				mockInvoke.mockResolvedValue(updateInfo);

				const result = await api.check();

				expect(mockInvoke).toHaveBeenCalledWith('updates:check', undefined);
				expect(result).toEqual(updateInfo);
			});

			it('should invoke updates:check with prerelease flag', async () => {
				mockInvoke.mockResolvedValue({});

				await api.check(true);

				expect(mockInvoke).toHaveBeenCalledWith('updates:check', true);
			});
		});

		describe('download', () => {
			it('should invoke updates:download', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				const result = await api.download();

				expect(mockInvoke).toHaveBeenCalledWith('updates:download');
				expect(result).toEqual({ success: true });
			});
		});

		describe('install', () => {
			it('should invoke updates:install', async () => {
				mockInvoke.mockResolvedValue(undefined);

				await api.install();

				expect(mockInvoke).toHaveBeenCalledWith('updates:install');
			});
		});

		describe('getStatus', () => {
			it('should invoke updates:getStatus', async () => {
				const status = { status: 'idle' as const };
				mockInvoke.mockResolvedValue(status);

				const result = await api.getStatus();

				expect(mockInvoke).toHaveBeenCalledWith('updates:getStatus');
				expect(result).toEqual(status);
			});
		});

		describe('onStatus', () => {
			it('should register event listener and return cleanup function', () => {
				const callback = vi.fn();

				const cleanup = api.onStatus(callback);

				expect(mockOn).toHaveBeenCalledWith('updates:status', expect.any(Function));
				expect(typeof cleanup).toBe('function');
			});

			it('should call callback when event is received', () => {
				const callback = vi.fn();
				let registeredHandler: (event: unknown, status: unknown) => void;

				mockOn.mockImplementation(
					(_channel: string, handler: (event: unknown, status: unknown) => void) => {
						registeredHandler = handler;
					}
				);

				api.onStatus(callback);
				registeredHandler!({}, { status: 'downloading' });

				expect(callback).toHaveBeenCalledWith({ status: 'downloading' });
			});

			it('should remove listener when cleanup is called', () => {
				const callback = vi.fn();
				let registeredHandler: (event: unknown, status: unknown) => void;

				mockOn.mockImplementation(
					(_channel: string, handler: (event: unknown, status: unknown) => void) => {
						registeredHandler = handler;
					}
				);

				const cleanup = api.onStatus(callback);
				cleanup();

				expect(mockRemoveListener).toHaveBeenCalledWith('updates:status', registeredHandler!);
			});
		});

		describe('setAllowPrerelease', () => {
			it('should invoke updates:setAllowPrerelease', async () => {
				mockInvoke.mockResolvedValue(undefined);

				await api.setAllowPrerelease(true);

				expect(mockInvoke).toHaveBeenCalledWith('updates:setAllowPrerelease', true);
			});
		});
	});

	describe('createAppApi', () => {
		let api: ReturnType<typeof createAppApi>;

		beforeEach(() => {
			api = createAppApi();
		});

		describe('onQuitConfirmationRequest', () => {
			it('should register event listener and return cleanup function', () => {
				const callback = vi.fn();

				const cleanup = api.onQuitConfirmationRequest(callback);

				expect(mockOn).toHaveBeenCalledWith('app:requestQuitConfirmation', expect.any(Function));
				expect(typeof cleanup).toBe('function');
			});

			it('should call callback when event is received', () => {
				const callback = vi.fn();
				let registeredHandler: () => void;

				mockOn.mockImplementation((_channel: string, handler: () => void) => {
					registeredHandler = handler;
				});

				api.onQuitConfirmationRequest(callback);
				registeredHandler!();

				expect(callback).toHaveBeenCalled();
			});
		});

		describe('confirmQuit', () => {
			it('should send app:quitConfirmed', () => {
				api.confirmQuit();

				expect(mockSend).toHaveBeenCalledWith('app:quitConfirmed');
			});
		});

		describe('cancelQuit', () => {
			it('should send app:quitCancelled', () => {
				api.cancelQuit();

				expect(mockSend).toHaveBeenCalledWith('app:quitCancelled');
			});
		});
	});
});
