import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';

// Mock execFileNoThrow
vi.mock('../../../main/utils/execFile', () => ({
  execFileNoThrow: vi.fn(),
}));

// Mock logger to avoid console output during tests
vi.mock('../../../main/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock simulator functions for validateMaestroSetup
vi.mock('../../../main/ios-tools/simulator', () => ({
  getBootedSimulators: vi.fn(),
}));

import { execFileNoThrow } from '../../../main/utils/execFile';
import { getBootedSimulators } from '../../../main/ios-tools/simulator';
import {
  detectMaestroCli,
  isMaestroAvailable,
  getMaestroInfo,
  validateMaestroVersion,
  getInstallInstructions,
  installMaestro,
  validateMaestroSetup,
  runMaestro,
} from '../../../main/ios-tools/maestro-cli';

describe('maestro-cli', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('detectMaestroCli', () => {
    it('detects maestro when found via which', async () => {
      const mockExec = vi.mocked(execFileNoThrow);
      mockExec
        .mockResolvedValueOnce({ stdout: '/usr/local/bin/maestro\n', stderr: '', exitCode: 0 }) // which maestro
        .mockResolvedValueOnce({ stdout: 'maestro version: 1.36.0', stderr: '', exitCode: 0 }); // --version

      const result = await detectMaestroCli();

      expect(result.success).toBe(true);
      expect(result.data?.available).toBe(true);
      expect(result.data?.path).toBe('/usr/local/bin/maestro');
      expect(result.data?.version).toBe('1.36.0');
    });

    it('returns install instructions when not found', async () => {
      const mockExec = vi.mocked(execFileNoThrow);
      mockExec
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 }) // which maestro fails
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 }) // check path 1
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 }) // check path 2
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 }) // check path 3
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 }); // check path 4

      const result = await detectMaestroCli();

      expect(result.success).toBe(true);
      expect(result.data?.available).toBe(false);
      expect(result.data?.installInstructions).toContain('curl');
      expect(result.data?.installInstructions).toContain('Homebrew');
    });
  });

  describe('isMaestroAvailable', () => {
    it('returns true when maestro is found', async () => {
      const mockExec = vi.mocked(execFileNoThrow);
      mockExec.mockResolvedValueOnce({ stdout: '/usr/local/bin/maestro\n', stderr: '', exitCode: 0 });

      const result = await isMaestroAvailable();

      expect(result).toBe(true);
    });

    it('returns false when maestro is not found', async () => {
      const mockExec = vi.mocked(execFileNoThrow);
      mockExec
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });

      const result = await isMaestroAvailable();

      expect(result).toBe(false);
    });
  });

  describe('getMaestroInfo', () => {
    it('returns full info when maestro is available and working', async () => {
      const mockExec = vi.mocked(execFileNoThrow);
      mockExec
        .mockResolvedValueOnce({ stdout: '/usr/local/bin/maestro\n', stderr: '', exitCode: 0 }) // which
        .mockResolvedValueOnce({ stdout: 'maestro version: 1.36.0', stderr: '', exitCode: 0 }) // --version
        .mockResolvedValueOnce({ stdout: 'Usage: maestro ...', stderr: '', exitCode: 0 }); // --help

      const result = await getMaestroInfo();

      expect(result.success).toBe(true);
      expect(result.data?.path).toBe('/usr/local/bin/maestro');
      expect(result.data?.version).toBe('1.36.0');
      expect(result.data?.isWorking).toBe(true);
    });

    it('returns error when not installed', async () => {
      const mockExec = vi.mocked(execFileNoThrow);
      mockExec
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });

      const result = await getMaestroInfo();

      expect(result.success).toBe(false);
      expect(result.error).toContain('not installed');
    });
  });

  describe('validateMaestroVersion', () => {
    it('succeeds when version meets minimum', async () => {
      const mockExec = vi.mocked(execFileNoThrow);
      mockExec
        .mockResolvedValueOnce({ stdout: '/usr/local/bin/maestro\n', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: 'maestro version: 1.36.0', stderr: '', exitCode: 0 });

      const result = await validateMaestroVersion('1.30.0');

      expect(result.success).toBe(true);
    });

    it('fails when version is too low', async () => {
      const mockExec = vi.mocked(execFileNoThrow);
      mockExec
        .mockResolvedValueOnce({ stdout: '/usr/local/bin/maestro\n', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: 'maestro version: 1.20.0', stderr: '', exitCode: 0 });

      const result = await validateMaestroVersion('1.30.0');

      expect(result.success).toBe(false);
      expect(result.error).toContain('below minimum');
    });
  });

  describe('getInstallInstructions', () => {
    it('returns structured installation instructions', () => {
      const instructions = getInstallInstructions();

      expect(instructions.message).toBe('Maestro CLI is not installed');
      expect(instructions.methods.length).toBeGreaterThanOrEqual(2);
      expect(instructions.methods[0].name).toContain('curl');
      expect(instructions.methods[1].name).toContain('Homebrew');
      expect(instructions.documentation).toContain('maestro.mobile.dev');
    });
  });

  describe('installMaestro', () => {
    it('returns success if already installed', async () => {
      const mockExec = vi.mocked(execFileNoThrow);
      // isMaestroAvailable returns true
      mockExec.mockResolvedValueOnce({ stdout: '/usr/local/bin/maestro\n', stderr: '', exitCode: 0 });
      // getMaestroInfo - which, version, help
      mockExec
        .mockResolvedValueOnce({ stdout: '/usr/local/bin/maestro\n', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: 'maestro version: 1.36.0', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: 'Usage...', stderr: '', exitCode: 0 });

      const result = await installMaestro({ method: 'homebrew' });

      expect(result.success).toBe(true);
      expect(result.data?.success).toBe(true);
      expect(result.data?.output).toBe('Already installed');
    });

    it('installs via homebrew when not installed', async () => {
      const mockExec = vi.mocked(execFileNoThrow);
      // isMaestroAvailable returns false
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
      // brew tap
      mockExec.mockResolvedValueOnce({ stdout: 'Tapped', stderr: '', exitCode: 0 });
      // brew install
      mockExec.mockResolvedValueOnce({ stdout: 'Installed maestro', stderr: '', exitCode: 0 });
      // detectMaestroCli after install
      mockExec.mockResolvedValueOnce({ stdout: '/usr/local/bin/maestro\n', stderr: '', exitCode: 0 });
      mockExec.mockResolvedValueOnce({ stdout: 'maestro version: 1.36.0', stderr: '', exitCode: 0 });

      const result = await installMaestro({ method: 'homebrew' });

      expect(result.success).toBe(true);
      expect(result.data?.success).toBe(true);
      expect(result.data?.method).toBe('homebrew');
      expect(result.data?.version).toBe('1.36.0');
    });

    it('installs via curl when not installed', async () => {
      const mockExec = vi.mocked(execFileNoThrow);
      // isMaestroAvailable returns false
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
      // curl download
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
      // chmod
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
      // bash script
      mockExec.mockResolvedValueOnce({ stdout: 'Installing...', stderr: '', exitCode: 0 });
      // rm cleanup
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
      // detectMaestroCli after install
      mockExec.mockResolvedValueOnce({ stdout: '~/.maestro/bin/maestro\n', stderr: '', exitCode: 0 });
      mockExec.mockResolvedValueOnce({ stdout: 'maestro version: 1.36.0', stderr: '', exitCode: 0 });

      const result = await installMaestro({ method: 'curl' });

      expect(result.success).toBe(true);
      expect(result.data?.success).toBe(true);
      expect(result.data?.method).toBe('curl');
    });

    it('returns error if homebrew tap fails', async () => {
      const mockExec = vi.mocked(execFileNoThrow);
      // isMaestroAvailable returns false
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
      // brew tap fails
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: 'Error: tap failed', exitCode: 1 });

      const result = await installMaestro({ method: 'homebrew' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('tap failed');
    });
  });

  describe('validateMaestroSetup', () => {
    it('returns valid when all checks pass', async () => {
      const mockExec = vi.mocked(execFileNoThrow);
      const mockGetBootedSims = vi.mocked(getBootedSimulators);

      // detectMaestroCli - which and version
      mockExec
        .mockResolvedValueOnce({ stdout: '/usr/local/bin/maestro\n', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: 'maestro version: 1.36.0', stderr: '', exitCode: 0 });

      // getBootedSimulators
      mockGetBootedSims.mockResolvedValueOnce({
        success: true,
        data: [{ udid: '12345', name: 'iPhone 15', state: 'Booted' } as any],
      });

      // runMaestro doctor
      mockExec.mockResolvedValueOnce({ stdout: '/usr/local/bin/maestro\n', stderr: '', exitCode: 0 }); // which for runMaestro
      mockExec.mockResolvedValueOnce({ stdout: 'All checks passed', stderr: '', exitCode: 0 }); // doctor command

      const result = await validateMaestroSetup();

      expect(result.success).toBe(true);
      expect(result.data?.valid).toBe(true);
      expect(result.data?.cliInstalled).toBe(true);
      expect(result.data?.simulatorAvailable).toBe(true);
      expect(result.data?.iosDriverWorking).toBe(true);
      expect(result.data?.issues.length).toBe(0);
    });

    it('returns invalid when CLI not installed', async () => {
      const mockExec = vi.mocked(execFileNoThrow);
      const mockGetBootedSims = vi.mocked(getBootedSimulators);

      // detectMaestroCli - not found
      mockExec
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });

      // getBootedSimulators
      mockGetBootedSims.mockResolvedValueOnce({
        success: true,
        data: [{ udid: '12345', name: 'iPhone 15', state: 'Booted' } as any],
      });

      const result = await validateMaestroSetup();

      expect(result.success).toBe(true);
      expect(result.data?.valid).toBe(false);
      expect(result.data?.cliInstalled).toBe(false);
      expect(result.data?.issues).toContain('Maestro CLI is not installed');
      expect(result.data?.recommendations.length).toBeGreaterThan(0);
    });

    it('returns invalid when no simulators booted', async () => {
      const mockExec = vi.mocked(execFileNoThrow);
      const mockGetBootedSims = vi.mocked(getBootedSimulators);

      // detectMaestroCli
      mockExec
        .mockResolvedValueOnce({ stdout: '/usr/local/bin/maestro\n', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: 'maestro version: 1.36.0', stderr: '', exitCode: 0 });

      // getBootedSimulators - none found
      mockGetBootedSims.mockResolvedValueOnce({
        success: true,
        data: [],
      });

      const result = await validateMaestroSetup();

      expect(result.success).toBe(true);
      expect(result.data?.valid).toBe(false);
      expect(result.data?.simulatorAvailable).toBe(false);
      expect(result.data?.issues).toContain('No booted iOS simulators found');
    });
  });

  describe('runMaestro', () => {
    it('runs maestro command successfully', async () => {
      const mockExec = vi.mocked(execFileNoThrow);
      // findMaestroBinary - which
      mockExec.mockResolvedValueOnce({ stdout: '/usr/local/bin/maestro\n', stderr: '', exitCode: 0 });
      // actual command
      mockExec.mockResolvedValueOnce({ stdout: 'Flow passed!', stderr: '', exitCode: 0 });

      const result = await runMaestro(['test', 'flow.yaml']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('Flow passed!');
    });

    it('returns error when maestro not found', async () => {
      const mockExec = vi.mocked(execFileNoThrow);
      // findMaestroBinary - not found
      mockExec
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });

      const result = await runMaestro(['test', 'flow.yaml']);

      expect(result.exitCode).toBe('ENOENT');
      expect(result.stderr).toContain('not found');
    });
  });
});
