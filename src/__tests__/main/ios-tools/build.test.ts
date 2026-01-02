/**
 * Tests for src/main/ios-tools/build.ts
 *
 * Tests cover Xcode build operations with mocked xcodebuild commands.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

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

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  default: {
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
  },
}));

import {
  detectProject,
  listSchemes,
  listTargets,
  build,
  buildForTesting,
  getDefaultDerivedDataPath,
  getDerivedDataPath,
  getBuiltAppPath,
  getBuildSettings,
} from '../../../main/ios-tools/build';

describe('build.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =============================================================================
  // detectProject
  // =============================================================================

  describe('detectProject', () => {
    it('detects .xcworkspace in directory', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        'MyApp.xcworkspace',
        'MyApp.xcodeproj',
        'Pods.xcodeproj',
      ] as unknown as fs.Dirent[]);

      const result = await detectProject('/path/to/project');

      expect(result.success).toBe(true);
      expect(result.data!.type).toBe('workspace');
      expect(result.data!.name).toBe('MyApp');
      expect(result.data!.path).toBe('/path/to/project/MyApp.xcworkspace');
    });

    it('prefers non-Pods workspace when multiple exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        'Pods.xcworkspace',
        'MyApp.xcworkspace',
      ] as unknown as fs.Dirent[]);

      const result = await detectProject('/path/to/project');

      expect(result.success).toBe(true);
      expect(result.data!.name).toBe('MyApp');
    });

    it('falls back to .xcodeproj when no workspace', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        'MyApp.xcodeproj',
        'README.md',
      ] as unknown as fs.Dirent[]);

      const result = await detectProject('/path/to/project');

      expect(result.success).toBe(true);
      expect(result.data!.type).toBe('project');
      expect(result.data!.name).toBe('MyApp');
    });

    it('returns error when directory does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await detectProject('/nonexistent/path');

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');
    });

    it('returns error when no project found', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        'README.md',
        'Package.swift',
      ] as unknown as fs.Dirent[]);

      const result = await detectProject('/path/to/project');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No Xcode project');
    });
  });

  // =============================================================================
  // listSchemes
  // =============================================================================

  describe('listSchemes', () => {
    it('lists schemes from workspace', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify({
          workspace: {
            name: 'MyApp',
            schemes: ['MyApp', 'MyAppTests', 'MyAppUITests'],
          },
        }),
        stderr: '',
        exitCode: 0,
      });

      const result = await listSchemes('/path/to/MyApp.xcworkspace');

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(3);
      expect(result.data![0].name).toBe('MyApp');
      expect(mockExecFileNoThrow).toHaveBeenCalledWith(
        'xcodebuild',
        ['-workspace', '/path/to/MyApp.xcworkspace', '-list', '-json'],
        undefined
      );
    });

    it('lists schemes from project', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify({
          project: {
            name: 'MyApp',
            schemes: ['MyApp', 'MyAppTests'],
            targets: ['MyApp', 'MyAppTests'],
          },
        }),
        stderr: '',
        exitCode: 0,
      });

      const result = await listSchemes('/path/to/MyApp.xcodeproj');

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
      expect(mockExecFileNoThrow).toHaveBeenCalledWith(
        'xcodebuild',
        ['-project', '/path/to/MyApp.xcodeproj', '-list', '-json'],
        undefined
      );
    });

    it('returns error when xcodebuild fails', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: 'xcodebuild error',
        exitCode: 1,
      });

      const result = await listSchemes('/path/to/Invalid.xcodeproj');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('COMMAND_FAILED');
    });

    it('returns error for invalid JSON', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: 'not json',
        stderr: '',
        exitCode: 0,
      });

      const result = await listSchemes('/path/to/MyApp.xcodeproj');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('PARSE_ERROR');
    });
  });

  // =============================================================================
  // listTargets
  // =============================================================================

  describe('listTargets', () => {
    it('lists targets from project', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify({
          project: {
            name: 'MyApp',
            schemes: ['MyApp'],
            targets: ['MyApp', 'MyAppTests', 'MyAppFramework'],
          },
        }),
        stderr: '',
        exitCode: 0,
      });

      const result = await listTargets('/path/to/MyApp.xcodeproj');

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(3);
      expect(result.data![0].name).toBe('MyApp');
    });

    it('returns error for workspace', async () => {
      const result = await listTargets('/path/to/MyApp.xcworkspace');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Cannot list targets for a workspace');
    });
  });

  // =============================================================================
  // build
  // =============================================================================

  describe('build', () => {
    const homeDir = process.env.HOME || '/Users/test';

    beforeEach(() => {
      // Mock fs for getBuiltAppPath
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['MyApp.app'] as unknown as fs.Dirent[]);
    });

    it('builds project with default options', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '** BUILD SUCCEEDED **',
        stderr: '',
        exitCode: 0,
      });

      const result = await build({
        projectPath: '/path/to/MyApp.xcodeproj',
        scheme: 'MyApp',
      });

      expect(result.success).toBe(true);
      expect(result.data!.success).toBe(true);
      expect(result.data!.duration).toBeGreaterThanOrEqual(0);
      expect(mockExecFileNoThrow).toHaveBeenCalledWith(
        'xcodebuild',
        expect.arrayContaining([
          '-project', '/path/to/MyApp.xcodeproj',
          '-scheme', 'MyApp',
          '-configuration', 'Debug',
          '-sdk', 'iphonesimulator',
        ]),
        undefined
      );
    });

    it('builds workspace with specified destination', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '** BUILD SUCCEEDED **',
        stderr: '',
        exitCode: 0,
      });

      await build({
        projectPath: '/path/to/MyApp.xcworkspace',
        scheme: 'MyApp',
        destination: 'platform=iOS Simulator,id=test-udid',
      });

      expect(mockExecFileNoThrow).toHaveBeenCalledWith(
        'xcodebuild',
        expect.arrayContaining([
          '-workspace', '/path/to/MyApp.xcworkspace',
          '-destination', 'platform=iOS Simulator,id=test-udid',
        ]),
        undefined
      );
    });

    it('builds with custom configuration', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '** BUILD SUCCEEDED **',
        stderr: '',
        exitCode: 0,
      });

      await build({
        projectPath: '/path/to/MyApp.xcodeproj',
        scheme: 'MyApp',
        configuration: 'Release',
      });

      expect(mockExecFileNoThrow).toHaveBeenCalledWith(
        'xcodebuild',
        expect.arrayContaining(['-configuration', 'Release']),
        undefined
      );
    });

    it('builds with custom derived data path', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '** BUILD SUCCEEDED **',
        stderr: '',
        exitCode: 0,
      });

      await build({
        projectPath: '/path/to/MyApp.xcodeproj',
        scheme: 'MyApp',
        derivedDataPath: '/custom/derived/data',
      });

      expect(mockExecFileNoThrow).toHaveBeenCalledWith(
        'xcodebuild',
        expect.arrayContaining(['-derivedDataPath', '/custom/derived/data']),
        undefined
      );
    });

    it('cleans before build when requested', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '** BUILD SUCCEEDED **',
        stderr: '',
        exitCode: 0,
      });

      await build({
        projectPath: '/path/to/MyApp.xcodeproj',
        scheme: 'MyApp',
        clean: true,
      });

      expect(mockExecFileNoThrow).toHaveBeenCalledWith(
        'xcodebuild',
        expect.arrayContaining(['clean', 'build']),
        undefined
      );
    });

    it('returns BUILD_FAILED on build failure', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: 'error: Build failed',
        exitCode: 65,
      });

      const result = await build({
        projectPath: '/path/to/MyApp.xcodeproj',
        scheme: 'MyApp',
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('BUILD_FAILED');
      expect(result.data!.success).toBe(false);
    });

    it('extracts warnings from output', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '/path/to/file.swift: warning: Unused variable\n/path/to/other.swift: warning: Deprecated API',
        stderr: '',
        exitCode: 0,
      });

      const result = await build({
        projectPath: '/path/to/MyApp.xcodeproj',
        scheme: 'MyApp',
      });

      expect(result.success).toBe(true);
      expect(result.data!.warnings.length).toBe(2);
    });

    it('extracts errors from output', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: '/path/to/file.swift: error: Cannot find module\n/path/to/other.swift: error: Compilation failed',
        exitCode: 1,
      });

      const result = await build({
        projectPath: '/path/to/MyApp.xcodeproj',
        scheme: 'MyApp',
      });

      expect(result.success).toBe(false);
      expect(result.data!.errors.length).toBe(2);
    });

    it('passes additional arguments', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '** BUILD SUCCEEDED **',
        stderr: '',
        exitCode: 0,
      });

      await build({
        projectPath: '/path/to/MyApp.xcodeproj',
        scheme: 'MyApp',
        additionalArgs: ['CODE_SIGNING_ALLOWED=NO', '-quiet'],
      });

      expect(mockExecFileNoThrow).toHaveBeenCalledWith(
        'xcodebuild',
        expect.arrayContaining(['CODE_SIGNING_ALLOWED=NO', '-quiet']),
        undefined
      );
    });
  });

  // =============================================================================
  // buildForTesting
  // =============================================================================

  describe('buildForTesting', () => {
    it('builds for testing', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '** BUILD SUCCEEDED **',
        stderr: '',
        exitCode: 0,
      });

      const result = await buildForTesting({
        projectPath: '/path/to/MyApp.xcodeproj',
        scheme: 'MyApp',
      });

      expect(result.success).toBe(true);
      expect(mockExecFileNoThrow).toHaveBeenCalledWith(
        'xcodebuild',
        expect.arrayContaining(['build-for-testing']),
        undefined
      );
    });
  });

  // =============================================================================
  // getDefaultDerivedDataPath
  // =============================================================================

  describe('getDefaultDerivedDataPath', () => {
    it('returns default derived data path', () => {
      const result = getDefaultDerivedDataPath();

      expect(result).toContain('Library/Developer/Xcode/DerivedData');
    });
  });

  // =============================================================================
  // getDerivedDataPath
  // =============================================================================

  describe('getDerivedDataPath', () => {
    it('finds derived data for project', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        'MyApp-abcdef123',
        'OtherProject-xyz789',
      ] as unknown as fs.Dirent[]);

      const result = await getDerivedDataPath('/path/to/MyApp.xcodeproj');

      expect(result.success).toBe(true);
      expect(result.data).toContain('MyApp-abcdef123');
    });

    it('returns error when derived data not found', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        'OtherProject-xyz789',
      ] as unknown as fs.Dirent[]);

      const result = await getDerivedDataPath('/path/to/MyApp.xcodeproj');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No derived data found');
    });

    it('returns error when derived data directory does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await getDerivedDataPath('/path/to/MyApp.xcodeproj');

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');
    });
  });

  // =============================================================================
  // getBuiltAppPath
  // =============================================================================

  describe('getBuiltAppPath', () => {
    it('finds app bundle in derived data', async () => {
      // fs.existsSync is called twice: once for productsDir, once for configPath
      vi.mocked(fs.existsSync).mockReturnValue(true);
      // fs.readdirSync is called once for the config folder contents
      vi.mocked(fs.readdirSync).mockReturnValueOnce([
        'MyApp.app',
        'MyApp.dSYM',
      ] as unknown as fs.Dirent[]);

      const result = await getBuiltAppPath('/derived/data/MyApp-hash', 'MyApp', 'Debug');

      expect(result.success).toBe(true);
      expect(result.data).toContain('MyApp.app');
    });

    it('prefers app matching scheme name', async () => {
      // Both existsSync calls return true (productsDir and configPath exist)
      vi.mocked(fs.existsSync).mockReturnValue(true);
      // Only one readdirSync call for the configPath contents
      vi.mocked(fs.readdirSync).mockReturnValueOnce([
        'Other.app',
        'MyApp.app',
      ] as unknown as fs.Dirent[]);

      const result = await getBuiltAppPath('/derived/data/MyApp-hash', 'MyApp');

      expect(result.success).toBe(true);
      expect(result.data).toContain('MyApp.app');
    });

    it('returns error when products directory not found', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await getBuiltAppPath('/derived/data/MyApp-hash', 'MyApp');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('returns error when no app bundle found', async () => {
      // Both existsSync calls return true
      vi.mocked(fs.existsSync).mockReturnValue(true);
      // Only one readdirSync call for the configPath contents
      vi.mocked(fs.readdirSync).mockReturnValueOnce([
        'MyApp.dSYM',
        'Info.plist',
      ] as unknown as fs.Dirent[]);

      const result = await getBuiltAppPath('/derived/data/MyApp-hash', 'MyApp');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No .app bundle found');
    });
  });

  // =============================================================================
  // getBuildSettings
  // =============================================================================

  describe('getBuildSettings', () => {
    it('returns build settings for scheme', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            action: 'build',
            target: 'MyApp',
            buildSettings: {
              PRODUCT_NAME: 'MyApp',
              PRODUCT_BUNDLE_IDENTIFIER: 'com.example.myapp',
              INFOPLIST_FILE: 'MyApp/Info.plist',
            },
          },
        ]),
        stderr: '',
        exitCode: 0,
      });

      const result = await getBuildSettings('/path/to/MyApp.xcodeproj', 'MyApp');

      expect(result.success).toBe(true);
      expect(result.data!.PRODUCT_NAME).toBe('MyApp');
      expect(result.data!.PRODUCT_BUNDLE_IDENTIFIER).toBe('com.example.myapp');
      expect(mockExecFileNoThrow).toHaveBeenCalledWith(
        'xcodebuild',
        ['-project', '/path/to/MyApp.xcodeproj', '-scheme', 'MyApp', '-showBuildSettings', '-json'],
        undefined
      );
    });

    it('works with workspace', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            action: 'build',
            target: 'MyApp',
            buildSettings: {
              PRODUCT_NAME: 'MyApp',
            },
          },
        ]),
        stderr: '',
        exitCode: 0,
      });

      await getBuildSettings('/path/to/MyApp.xcworkspace', 'MyApp');

      expect(mockExecFileNoThrow).toHaveBeenCalledWith(
        'xcodebuild',
        ['-workspace', '/path/to/MyApp.xcworkspace', '-scheme', 'MyApp', '-showBuildSettings', '-json'],
        undefined
      );
    });

    it('combines settings from multiple targets', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            action: 'build',
            target: 'MyApp',
            buildSettings: {
              PRODUCT_NAME: 'MyApp',
              TARGET_NAME: 'MyApp',
            },
          },
          {
            action: 'build',
            target: 'MyAppFramework',
            buildSettings: {
              FRAMEWORK_NAME: 'MyAppFramework',
            },
          },
        ]),
        stderr: '',
        exitCode: 0,
      });

      const result = await getBuildSettings('/path/to/MyApp.xcodeproj', 'MyApp');

      expect(result.success).toBe(true);
      expect(result.data!.PRODUCT_NAME).toBe('MyApp');
      expect(result.data!.FRAMEWORK_NAME).toBe('MyAppFramework');
    });

    it('returns error when xcodebuild fails', async () => {
      mockExecFileNoThrow.mockResolvedValueOnce({
        stdout: '',
        stderr: 'Scheme not found',
        exitCode: 1,
      });

      const result = await getBuildSettings('/path/to/MyApp.xcodeproj', 'InvalidScheme');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('COMMAND_FAILED');
    });
  });
});
