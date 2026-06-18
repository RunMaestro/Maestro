import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing the module
vi.mock('electron', () => ({
	powerSaveBlocker: {
		start: vi.fn(() => 1),
		stop: vi.fn(),
		isStarted: vi.fn(() => true),
	},
}));

vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Import after mocking
import { powerSaveBlocker } from 'electron';
import { logger } from '../../main/utils/logger';

// We need to create a fresh instance for each test to avoid state leakage
// Since power-manager exports a singleton, we'll use resetModules
describe('PowerManager', () => {
	let PowerManagerModule: typeof import('../../main/power-manager');
	const mockPowerSaveBlocker = vi.mocked(powerSaveBlocker);
	const originalPlatform = process.platform;

	beforeEach(async () => {
		vi.clearAllMocks();
		// Reset mock return values
		mockPowerSaveBlocker.start.mockReturnValue(1);
		mockPowerSaveBlocker.isStarted.mockReturnValue(true);
		// Reset modules to get a fresh PowerManager instance
		vi.resetModules();
		// Re-apply mocks after reset
		vi.doMock('electron', () => ({
			powerSaveBlocker: {
				start: vi.fn(() => 1),
				stop: vi.fn(),
				isStarted: vi.fn(() => true),
			},
		}));
		vi.doMock('../../main/utils/logger', () => ({
			logger: {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
			},
		}));
		PowerManagerModule = await import('../../main/power-manager');
	});

	afterEach(() => {
		vi.restoreAllMocks();
		Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
	});

	describe('setEnabled', () => {
		it('should set enabled state to true', async () => {
			const { powerManager } = PowerManagerModule;

			powerManager.setEnabled(true);

			expect(powerManager.isEnabled()).toBe(true);
		});

		it('should set enabled state to false', async () => {
			const { powerManager } = PowerManagerModule;

			powerManager.setEnabled(true);
			powerManager.setEnabled(false);

			expect(powerManager.isEnabled()).toBe(false);
		});

		it('should stop any active blocker when disabled', async () => {
			const { powerManager } = PowerManagerModule;
			const { powerSaveBlocker: mockBlocker } = await import('electron');

			// Enable and add a reason to start blocking
			powerManager.setEnabled(true);
			powerManager.addBlockReason('test:session1');

			// Now disable
			powerManager.setEnabled(false);

			// Should have stopped the blocker
			expect(vi.mocked(mockBlocker.stop)).toHaveBeenCalled();
		});

		it('should start blocking if enabled with existing reasons', async () => {
			const { powerManager } = PowerManagerModule;
			const { powerSaveBlocker: mockBlocker } = await import('electron');

			// Add reason while disabled (no blocking should occur)
			powerManager.addBlockReason('test:session1');
			expect(vi.mocked(mockBlocker.start)).not.toHaveBeenCalled();

			// Now enable - should start blocking
			powerManager.setEnabled(true);
			expect(vi.mocked(mockBlocker.start)).toHaveBeenCalled();
		});
	});

	describe('isEnabled', () => {
		it('should return false initially', async () => {
			const { powerManager } = PowerManagerModule;

			expect(powerManager.isEnabled()).toBe(false);
		});

		it('should return true after setEnabled(true)', async () => {
			const { powerManager } = PowerManagerModule;

			powerManager.setEnabled(true);

			expect(powerManager.isEnabled()).toBe(true);
		});
	});

	describe('addBlockReason', () => {
		it('should NOT start blocker when disabled', async () => {
			const { powerManager } = PowerManagerModule;
			const { powerSaveBlocker: mockBlocker } = await import('electron');

			// Feature is disabled by default
			powerManager.addBlockReason('test:session1');

			expect(vi.mocked(mockBlocker.start)).not.toHaveBeenCalled();
			expect(powerManager.getStatus().blocking).toBe(false);
		});

		it('should start blocker on first reason when enabled', async () => {
			const { powerManager } = PowerManagerModule;
			const { powerSaveBlocker: mockBlocker } = await import('electron');

			powerManager.setEnabled(true);
			powerManager.addBlockReason('test:session1');

			expect(vi.mocked(mockBlocker.start)).toHaveBeenCalledWith('prevent-display-sleep');
			expect(powerManager.getStatus().blocking).toBe(true);
		});

		it('should NOT start additional blocker with existing reasons', async () => {
			const { powerManager } = PowerManagerModule;
			const { powerSaveBlocker: mockBlocker } = await import('electron');

			powerManager.setEnabled(true);
			powerManager.addBlockReason('test:session1');

			const startCallCount = vi.mocked(mockBlocker.start).mock.calls.length;

			powerManager.addBlockReason('test:session2');
			powerManager.addBlockReason('test:session3');

			// Should still be only one start call
			expect(vi.mocked(mockBlocker.start).mock.calls.length).toBe(startCallCount);
		});

		it('should be idempotent for duplicate reasons', async () => {
			const { powerManager } = PowerManagerModule;
			const { powerSaveBlocker: mockBlocker } = await import('electron');

			powerManager.setEnabled(true);
			powerManager.addBlockReason('test:session1');

			const startCallCount = vi.mocked(mockBlocker.start).mock.calls.length;

			// Add same reason again
			powerManager.addBlockReason('test:session1');
			powerManager.addBlockReason('test:session1');

			// Should not start additional blockers
			expect(vi.mocked(mockBlocker.start).mock.calls.length).toBe(startCallCount);
			// Should only have one reason
			expect(powerManager.getStatus().reasons).toEqual(['test:session1']);
		});

		it('should track multiple unique reasons', async () => {
			const { powerManager } = PowerManagerModule;

			powerManager.setEnabled(true);
			powerManager.addBlockReason('session:abc123');
			powerManager.addBlockReason('autorun:batch1');
			powerManager.addBlockReason('groupchat:group1');

			const status = powerManager.getStatus();
			expect(status.reasons).toHaveLength(3);
			expect(status.reasons).toContain('session:abc123');
			expect(status.reasons).toContain('autorun:batch1');
			expect(status.reasons).toContain('groupchat:group1');
		});
	});

	describe('removeBlockReason', () => {
		it('should keep blocker active with remaining reasons', async () => {
			const { powerManager } = PowerManagerModule;
			const { powerSaveBlocker: mockBlocker } = await import('electron');

			powerManager.setEnabled(true);
			powerManager.addBlockReason('test:session1');
			powerManager.addBlockReason('test:session2');

			powerManager.removeBlockReason('test:session1');

			// Blocker should still be active
			expect(vi.mocked(mockBlocker.stop)).not.toHaveBeenCalled();
			expect(powerManager.getStatus().blocking).toBe(true);
			expect(powerManager.getStatus().reasons).toEqual(['test:session2']);
		});

		it('should stop blocker when removing last reason', async () => {
			const { powerManager } = PowerManagerModule;
			const { powerSaveBlocker: mockBlocker } = await import('electron');

			powerManager.setEnabled(true);
			powerManager.addBlockReason('test:session1');

			powerManager.removeBlockReason('test:session1');

			expect(vi.mocked(mockBlocker.stop)).toHaveBeenCalled();
			expect(powerManager.getStatus().blocking).toBe(false);
			expect(powerManager.getStatus().reasons).toEqual([]);
		});

		it('should be a no-op for non-existent reason', async () => {
			const { powerManager } = PowerManagerModule;
			const { powerSaveBlocker: mockBlocker } = await import('electron');

			powerManager.setEnabled(true);
			powerManager.addBlockReason('test:session1');

			// This should not throw or cause any issues
			powerManager.removeBlockReason('non-existent');

			// Should still have original reason
			expect(powerManager.getStatus().reasons).toEqual(['test:session1']);
			expect(vi.mocked(mockBlocker.stop)).not.toHaveBeenCalled();
		});

		it('should handle removing reason when already empty', async () => {
			const { powerManager } = PowerManagerModule;

			powerManager.setEnabled(true);

			// Should not throw
			expect(() => powerManager.removeBlockReason('test:nonexistent')).not.toThrow();
			expect(powerManager.getStatus().reasons).toEqual([]);
		});
	});

	describe('clearAllReasons', () => {
		it('should remove all reasons and stop blocker', async () => {
			const { powerManager } = PowerManagerModule;
			const { powerSaveBlocker: mockBlocker } = await import('electron');

			powerManager.setEnabled(true);
			powerManager.addBlockReason('test:session1');
			powerManager.addBlockReason('test:session2');
			powerManager.addBlockReason('autorun:batch1');

			powerManager.clearAllReasons();

			expect(vi.mocked(mockBlocker.stop)).toHaveBeenCalled();
			expect(powerManager.getStatus().reasons).toEqual([]);
			expect(powerManager.getStatus().blocking).toBe(false);
		});

		it('should be safe to call when no reasons exist', async () => {
			const { powerManager } = PowerManagerModule;

			powerManager.setEnabled(true);

			// Should not throw
			expect(() => powerManager.clearAllReasons()).not.toThrow();
			expect(powerManager.getStatus().reasons).toEqual([]);
		});

		it('should be safe to call when not blocking', async () => {
			const { powerManager } = PowerManagerModule;

			// Disabled, add reasons
			powerManager.addBlockReason('test:session1');

			// Should not throw even though not blocking
			expect(() => powerManager.clearAllReasons()).not.toThrow();
			expect(powerManager.getStatus().reasons).toEqual([]);
		});
	});

	describe('getStatus', () => {
		it('should return correct initial state', async () => {
			const { powerManager } = PowerManagerModule;

			const status = powerManager.getStatus();

			expect(status.enabled).toBe(false);
			expect(status.blocking).toBe(false);
			expect(status.reasons).toEqual([]);
			expect(['darwin', 'win32', 'linux']).toContain(status.platform);
		});

		it('should return correct state when enabled and blocking', async () => {
			const { powerManager } = PowerManagerModule;

			powerManager.setEnabled(true);
			powerManager.addBlockReason('test:session1');

			const status = powerManager.getStatus();

			expect(status.enabled).toBe(true);
			expect(status.blocking).toBe(true);
			expect(status.reasons).toEqual(['test:session1']);
		});

		it('should return correct state when enabled but not blocking', async () => {
			const { powerManager } = PowerManagerModule;

			powerManager.setEnabled(true);

			const status = powerManager.getStatus();

			expect(status.enabled).toBe(true);
			expect(status.blocking).toBe(false);
			expect(status.reasons).toEqual([]);
		});

		it('should return correct state when disabled with reasons pending', async () => {
			const { powerManager } = PowerManagerModule;

			// Add reasons while disabled
			powerManager.addBlockReason('test:session1');

			const status = powerManager.getStatus();

			expect(status.enabled).toBe(false);
			expect(status.blocking).toBe(false);
			expect(status.reasons).toEqual(['test:session1']);
		});

		it('should return platform correctly', async () => {
			const { powerManager } = PowerManagerModule;

			const status = powerManager.getStatus();

			expect(status.platform).toBe(process.platform);
		});
	});

	describe('toggling setEnabled while blocking', () => {
		it('should stop blocker immediately when disabled while blocking', async () => {
			const { powerManager } = PowerManagerModule;
			const { powerSaveBlocker: mockBlocker } = await import('electron');

			powerManager.setEnabled(true);
			powerManager.addBlockReason('test:session1');
			powerManager.addBlockReason('test:session2');

			// Verify blocking
			expect(powerManager.getStatus().blocking).toBe(true);

			// Now disable while still having reasons
			powerManager.setEnabled(false);

			// Blocker should be stopped
			expect(vi.mocked(mockBlocker.stop)).toHaveBeenCalled();
			expect(powerManager.getStatus().blocking).toBe(false);

			// Reasons should still be tracked
			expect(powerManager.getStatus().reasons).toHaveLength(2);
		});

		it('should resume blocking when re-enabled with pending reasons', async () => {
			const { powerManager } = PowerManagerModule;
			const { powerSaveBlocker: mockBlocker } = await import('electron');

			powerManager.setEnabled(true);
			powerManager.addBlockReason('test:session1');

			// Disable
			powerManager.setEnabled(false);
			vi.mocked(mockBlocker.start).mockClear();

			// Re-enable
			powerManager.setEnabled(true);

			// Should have started blocking again
			expect(vi.mocked(mockBlocker.start)).toHaveBeenCalled();
			expect(powerManager.getStatus().blocking).toBe(true);
		});
	});

	describe('error handling', () => {
		it('should handle powerSaveBlocker.start failure gracefully', async () => {
			const { powerManager } = PowerManagerModule;
			const { powerSaveBlocker: mockBlocker } = await import('electron');
			const { logger: mockLogger } = await import('../../main/utils/logger');

			vi.mocked(mockBlocker.start).mockImplementation(() => {
				throw new Error('Failed to start blocker');
			});

			powerManager.setEnabled(true);

			// Should not throw
			expect(() => powerManager.addBlockReason('test:session1')).not.toThrow();

			// Should log error
			expect(vi.mocked(mockLogger.error)).toHaveBeenCalledWith(
				'Failed to start power save blocker',
				'PowerManager',
				expect.any(Error)
			);

			// Status should show not blocking
			expect(powerManager.getStatus().blocking).toBe(false);
		});

		it('should handle powerSaveBlocker.stop failure gracefully', async () => {
			const { powerManager } = PowerManagerModule;
			const { powerSaveBlocker: mockBlocker } = await import('electron');
			const { logger: mockLogger } = await import('../../main/utils/logger');

			powerManager.setEnabled(true);
			powerManager.addBlockReason('test:session1');

			// Make stop throw
			vi.mocked(mockBlocker.stop).mockImplementation(() => {
				throw new Error('Failed to stop blocker');
			});

			// Should not throw
			expect(() => powerManager.removeBlockReason('test:session1')).not.toThrow();

			// Should log error
			expect(vi.mocked(mockLogger.error)).toHaveBeenCalledWith(
				'Error stopping power save blocker',
				'PowerManager',
				expect.any(Error)
			);
		});
	});

	describe('logging', () => {
		it('should log when sleep prevention is enabled', async () => {
			const { powerManager } = PowerManagerModule;
			const { logger: mockLogger } = await import('../../main/utils/logger');

			powerManager.setEnabled(true);

			expect(vi.mocked(mockLogger.info)).toHaveBeenCalledWith(
				expect.stringContaining('enabled'),
				'PowerManager'
			);
		});

		it('should log when sleep prevention is disabled', async () => {
			const { powerManager } = PowerManagerModule;
			const { logger: mockLogger } = await import('../../main/utils/logger');

			powerManager.setEnabled(true);
			vi.mocked(mockLogger.info).mockClear();

			powerManager.setEnabled(false);

			expect(vi.mocked(mockLogger.info)).toHaveBeenCalledWith(
				expect.stringContaining('disabled'),
				'PowerManager'
			);
		});

		it('should log when blocker is started', async () => {
			const { powerManager } = PowerManagerModule;
			const { logger: mockLogger } = await import('../../main/utils/logger');

			powerManager.setEnabled(true);
			vi.mocked(mockLogger.info).mockClear();

			powerManager.addBlockReason('test:session1');

			expect(vi.mocked(mockLogger.info)).toHaveBeenCalledWith(
				expect.stringContaining('Started power save blocker'),
				'PowerManager',
				expect.any(Object)
			);
		});

		it('should log when blocker is stopped', async () => {
			const { powerManager } = PowerManagerModule;
			const { logger: mockLogger } = await import('../../main/utils/logger');

			powerManager.setEnabled(true);
			powerManager.addBlockReason('test:session1');
			vi.mocked(mockLogger.info).mockClear();

			powerManager.removeBlockReason('test:session1');

			expect(vi.mocked(mockLogger.info)).toHaveBeenCalledWith(
				expect.stringContaining('Stopped power save blocker'),
				'PowerManager'
			);
		});
	});

	describe('platform-specific behavior', () => {
		it('should log warning on Linux platform', async () => {
			Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

			// Reset modules to get fresh import with new platform
			vi.resetModules();
			vi.doMock('electron', () => ({
				powerSaveBlocker: {
					start: vi.fn(() => 1),
					stop: vi.fn(),
					isStarted: vi.fn(() => true),
				},
			}));
			vi.doMock('../../main/utils/logger', () => ({
				logger: {
					info: vi.fn(),
					warn: vi.fn(),
					error: vi.fn(),
					debug: vi.fn(),
				},
			}));

			const { powerManager } = await import('../../main/power-manager');
			const { logger: mockLogger } = await import('../../main/utils/logger');

			// Should have logged Linux warning on init
			expect(vi.mocked(mockLogger.warn)).toHaveBeenCalledWith(
				expect.stringContaining('Linux'),
				'PowerManager'
			);

			// Verify status shows linux platform
			expect(powerManager.getStatus().platform).toBe('linux');
		});

		it('should not log warning on macOS platform', async () => {
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

			vi.resetModules();
			vi.doMock('electron', () => ({
				powerSaveBlocker: {
					start: vi.fn(() => 1),
					stop: vi.fn(),
					isStarted: vi.fn(() => true),
				},
			}));
			vi.doMock('../../main/utils/logger', () => ({
				logger: {
					info: vi.fn(),
					warn: vi.fn(),
					error: vi.fn(),
					debug: vi.fn(),
				},
			}));

			await import('../../main/power-manager');
			const { logger: mockLogger } = await import('../../main/utils/logger');

			// Should not have logged Linux warning
			expect(vi.mocked(mockLogger.warn)).not.toHaveBeenCalledWith(
				expect.stringContaining('Linux'),
				'PowerManager'
			);
		});

		it('should not log warning on Windows platform', async () => {
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

			vi.resetModules();
			vi.doMock('electron', () => ({
				powerSaveBlocker: {
					start: vi.fn(() => 1),
					stop: vi.fn(),
					isStarted: vi.fn(() => true),
				},
			}));
			vi.doMock('../../main/utils/logger', () => ({
				logger: {
					info: vi.fn(),
					warn: vi.fn(),
					error: vi.fn(),
					debug: vi.fn(),
				},
			}));

			await import('../../main/power-manager');
			const { logger: mockLogger } = await import('../../main/utils/logger');

			// Should not have logged Linux warning
			expect(vi.mocked(mockLogger.warn)).not.toHaveBeenCalledWith(
				expect.stringContaining('Linux'),
				'PowerManager'
			);
		});
	});

	describe('blocker already stopped scenario', () => {
		it('should handle case when blocker is already stopped externally', async () => {
			const { powerManager } = PowerManagerModule;
			const { powerSaveBlocker: mockBlocker } = await import('electron');

			powerManager.setEnabled(true);
			powerManager.addBlockReason('test:session1');

			// Simulate blocker being stopped externally
			vi.mocked(mockBlocker.isStarted).mockReturnValue(false);

			// Should not throw when trying to remove reason
			expect(() => powerManager.removeBlockReason('test:session1')).not.toThrow();

			// stop should not be called since isStarted returned false
			expect(vi.mocked(mockBlocker.stop)).not.toHaveBeenCalled();
		});
	});

	describe('PowerStatus interface', () => {
		it('should have correct type for PowerStatus', async () => {
			const { powerManager } = PowerManagerModule;

			const status = powerManager.getStatus();

			// Verify the structure matches PowerStatus interface
			expect(typeof status.enabled).toBe('boolean');
			expect(typeof status.blocking).toBe('boolean');
			expect(Array.isArray(status.reasons)).toBe(true);
			expect(typeof status.platform).toBe('string');
			expect(['darwin', 'win32', 'linux']).toContain(status.platform);
		});
	});
});
