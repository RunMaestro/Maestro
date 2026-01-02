/**
 * Tests for src/main/ios-tools/simulator.ts
 *
 * Tests cover simulator management functions with mocked execFileNoThrow.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock execFileNoThrow
const mockExecFileNoThrow = vi.fn();
vi.mock('../../../main/utils/execFile', () => ({
  execFileNoThrow: (...args: unknown[]) => mockExecFileNoThrow(...args),
}));

import {
  listSimulators,
  listSimulatorsByRuntime,
  getBootedSimulators,
  getSimulator,
  bootSimulator,
  waitForSimulatorBoot,
  shutdownSimulator,
  eraseSimulator,
  installApp,
  uninstallApp,
  launchApp,
  terminateApp,
  getAppContainer,
  openURL,
} from '../../../main/ios-tools/simulator';

describe('simulator.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =============================================================================
  // Sample simctl JSON output
  // =============================================================================

  const mockSimctlListOutput = {
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
        {
          udid: '12345678-1234-1234-1234-123456789012',
          name: 'iPhone 15 Pro',
          state: 'Booted',
          isAvailable: true,
          deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro',
        },
        {
          udid: '87654321-4321-4321-4321-210987654321',
          name: 'iPhone 15',
          state: 'Shutdown',
          isAvailable: true,
          deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
        },
      ],
      'com.apple.CoreSimulator.SimRuntime.iOS-16-4': [
        {
          udid: 'AAAA-BBBB-CCCC-DDDD',
          name: 'iPhone 14',
          state: 'Shutdown',
          isAvailable: true,
          deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-14',
        },
      ],
    },
  };

  // =============================================================================
  // listSimulators
  // =============================================================================

  describe('listSimulators', () => {
    it('returns list of simulators from simctl output', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify(mockSimctlListOutput),
        stderr: '',
        exitCode: 0,
      });

      const result = await listSimulators();

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(3);
      expect(result.data![0].udid).toBe('12345678-1234-1234-1234-123456789012');
      expect(result.data![0].name).toBe('iPhone 15 Pro');
      expect(result.data![0].state).toBe('Booted');
      expect(result.data![0].iosVersion).toBe('17.5');
    });

    it('returns error when simctl command fails', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: 'simctl error',
        exitCode: 1,
      });

      const result = await listSimulators();

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('COMMAND_FAILED');
    });

    it('returns parse error for invalid JSON', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: 'not valid json',
        stderr: '',
        exitCode: 0,
      });

      const result = await listSimulators();

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('PARSE_ERROR');
    });

    it('parses iOS version from runtime identifier', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify(mockSimctlListOutput),
        stderr: '',
        exitCode: 0,
      });

      const result = await listSimulators();

      expect(result.success).toBe(true);
      const ios175Sims = result.data!.filter((s) => s.iosVersion === '17.5');
      const ios164Sims = result.data!.filter((s) => s.iosVersion === '16.4');
      expect(ios175Sims.length).toBe(2);
      expect(ios164Sims.length).toBe(1);
    });
  });

  // =============================================================================
  // listSimulatorsByRuntime
  // =============================================================================

  describe('listSimulatorsByRuntime', () => {
    it('groups simulators by runtime', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify(mockSimctlListOutput),
        stderr: '',
        exitCode: 0,
      });

      const result = await listSimulatorsByRuntime();

      expect(result.success).toBe(true);
      expect(Object.keys(result.data!).length).toBe(2);
      expect(result.data!['com.apple.CoreSimulator.SimRuntime.iOS-17-5'].length).toBe(2);
      expect(result.data!['com.apple.CoreSimulator.SimRuntime.iOS-16-4'].length).toBe(1);
    });

    it('propagates error from listSimulators', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: 'error',
        exitCode: 1,
      });

      const result = await listSimulatorsByRuntime();

      expect(result.success).toBe(false);
    });
  });

  // =============================================================================
  // getBootedSimulators
  // =============================================================================

  describe('getBootedSimulators', () => {
    it('returns only booted simulators', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify(mockSimctlListOutput),
        stderr: '',
        exitCode: 0,
      });

      const result = await getBootedSimulators();

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(result.data![0].state).toBe('Booted');
      expect(result.data![0].name).toBe('iPhone 15 Pro');
    });

    it('returns empty array when no simulators are booted', async () => {
      const allShutdown = {
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
            {
              udid: 'test-udid',
              name: 'iPhone 15',
              state: 'Shutdown',
              isAvailable: true,
              deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
            },
          ],
        },
      };

      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify(allShutdown),
        stderr: '',
        exitCode: 0,
      });

      const result = await getBootedSimulators();

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(0);
    });
  });

  // =============================================================================
  // getSimulator
  // =============================================================================

  describe('getSimulator', () => {
    it('returns specific simulator by UDID', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify(mockSimctlListOutput),
        stderr: '',
        exitCode: 0,
      });

      const result = await getSimulator('12345678-1234-1234-1234-123456789012');

      expect(result.success).toBe(true);
      expect(result.data!.name).toBe('iPhone 15 Pro');
      expect(result.data!.state).toBe('Booted');
    });

    it('returns error when simulator not found', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify(mockSimctlListOutput),
        stderr: '',
        exitCode: 0,
      });

      const result = await getSimulator('nonexistent-udid');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('SIMULATOR_NOT_FOUND');
    });
  });

  // =============================================================================
  // bootSimulator
  // =============================================================================

  describe('bootSimulator', () => {
    it('boots a simulator successfully', async () => {
      // First call: list simulators (to check current state)
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
              {
                udid: 'test-udid',
                name: 'iPhone 15',
                state: 'Shutdown',
                isAvailable: true,
                deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
              },
            ],
          },
        }),
        stderr: '',
        exitCode: 0,
      });

      // Second call: boot command
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      // Third call: check boot status (for waitForBoot)
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
              {
                udid: 'test-udid',
                name: 'iPhone 15',
                state: 'Booted',
                isAvailable: true,
                deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
              },
            ],
          },
        }),
        stderr: '',
        exitCode: 0,
      });

      const result = await bootSimulator({ udid: 'test-udid', timeout: 5000 });

      expect(result.success).toBe(true);
      expect(mockExecFileNoThrow).toHaveBeenCalledWith('xcrun', ['simctl', 'boot', 'test-udid'], undefined);
    });

    it('returns success when already booted', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
              {
                udid: 'test-udid',
                name: 'iPhone 15',
                state: 'Booted',
                isAvailable: true,
                deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
              },
            ],
          },
        }),
        stderr: '',
        exitCode: 0,
      });

      const result = await bootSimulator({ udid: 'test-udid' });

      expect(result.success).toBe(true);
      // Should only call once to check state
      expect(mockExecFileNoThrow).toHaveBeenCalledTimes(1);
    });

    it('returns error when simulator not found', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify({ devices: {} }),
        stderr: '',
        exitCode: 0,
      });

      const result = await bootSimulator({ udid: 'nonexistent' });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('SIMULATOR_NOT_FOUND');
    });

    it('returns error when boot fails', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
              {
                udid: 'test-udid',
                name: 'iPhone 15',
                state: 'Shutdown',
                isAvailable: true,
                deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
              },
            ],
          },
        }),
        stderr: '',
        exitCode: 0,
      });

      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: 'Failed to boot',
        exitCode: 1,
      });

      const result = await bootSimulator({ udid: 'test-udid', waitForBoot: false });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('SIMULATOR_BOOT_FAILED');
    });
  });

  // =============================================================================
  // waitForSimulatorBoot
  // =============================================================================

  describe('waitForSimulatorBoot', () => {
    it('returns success when simulator becomes booted', async () => {
      // First check: still booting
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
              {
                udid: 'test-udid',
                name: 'iPhone 15',
                state: 'Booting',
                isAvailable: true,
                deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
              },
            ],
          },
        }),
        stderr: '',
        exitCode: 0,
      });

      // Second check: booted
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
              {
                udid: 'test-udid',
                name: 'iPhone 15',
                state: 'Booted',
                isAvailable: true,
                deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
              },
            ],
          },
        }),
        stderr: '',
        exitCode: 0,
      });

      const result = await waitForSimulatorBoot('test-udid', 5000);

      expect(result.success).toBe(true);
    });

    it('returns timeout error when boot takes too long', async () => {
      // Always return Booting state
      mockExecFileNoThrow.mockResolvedValue({
        stdout: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
              {
                udid: 'test-udid',
                name: 'iPhone 15',
                state: 'Booting',
                isAvailable: true,
                deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
              },
            ],
          },
        }),
        stderr: '',
        exitCode: 0,
      });

      const result = await waitForSimulatorBoot('test-udid', 100); // Short timeout

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('TIMEOUT');
    });
  });

  // =============================================================================
  // shutdownSimulator
  // =============================================================================

  describe('shutdownSimulator', () => {
    it('shuts down a running simulator', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
              {
                udid: 'test-udid',
                name: 'iPhone 15',
                state: 'Booted',
                isAvailable: true,
                deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
              },
            ],
          },
        }),
        stderr: '',
        exitCode: 0,
      });

      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      const result = await shutdownSimulator('test-udid');

      expect(result.success).toBe(true);
      expect(mockExecFileNoThrow).toHaveBeenLastCalledWith(
        'xcrun',
        ['simctl', 'shutdown', 'test-udid'],
        undefined
      );
    });

    it('returns success when already shutdown', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
              {
                udid: 'test-udid',
                name: 'iPhone 15',
                state: 'Shutdown',
                isAvailable: true,
                deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
              },
            ],
          },
        }),
        stderr: '',
        exitCode: 0,
      });

      const result = await shutdownSimulator('test-udid');

      expect(result.success).toBe(true);
      expect(mockExecFileNoThrow).toHaveBeenCalledTimes(1);
    });
  });

  // =============================================================================
  // eraseSimulator
  // =============================================================================

  describe('eraseSimulator', () => {
    it('erases a simulator after shutting it down', async () => {
      // First: check state and shutdown
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
              {
                udid: 'test-udid',
                name: 'iPhone 15',
                state: 'Shutdown',
                isAvailable: true,
                deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
              },
            ],
          },
        }),
        stderr: '',
        exitCode: 0,
      });

      // Erase command
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      const result = await eraseSimulator('test-udid');

      expect(result.success).toBe(true);
      expect(mockExecFileNoThrow).toHaveBeenLastCalledWith(
        'xcrun',
        ['simctl', 'erase', 'test-udid'],
        undefined
      );
    });
  });

  // =============================================================================
  // installApp
  // =============================================================================

  describe('installApp', () => {
    it('installs app on booted simulator', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
              {
                udid: 'test-udid',
                name: 'iPhone 15',
                state: 'Booted',
                isAvailable: true,
                deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
              },
            ],
          },
        }),
        stderr: '',
        exitCode: 0,
      });

      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      const result = await installApp({ udid: 'test-udid', appPath: '/path/to/MyApp.app' });

      expect(result.success).toBe(true);
      expect(mockExecFileNoThrow).toHaveBeenLastCalledWith(
        'xcrun',
        ['simctl', 'install', 'test-udid', '/path/to/MyApp.app'],
        undefined
      );
    });

    it('returns error when simulator not booted', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
              {
                udid: 'test-udid',
                name: 'iPhone 15',
                state: 'Shutdown',
                isAvailable: true,
                deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
              },
            ],
          },
        }),
        stderr: '',
        exitCode: 0,
      });

      const result = await installApp({ udid: 'test-udid', appPath: '/path/to/MyApp.app' });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('SIMULATOR_NOT_BOOTED');
    });

    it('returns error when install fails', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
              {
                udid: 'test-udid',
                name: 'iPhone 15',
                state: 'Booted',
                isAvailable: true,
                deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
              },
            ],
          },
        }),
        stderr: '',
        exitCode: 0,
      });

      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: 'Installation failed',
        exitCode: 1,
      });

      const result = await installApp({ udid: 'test-udid', appPath: '/path/to/MyApp.app' });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('APP_INSTALL_FAILED');
    });
  });

  // =============================================================================
  // uninstallApp
  // =============================================================================

  describe('uninstallApp', () => {
    it('uninstalls app from simulator', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      const result = await uninstallApp('test-udid', 'com.example.app');

      expect(result.success).toBe(true);
      expect(mockExecFileNoThrow).toHaveBeenCalledWith(
        'xcrun',
        ['simctl', 'uninstall', 'test-udid', 'com.example.app'],
        undefined
      );
    });

    it('returns APP_NOT_INSTALLED when app not found', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: 'Unable to find bundle',
        exitCode: 1,
      });

      const result = await uninstallApp('test-udid', 'com.example.app');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('APP_NOT_INSTALLED');
    });
  });

  // =============================================================================
  // launchApp
  // =============================================================================

  describe('launchApp', () => {
    it('launches app on booted simulator', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
              {
                udid: 'test-udid',
                name: 'iPhone 15',
                state: 'Booted',
                isAvailable: true,
                deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
              },
            ],
          },
        }),
        stderr: '',
        exitCode: 0,
      });

      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      const result = await launchApp({ udid: 'test-udid', bundleId: 'com.example.app' });

      expect(result.success).toBe(true);
      expect(mockExecFileNoThrow).toHaveBeenLastCalledWith(
        'xcrun',
        ['simctl', 'launch', 'test-udid', 'com.example.app'],
        undefined
      );
    });

    it('launches app with arguments', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
              {
                udid: 'test-udid',
                name: 'iPhone 15',
                state: 'Booted',
                isAvailable: true,
                deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
              },
            ],
          },
        }),
        stderr: '',
        exitCode: 0,
      });

      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      const result = await launchApp({
        udid: 'test-udid',
        bundleId: 'com.example.app',
        args: ['--debug', '--verbose'],
      });

      expect(result.success).toBe(true);
      expect(mockExecFileNoThrow).toHaveBeenLastCalledWith(
        'xcrun',
        ['simctl', 'launch', 'test-udid', 'com.example.app', '--', '--debug', '--verbose'],
        undefined
      );
    });

    it('returns error when app not installed', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
              {
                udid: 'test-udid',
                name: 'iPhone 15',
                state: 'Booted',
                isAvailable: true,
                deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
              },
            ],
          },
        }),
        stderr: '',
        exitCode: 0,
      });

      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: 'Unable to find bundle identifier',
        exitCode: 1,
      });

      const result = await launchApp({ udid: 'test-udid', bundleId: 'com.example.app' });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('APP_NOT_INSTALLED');
    });

    it('returns error when simulator not booted', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
              {
                udid: 'test-udid',
                name: 'iPhone 15',
                state: 'Shutdown',
                isAvailable: true,
                deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
              },
            ],
          },
        }),
        stderr: '',
        exitCode: 0,
      });

      const result = await launchApp({ udid: 'test-udid', bundleId: 'com.example.app' });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('SIMULATOR_NOT_BOOTED');
    });
  });

  // =============================================================================
  // terminateApp
  // =============================================================================

  describe('terminateApp', () => {
    it('terminates a running app', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      const result = await terminateApp('test-udid', 'com.example.app');

      expect(result.success).toBe(true);
      expect(mockExecFileNoThrow).toHaveBeenCalledWith(
        'xcrun',
        ['simctl', 'terminate', 'test-udid', 'com.example.app'],
        undefined
      );
    });

    it('returns success when app not running', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: 'not running',
        exitCode: 1,
      });

      const result = await terminateApp('test-udid', 'com.example.app');

      expect(result.success).toBe(true);
    });
  });

  // =============================================================================
  // getAppContainer
  // =============================================================================

  describe('getAppContainer', () => {
    it('returns app container path', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '/Users/user/Library/Developer/CoreSimulator/Devices/test-udid/data/Containers/Data/Application/abc123\n',
        stderr: '',
        exitCode: 0,
      });

      const result = await getAppContainer('test-udid', 'com.example.app', 'data');

      expect(result.success).toBe(true);
      expect(result.data!.path).toBe(
        '/Users/user/Library/Developer/CoreSimulator/Devices/test-udid/data/Containers/Data/Application/abc123'
      );
      expect(result.data!.type).toBe('data');
      expect(result.data!.bundleId).toBe('com.example.app');
    });

    it('returns error when app not installed', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: 'Unable to find',
        exitCode: 1,
      });

      const result = await getAppContainer('test-udid', 'com.nonexistent.app');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('APP_NOT_INSTALLED');
    });
  });

  // =============================================================================
  // openURL
  // =============================================================================

  describe('openURL', () => {
    it('opens URL in simulator', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      const result = await openURL('test-udid', 'myapp://deeplink');

      expect(result.success).toBe(true);
      expect(mockExecFileNoThrow).toHaveBeenCalledWith(
        'xcrun',
        ['simctl', 'openurl', 'test-udid', 'myapp://deeplink'],
        undefined
      );
    });

    it('returns error when openurl fails', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: 'Failed to open URL',
        exitCode: 1,
      });

      const result = await openURL('test-udid', 'invalid://url');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('COMMAND_FAILED');
    });
  });
});
