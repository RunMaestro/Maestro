/**
 * Tests for src/main/ios-tools/utils.ts
 *
 * Tests cover utility functions, especially parseXcodebuildOutput.
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

// Mock execFileNoThrow for any tests that need it
vi.mock('../../../main/utils/execFile', () => ({
  execFileNoThrow: vi.fn(),
}));

import {
  parseXcodebuildOutput,
  parseSimctlJson,
  parseJson,
  parseIOSVersionFromRuntime,
  parseDeviceTypeName,
} from '../../../main/ios-tools/utils';

describe('utils.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =============================================================================
  // parseXcodebuildOutput
  // =============================================================================

  describe('parseXcodebuildOutput', () => {
    describe('build status parsing', () => {
      it('parses BUILD SUCCEEDED correctly', () => {
        const output = `
CompileC /path/to/file.m
** BUILD SUCCEEDED **
`;
        const result = parseXcodebuildOutput(output);

        expect(result.success).toBe(true);
        expect(result.resultLine).toBe('** BUILD SUCCEEDED **');
      });

      it('parses BUILD FAILED correctly', () => {
        const output = `
CompileC /path/to/file.m
** BUILD FAILED **
`;
        const result = parseXcodebuildOutput(output);

        expect(result.success).toBe(false);
        expect(result.resultLine).toBe('** BUILD FAILED **');
      });

      it('parses TEST SUCCEEDED correctly', () => {
        const output = `
Testing started
** TEST SUCCEEDED **
`;
        const result = parseXcodebuildOutput(output);

        expect(result.success).toBe(true);
        expect(result.action).toBe('test');
        expect(result.resultLine).toBe('** TEST SUCCEEDED **');
      });

      it('parses TEST FAILED correctly', () => {
        const output = `
Testing started
** TEST FAILED **
`;
        const result = parseXcodebuildOutput(output);

        expect(result.success).toBe(false);
        expect(result.action).toBe('test');
        expect(result.resultLine).toBe('** TEST FAILED **');
      });

      it('parses CLEAN SUCCEEDED correctly', () => {
        const output = `
Cleaning build folder
** CLEAN SUCCEEDED **
`;
        const result = parseXcodebuildOutput(output);

        expect(result.success).toBe(true);
        expect(result.action).toBe('clean');
      });
    });

    describe('warning parsing', () => {
      it('parses warning with file, line, and column', () => {
        const output = `/path/to/ViewController.swift:42:15: warning: unused variable 'x' [-Wunused-variable]`;
        const result = parseXcodebuildOutput(output);

        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toEqual({
          type: 'warning',
          file: '/path/to/ViewController.swift',
          line: 42,
          column: 15,
          message: "unused variable 'x'",
          category: '-Wunused-variable',
        });
        expect(result.warningCount).toBe(1);
      });

      it('parses warning with file and line only (no column)', () => {
        const output = `/path/to/file.m:100: warning: deprecated function call`;
        const result = parseXcodebuildOutput(output);

        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toEqual({
          type: 'warning',
          file: '/path/to/file.m',
          line: 100,
          message: 'deprecated function call',
          category: undefined,
        });
      });

      it('parses simple warning format', () => {
        const output = `warning: The iOS deployment target is set to 11.0`;
        const result = parseXcodebuildOutput(output);

        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0].message).toBe('The iOS deployment target is set to 11.0');
      });

      it('parses emoji warning format', () => {
        const output = `⚠️ warning: Some deprecation notice`;
        const result = parseXcodebuildOutput(output);

        expect(result.warnings).toHaveLength(1);
        expect(result.warningCount).toBe(1);
      });

      it('counts multiple warnings correctly', () => {
        const output = `
/file1.swift:10:5: warning: first warning
/file2.swift:20:3: warning: second warning
/file3.swift:30:7: warning: third warning
`;
        const result = parseXcodebuildOutput(output);

        expect(result.warnings).toHaveLength(3);
        expect(result.warningCount).toBe(3);
      });
    });

    describe('error parsing', () => {
      it('parses error with file, line, and column', () => {
        const output = `/path/to/AppDelegate.swift:25:10: error: cannot find 'undefined' in scope`;
        const result = parseXcodebuildOutput(output);

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toEqual({
          type: 'error',
          file: '/path/to/AppDelegate.swift',
          line: 25,
          column: 10,
          message: "cannot find 'undefined' in scope",
        });
        expect(result.errorCount).toBe(1);
        expect(result.success).toBe(false);
      });

      it('parses error with file and line only', () => {
        const output = `/path/to/file.m:50: error: expected ';' after expression`;
        const result = parseXcodebuildOutput(output);

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].line).toBe(50);
        expect(result.errors[0].column).toBeUndefined();
      });

      it('parses simple error format', () => {
        const output = `error: Build input file cannot be found`;
        const result = parseXcodebuildOutput(output);

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toBe('Build input file cannot be found');
        expect(result.success).toBe(false);
      });

      it('parses emoji error format', () => {
        const output = `❌ error: Compilation failed`;
        const result = parseXcodebuildOutput(output);

        expect(result.errors).toHaveLength(1);
        expect(result.errorCount).toBe(1);
        expect(result.success).toBe(false);
      });

      it('sets success to false when errors are present', () => {
        const output = `
CompileSwift normal arm64 /path/to/file.swift
/path/to/file.swift:10:5: error: some error
`;
        const result = parseXcodebuildOutput(output);

        expect(result.success).toBe(false);
      });
    });

    describe('note parsing', () => {
      it('parses note with file, line, and column', () => {
        const output = `/path/to/file.swift:15:8: note: found this candidate`;
        const result = parseXcodebuildOutput(output);

        expect(result.notes).toHaveLength(1);
        expect(result.notes[0]).toEqual({
          type: 'note',
          file: '/path/to/file.swift',
          line: 15,
          column: 8,
          message: 'found this candidate',
        });
      });
    });

    describe('build phase parsing', () => {
      it('parses CompileC phase', () => {
        const output = `CompileC /path/to/output.o /path/to/source.c normal arm64`;
        const result = parseXcodebuildOutput(output);

        expect(result.phases).toHaveLength(1);
        expect(result.phases[0].name).toBe('CompileC');
        expect(result.phases[0].file).toBe('/path/to/output.o /path/to/source.c normal arm64');
      });

      it('parses CompileSwift phase', () => {
        const output = `CompileSwift normal arm64 /path/to/File.swift`;
        const result = parseXcodebuildOutput(output);

        expect(result.phases).toHaveLength(1);
        expect(result.phases[0].name).toBe('CompileSwift');
        expect(result.compilations).toHaveLength(1);
        expect(result.compilations[0].sourceFile).toBe('normal arm64 /path/to/File.swift');
      });

      it('parses Ld (linker) phase', () => {
        const output = `Ld /path/to/MyApp.app/MyApp normal arm64`;
        const result = parseXcodebuildOutput(output);

        expect(result.phases).toHaveLength(1);
        expect(result.phases[0].name).toBe('Ld');
        expect(result.linkSteps).toHaveLength(1);
        expect(result.linkSteps[0].outputFile).toBe('/path/to/MyApp.app/MyApp normal arm64');
      });

      it('parses CodeSign phase', () => {
        const output = `CodeSign /path/to/MyApp.app`;
        const result = parseXcodebuildOutput(output);

        expect(result.phases).toHaveLength(1);
        expect(result.phases[0].name).toBe('CodeSign');
      });

      it('parses CpResource phase', () => {
        const output = `CpResource /path/to/resource.png /path/to/destination/resource.png`;
        const result = parseXcodebuildOutput(output);

        expect(result.phases).toHaveLength(1);
        expect(result.phases[0].name).toBe('CpResource');
      });

      it('extracts target from phase line', () => {
        const output = `CompileSwift normal arm64 /path/to/File.swift (in target 'MyApp' from project 'MyProject')`;
        const result = parseXcodebuildOutput(output);

        expect(result.phases).toHaveLength(1);
        expect(result.phases[0].target).toBe('MyApp');
        expect(result.targets).toContain('MyApp');
      });

      it('parses multiple phases in order', () => {
        const output = `
CompileSwift normal arm64 /File1.swift
CompileSwift normal arm64 /File2.swift
Ld /MyApp.app/MyApp normal arm64
CodeSign /MyApp.app
`;
        const result = parseXcodebuildOutput(output);

        expect(result.phases).toHaveLength(4);
        expect(result.phases.map(p => p.name)).toEqual([
          'CompileSwift',
          'CompileSwift',
          'Ld',
          'CodeSign',
        ]);
      });
    });

    describe('target parsing', () => {
      it('parses BUILD TARGET lines', () => {
        const output = `=== BUILD TARGET MyApp OF PROJECT MyProject WITH CONFIGURATION Debug ===`;
        const result = parseXcodebuildOutput(output);

        expect(result.targets).toContain('MyApp');
      });

      it('extracts multiple targets', () => {
        const output = `
=== BUILD TARGET MyApp OF PROJECT MyProject ===
CompileSwift normal arm64 (in target 'MyAppCore' from project 'MyProject')
=== BUILD TARGET MyAppTests OF PROJECT MyProject ===
`;
        const result = parseXcodebuildOutput(output);

        expect(result.targets).toContain('MyApp');
        expect(result.targets).toContain('MyAppCore');
        expect(result.targets).toContain('MyAppTests');
        // Should deduplicate
        expect(new Set(result.targets).size).toBe(result.targets.length);
      });

      it('detects build action from BUILD TARGET lines', () => {
        const output = `=== BUILD TARGET MyApp ===`;
        const result = parseXcodebuildOutput(output);

        expect(result.action).toBe('build');
      });

      it('detects clean action', () => {
        const output = `=== CLEAN TARGET MyApp ===`;
        const result = parseXcodebuildOutput(output);

        expect(result.action).toBe('clean');
      });
    });

    describe('compilation tracking', () => {
      it('tracks compilation steps', () => {
        const output = `
CompileSwift normal arm64 /File1.swift
CompileC /out.o /File2.m normal arm64
`;
        const result = parseXcodebuildOutput(output);

        expect(result.compilations).toHaveLength(2);
        expect(result.compilations[0].success).toBe(true);
        expect(result.compilations[1].success).toBe(true);
      });

      it('marks compilation as failed when error present in file', () => {
        const output = `
CompileSwift normal arm64 /path/to/Broken.swift
/path/to/Broken.swift:10:5: error: some error here
** BUILD FAILED **
`;
        const result = parseXcodebuildOutput(output);

        expect(result.compilations).toHaveLength(1);
        expect(result.compilations[0].success).toBe(false);
      });
    });

    describe('complex output parsing', () => {
      it('parses a realistic xcodebuild output', () => {
        const output = `
=== BUILD TARGET MyApp OF PROJECT MyProject WITH CONFIGURATION Debug ===
CompileSwift normal arm64 /Users/dev/MyApp/AppDelegate.swift (in target 'MyApp' from project 'MyProject')
/Users/dev/MyApp/ViewController.swift:42:15: warning: unused variable 'x' [-Wunused-variable]
CompileSwift normal arm64 /Users/dev/MyApp/ViewController.swift (in target 'MyApp' from project 'MyProject')
Ld /Users/dev/DerivedData/Build/Products/Debug-iphonesimulator/MyApp.app/MyApp normal arm64 (in target 'MyApp' from project 'MyProject')
CodeSign /Users/dev/DerivedData/Build/Products/Debug-iphonesimulator/MyApp.app
** BUILD SUCCEEDED **
`;
        const result = parseXcodebuildOutput(output);

        expect(result.success).toBe(true);
        expect(result.warnings).toHaveLength(1);
        expect(result.errors).toHaveLength(0);
        expect(result.phases.length).toBeGreaterThan(0);
        expect(result.compilations.length).toBeGreaterThan(0);
        expect(result.linkSteps).toHaveLength(1);
        expect(result.targets).toContain('MyApp');
        expect(result.warningCount).toBe(1);
        expect(result.errorCount).toBe(0);
      });

      it('parses a failed build output', () => {
        const output = `
=== BUILD TARGET MyApp ===
CompileSwift normal arm64 /path/to/BadFile.swift
/path/to/BadFile.swift:15:20: error: cannot find 'undefined' in scope
/path/to/BadFile.swift:15:20: note: did you mean 'defined'?
/path/to/BadFile.swift:30:5: warning: result of call is unused
** BUILD FAILED **
`;
        const result = parseXcodebuildOutput(output);

        expect(result.success).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.notes).toHaveLength(1);
        expect(result.warnings).toHaveLength(1);
        expect(result.errorCount).toBe(1);
        expect(result.warningCount).toBe(1);
        expect(result.resultLine).toBe('** BUILD FAILED **');
      });

      it('handles empty output', () => {
        const result = parseXcodebuildOutput('');

        expect(result.success).toBe(true);
        expect(result.warnings).toHaveLength(0);
        expect(result.errors).toHaveLength(0);
        expect(result.phases).toHaveLength(0);
      });

      it('handles output with only whitespace', () => {
        const result = parseXcodebuildOutput('   \n\n   \n');

        expect(result.success).toBe(true);
        expect(result.warnings).toHaveLength(0);
        expect(result.errors).toHaveLength(0);
      });
    });

    describe('deduplication', () => {
      it('does not duplicate warnings with same message', () => {
        const output = `
warning: The deployment target is set to 11.0
warning: The deployment target is set to 11.0
`;
        const result = parseXcodebuildOutput(output);

        // The first format should be parsed
        expect(result.warningCount).toBeGreaterThanOrEqual(1);
      });

      it('does not duplicate targets', () => {
        const output = `
=== BUILD TARGET MyApp ===
CompileSwift (in target 'MyApp' from project 'MyProject')
=== BUILD TARGET MyApp ===
`;
        const result = parseXcodebuildOutput(output);

        const uniqueTargets = new Set(result.targets);
        expect(result.targets.length).toBe(uniqueTargets.size);
      });
    });
  });

  // =============================================================================
  // parseSimctlJson
  // =============================================================================

  describe('parseSimctlJson', () => {
    it('parses valid simctl JSON output', () => {
      const json = JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
            {
              udid: '12345',
              name: 'iPhone 15',
              state: 'Booted',
              isAvailable: true,
            },
          ],
        },
      });

      const result = parseSimctlJson(json);

      expect(result.success).toBe(true);
      expect(result.data?.devices).toBeDefined();
    });

    it('handles JSON with leading non-JSON content', () => {
      const output = `Some warning text\n${JSON.stringify({
        devices: { 'runtime': [] },
      })}`;

      const result = parseSimctlJson(output);

      expect(result.success).toBe(true);
    });

    it('returns error for invalid JSON', () => {
      const result = parseSimctlJson('not json at all');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('PARSE_ERROR');
    });

    it('returns error for JSON without devices object', () => {
      const result = parseSimctlJson(JSON.stringify({ other: 'data' }));

      expect(result.success).toBe(false);
      expect(result.error).toContain('missing devices object');
    });
  });

  // =============================================================================
  // parseJson
  // =============================================================================

  describe('parseJson', () => {
    it('parses valid JSON object', () => {
      const result = parseJson<{ key: string }>('{"key": "value"}');

      expect(result.success).toBe(true);
      expect(result.data?.key).toBe('value');
    });

    it('parses valid JSON array', () => {
      const result = parseJson<string[]>('["a", "b", "c"]');

      expect(result.success).toBe(true);
      expect(result.data).toEqual(['a', 'b', 'c']);
    });

    it('handles leading non-JSON content for objects', () => {
      const result = parseJson<{ x: number }>('prefix text {"x": 42}');

      expect(result.success).toBe(true);
      expect(result.data?.x).toBe(42);
    });

    it('handles leading non-JSON content for arrays', () => {
      const result = parseJson<number[]>('prefix [1, 2, 3]');

      expect(result.success).toBe(true);
      expect(result.data).toEqual([1, 2, 3]);
    });

    it('returns error for invalid JSON', () => {
      const result = parseJson('not valid json');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('PARSE_ERROR');
    });
  });

  // =============================================================================
  // parseIOSVersionFromRuntime
  // =============================================================================

  describe('parseIOSVersionFromRuntime', () => {
    it('parses iOS-17-5 format', () => {
      const version = parseIOSVersionFromRuntime('com.apple.CoreSimulator.SimRuntime.iOS-17-5');
      expect(version).toBe('17.5');
    });

    it('parses iOS-16-4 format', () => {
      const version = parseIOSVersionFromRuntime('com.apple.CoreSimulator.SimRuntime.iOS-16-4');
      expect(version).toBe('16.4');
    });

    it('parses iOS-15-0 format', () => {
      const version = parseIOSVersionFromRuntime('com.apple.CoreSimulator.SimRuntime.iOS-15-0');
      expect(version).toBe('15.0');
    });

    it('returns unknown for unrecognized format', () => {
      const version = parseIOSVersionFromRuntime('some-other-format');
      expect(version).toBe('unknown');
    });
  });

  // =============================================================================
  // parseDeviceTypeName
  // =============================================================================

  describe('parseDeviceTypeName', () => {
    it('parses iPhone-15-Pro format', () => {
      const name = parseDeviceTypeName('com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro');
      expect(name).toBe('iPhone 15 Pro');
    });

    it('parses iPhone-15-Pro-Max format', () => {
      const name = parseDeviceTypeName('com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro-Max');
      expect(name).toBe('iPhone 15 Pro Max');
    });

    it('parses iPad-Pro-12-9-inch format', () => {
      const name = parseDeviceTypeName('com.apple.CoreSimulator.SimDeviceType.iPad-Pro-12-9-inch');
      expect(name).toBe('iPad Pro 12 9 inch');
    });

    it('returns original string for unrecognized format', () => {
      const name = parseDeviceTypeName('some-other-format');
      expect(name).toBe('some-other-format');
    });
  });
});
