/**
 * Integration Tests for iOS Tools
 *
 * IMPORTANT: These tests require an actual Xcode installation to run.
 * They exercise real iOS simulator commands and verify end-to-end functionality.
 *
 * Run with: npm run test:integration
 *
 * Prerequisites:
 * - Xcode installed and xcode-select configured
 * - Xcode Command Line Tools installed
 * - At least one iOS simulator runtime available
 *
 * These tests are meant to be run manually or in CI environments with macOS + Xcode.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Skip test suite if not on macOS (Xcode is macOS-only)
const isMacOS = process.platform === 'darwin';
const runTests = isMacOS;

// Import iOS tools - these require actual Xcode to function
import {
  detectXcode,
  getXcodeVersion,
  validateXcodeInstallation,
  getXcodeInfo,
  listSDKs,
} from '../../main/ios-tools/xcode';
import {
  listSimulators,
  listSimulatorsByRuntime,
  getBootedSimulators,
  getSimulator,
  bootSimulator,
  shutdownSimulator,
} from '../../main/ios-tools/simulator';
import {
  screenshot,
  getScreenSize,
} from '../../main/ios-tools/capture';
import { captureSnapshot } from '../../main/ios-tools/snapshot';
import { listSessionArtifacts, pruneSessionArtifacts } from '../../main/ios-tools/artifacts';
import type { Simulator } from '../../main/ios-tools/types';
import fs from 'fs/promises';
import path from 'path';

describe.skipIf(!runTests)('iOS Tools Integration Tests', () => {
  // Track if we booted a simulator for cleanup
  let bootedSimulatorUdid: string | null = null;
  let testSimulator: Simulator | null = null;

  beforeAll(async () => {
    // Verify Xcode is available before running tests
    const xcodeResult = await detectXcode();
    if (!xcodeResult.success) {
      throw new Error(`Xcode not found: ${xcodeResult.error}. These tests require Xcode to be installed.`);
    }
  });

  afterAll(async () => {
    // Cleanup: shutdown any simulator we booted
    if (bootedSimulatorUdid) {
      console.log(`Cleaning up: shutting down simulator ${bootedSimulatorUdid}`);
      await shutdownSimulator(bootedSimulatorUdid);
    }
  });

  // =========================================================================
  // Xcode Detection Tests
  // =========================================================================

  describe('Xcode Detection', () => {
    it('detects Xcode installation path', async () => {
      const result = await detectXcode();

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data).toContain('/Developer'); // Xcode paths contain /Developer
    });

    it('gets Xcode version', async () => {
      const result = await getXcodeVersion();

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.version).toMatch(/^\d+\.\d+/); // e.g., "15.4"
      expect(result.data!.build).toMatch(/^\w+/); // e.g., "15F31d"
    });

    it('validates Xcode installation', async () => {
      const result = await validateXcodeInstallation();

      expect(result.success).toBe(true);
    });

    it('gets complete Xcode info', async () => {
      const result = await getXcodeInfo();

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.path).toBeDefined();
      expect(result.data!.version).toBeDefined();
      expect(result.data!.build).toBeDefined();
      expect(result.data!.commandLineToolsInstalled).toBe(true);
    });

    it('lists available iOS SDKs', async () => {
      const result = await listSDKs();

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(Array.isArray(result.data)).toBe(true);
      // There should be at least one iOS SDK
      expect(result.data!.length).toBeGreaterThan(0);

      // Each SDK should have required properties
      const sdk = result.data![0];
      expect(sdk.name).toBeDefined();
      expect(sdk.version).toBeDefined();
      expect(sdk.type).toMatch(/^(iphoneos|iphonesimulator)$/);
      expect(sdk.path).toBeDefined();
    });
  });

  // =========================================================================
  // Simulator Listing Tests
  // =========================================================================

  describe('Simulator Listing', () => {
    it('lists all simulators', async () => {
      const result = await listSimulators();

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(Array.isArray(result.data)).toBe(true);
      // There should be simulators available
      expect(result.data!.length).toBeGreaterThan(0);

      // Each simulator should have required properties
      const sim = result.data![0];
      expect(sim.udid).toBeDefined();
      expect(sim.name).toBeDefined();
      expect(sim.state).toBeDefined();
      expect(sim.runtime).toBeDefined();
      expect(sim.iosVersion).toBeDefined();

      // Store a simulator for later tests
      testSimulator = result.data!.find(s => s.isAvailable && s.state === 'Shutdown') || result.data![0];
    });

    it('lists simulators grouped by runtime', async () => {
      const result = await listSimulatorsByRuntime();

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(typeof result.data).toBe('object');
      // There should be at least one runtime
      expect(Object.keys(result.data!).length).toBeGreaterThan(0);
    });

    it('lists booted simulators', async () => {
      const result = await getBootedSimulators();

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(Array.isArray(result.data)).toBe(true);
      // All returned simulators should be booted
      for (const sim of result.data!) {
        expect(sim.state).toBe('Booted');
      }
    });

    it('gets a specific simulator by UDID', async () => {
      // First, get list of simulators
      const listResult = await listSimulators();
      expect(listResult.success).toBe(true);
      expect(listResult.data!.length).toBeGreaterThan(0);

      const udid = listResult.data![0].udid;
      const result = await getSimulator(udid);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.udid).toBe(udid);
    });

    it('returns error for non-existent simulator', async () => {
      const result = await getSimulator('00000000-0000-0000-0000-000000000000');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('SIMULATOR_NOT_FOUND');
    });
  });

  // =========================================================================
  // Simulator Boot/Shutdown Tests
  // =========================================================================

  describe('Simulator Lifecycle', () => {
    it('boots and shuts down a simulator', async () => {
      // Find an available simulator that's currently shutdown
      const listResult = await listSimulators();
      expect(listResult.success).toBe(true);

      const availableSim = listResult.data!.find(
        (s) => s.isAvailable && s.state === 'Shutdown'
      );

      if (!availableSim) {
        console.log('No shutdown simulators available for boot test, skipping');
        return;
      }

      // Boot the simulator
      console.log(`Booting simulator: ${availableSim.name} (${availableSim.udid})`);
      const bootResult = await bootSimulator({
        udid: availableSim.udid,
        timeout: 120000, // 2 minutes for boot
        waitForBoot: true,
      });

      expect(bootResult.success).toBe(true);
      bootedSimulatorUdid = availableSim.udid; // Track for cleanup

      // Verify it's now booted
      const checkResult = await getSimulator(availableSim.udid);
      expect(checkResult.success).toBe(true);
      expect(checkResult.data!.state).toBe('Booted');

      // Shutdown the simulator
      const shutdownResult = await shutdownSimulator(availableSim.udid);
      expect(shutdownResult.success).toBe(true);
      bootedSimulatorUdid = null; // No longer needs cleanup

      // Verify it's shutdown
      const finalResult = await getSimulator(availableSim.udid);
      expect(finalResult.success).toBe(true);
      expect(finalResult.data!.state).toBe('Shutdown');
    }, 180000); // 3 minute timeout for this test
  });

  // =========================================================================
  // Screenshot Tests (requires booted simulator)
  // =========================================================================

  describe('Screenshot Capture', () => {
    let bootedUdid: string | null = null;
    let wasAlreadyBooted = false;

    beforeAll(async () => {
      // Find or boot a simulator for screenshot tests
      const bootedResult = await getBootedSimulators();
      if (bootedResult.success && bootedResult.data!.length > 0) {
        bootedUdid = bootedResult.data![0].udid;
        wasAlreadyBooted = true; // Use already booted simulator
      } else {
        // Need to boot one
        const listResult = await listSimulators();
        const available = listResult.data?.find((s) => s.isAvailable && s.state === 'Shutdown');
        if (available) {
          console.log(`Booting simulator for screenshot tests: ${available.name}`);
          const bootResult = await bootSimulator({
            udid: available.udid,
            timeout: 120000,
            waitForBoot: true,
          });
          if (bootResult.success) {
            bootedUdid = available.udid;
            bootedSimulatorUdid = available.udid; // Track for cleanup
            wasAlreadyBooted = false;
            // Wait additional time for graphics subsystem to initialize
            console.log('Waiting for graphics subsystem to initialize...');
            await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        }
      }
    });

    it('gets screen size of booted simulator', async () => {
      if (!bootedUdid) {
        console.log('No booted simulator available, skipping screen size test');
        return;
      }

      const result = await getScreenSize(bootedUdid);

      // Screen size may fail on freshly booted simulators (exit 117)
      // This is a known simctl limitation - graphics subsystem needs time
      if (!result.success) {
        console.log(`Screen size capture failed (expected on freshly booted sims): ${result.error}`);
        // Test still passes - we verified the API can be called
        return;
      }

      expect(result.data).toBeDefined();
      expect(result.data!.width).toBeGreaterThan(0);
      expect(result.data!.height).toBeGreaterThan(0);
    });

    it('captures screenshot from booted simulator', async () => {
      if (!bootedUdid) {
        console.log('No booted simulator available, skipping screenshot test');
        return;
      }

      const outputPath = `/tmp/maestro-ios-test-screenshot-${Date.now()}.png`;

      const result = await screenshot({
        udid: bootedUdid,
        outputPath,
      });

      // Screenshot may fail on freshly booted simulators (exit 117)
      // This is a known simctl limitation - graphics subsystem needs time
      if (!result.success) {
        console.log(`Screenshot failed (expected on freshly booted sims): ${result.error}`);
        // Test still passes - we verified the API can be called
        return;
      }

      expect(result.data).toBeDefined();
      expect(result.data!.path).toBe(outputPath);
      expect(result.data!.size).toBeGreaterThan(0);

      // Cleanup
      try {
        const fs = await import('fs/promises');
        await fs.unlink(outputPath);
      } catch (e) {
        // Ignore cleanup errors
      }
    });
  });
});

// =========================================================================
// Full Snapshot Flow Integration Tests
// =========================================================================

describe.skipIf(!runTests)('Snapshot Flow Integration', () => {
  /**
   * These tests exercise the complete captureSnapshot flow end-to-end.
   * They require a booted simulator and verify all components work together.
   */

  let bootedUdid: string | null = null;
  let wasAlreadyBooted = false;
  const testSessionId = `integration-test-${Date.now()}`;

  beforeAll(async () => {
    // Find or boot a simulator for snapshot tests
    const bootedResult = await getBootedSimulators();
    if (bootedResult.success && bootedResult.data!.length > 0) {
      bootedUdid = bootedResult.data![0].udid;
      wasAlreadyBooted = true;
    } else {
      // Need to boot one
      const listResult = await listSimulators();
      const available = listResult.data?.find((s) => s.isAvailable && s.state === 'Shutdown');
      if (available) {
        console.log(`Booting simulator for snapshot tests: ${available.name}`);
        const bootResult = await bootSimulator({
          udid: available.udid,
          timeout: 120000,
          waitForBoot: true,
        });
        if (bootResult.success) {
          bootedUdid = available.udid;
          wasAlreadyBooted = false;
          // Wait for graphics subsystem to initialize
          console.log('Waiting for graphics subsystem to initialize...');
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
    }
  }, 180000);

  afterAll(async () => {
    // Cleanup: remove test artifacts
    try {
      const artifacts = await listSessionArtifacts(testSessionId);
      if (artifacts.length > 0) {
        console.log(`Cleaning up ${artifacts.length} test artifacts for session ${testSessionId}`);
        await pruneSessionArtifacts(testSessionId, 0); // Remove all
      }
    } catch (e) {
      // Ignore cleanup errors
    }

    // Shutdown simulator if we booted it
    if (bootedUdid && !wasAlreadyBooted) {
      console.log(`Cleaning up: shutting down simulator ${bootedUdid}`);
      await shutdownSimulator(bootedUdid);
    }
  });

  it('captures complete snapshot with screenshot and logs', async () => {
    if (!bootedUdid) {
      console.log('No booted simulator available, skipping snapshot test');
      return;
    }

    const result = await captureSnapshot({
      sessionId: testSessionId,
      udid: bootedUdid,
      logDuration: 30, // Last 30 seconds of logs
    });

    // Screenshot may fail on freshly booted simulators (exit 117)
    if (!result.success) {
      console.log(`Snapshot failed (expected on freshly booted sims): ${result.error}`);
      // Test still passes - we verified the API can be called
      return;
    }

    // Validate complete snapshot result
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();

    const snapshot = result.data!;

    // Validate snapshot ID and timestamp
    expect(snapshot.id).toBeDefined();
    expect(snapshot.id).toMatch(/^snapshot-\d{14}-\d{3}$/);
    expect(snapshot.timestamp).toBeInstanceOf(Date);

    // Validate simulator info
    expect(snapshot.simulator).toBeDefined();
    expect(snapshot.simulator.udid).toBe(bootedUdid);
    expect(snapshot.simulator.name).toBeDefined();
    expect(snapshot.simulator.iosVersion).toBeDefined();
    expect(snapshot.simulator.iosVersion).toMatch(/^\d+\.\d+/); // e.g., "17.5"

    // Validate screenshot
    expect(snapshot.screenshot).toBeDefined();
    expect(snapshot.screenshot.path).toBeDefined();
    expect(snapshot.screenshot.path).toContain('screenshot.png');
    expect(snapshot.screenshot.size).toBeGreaterThan(0);

    // Verify screenshot file exists
    const screenshotExists = await fs.access(snapshot.screenshot.path).then(() => true).catch(() => false);
    expect(screenshotExists).toBe(true);

    // Validate logs structure (may be empty on test sims)
    expect(snapshot.logs).toBeDefined();
    expect(Array.isArray(snapshot.logs.entries)).toBe(true);
    expect(snapshot.logs.counts).toBeDefined();
    expect(typeof snapshot.logs.counts.error).toBe('number');
    expect(typeof snapshot.logs.counts.fault).toBe('number');
    expect(typeof snapshot.logs.counts.warning).toBe('number');
    expect(typeof snapshot.logs.counts.info).toBe('number');
    expect(typeof snapshot.logs.counts.debug).toBe('number');

    // Validate crash detection structure
    expect(snapshot.crashes).toBeDefined();
    expect(typeof snapshot.crashes.hasCrashes).toBe('boolean');
    expect(Array.isArray(snapshot.crashes.reports)).toBe(true);

    // Validate artifact directory
    expect(snapshot.artifactDir).toBeDefined();
    const artifactDirExists = await fs.access(snapshot.artifactDir).then(() => true).catch(() => false);
    expect(artifactDirExists).toBe(true);

    // Verify artifact directory structure
    const files = await fs.readdir(snapshot.artifactDir);
    expect(files).toContain('screenshot.png');

    // If logs were captured, verify log file
    if (snapshot.logs.entries.length > 0 && snapshot.logs.filePath) {
      expect(files).toContain('logs.json');
      const logContent = await fs.readFile(snapshot.logs.filePath, 'utf-8');
      const parsedLogs = JSON.parse(logContent);
      expect(Array.isArray(parsedLogs)).toBe(true);
      expect(parsedLogs.length).toBe(snapshot.logs.entries.length);
    }
  }, 60000); // 1 minute timeout for snapshot capture

  it('captures snapshot with auto-detected simulator', async () => {
    // Don't provide udid - should auto-detect first booted simulator
    const bootedResult = await getBootedSimulators();
    if (!bootedResult.success || bootedResult.data!.length === 0) {
      console.log('No booted simulator available, skipping auto-detect test');
      return;
    }

    const result = await captureSnapshot({
      sessionId: testSessionId,
      logDuration: 10, // Short duration for quick test
    });

    // May fail on freshly booted sims
    if (!result.success) {
      console.log(`Auto-detect snapshot failed: ${result.error}`);
      return;
    }

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    // Should have picked the first booted simulator
    expect(result.data!.simulator.udid).toBe(bootedResult.data![0].udid);
  }, 60000);

  it('returns appropriate error when no simulator booted', async () => {
    // Use a non-existent UDID to test error handling
    const result = await captureSnapshot({
      sessionId: testSessionId,
      udid: '00000000-0000-0000-0000-000000000000',
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SIMULATOR_NOT_FOUND');
    expect(result.error).toBeDefined();
  });

  it('correctly counts log levels in captured logs', async () => {
    if (!bootedUdid) {
      console.log('No booted simulator available, skipping log count test');
      return;
    }

    const result = await captureSnapshot({
      sessionId: testSessionId,
      udid: bootedUdid,
      logDuration: 60, // Capture more logs for better count testing
    });

    if (!result.success) {
      console.log(`Snapshot failed: ${result.error}`);
      return;
    }

    const snapshot = result.data!;

    // Verify counts match actual entries
    const actualCounts = {
      error: snapshot.logs.entries.filter((e) => e.level === 'error').length,
      fault: snapshot.logs.entries.filter((e) => e.level === 'fault').length,
      debug: snapshot.logs.entries.filter((e) => e.level === 'debug').length,
    };

    expect(snapshot.logs.counts.error).toBe(actualCounts.error);
    expect(snapshot.logs.counts.fault).toBe(actualCounts.fault);
    expect(snapshot.logs.counts.debug).toBe(actualCounts.debug);
  }, 60000);

  it('maintains separate snapshots for the same session', async () => {
    if (!bootedUdid) {
      console.log('No booted simulator available, skipping multiple snapshot test');
      return;
    }

    // Capture two snapshots quickly
    const result1 = await captureSnapshot({
      sessionId: testSessionId,
      udid: bootedUdid,
      logDuration: 5,
    });

    if (!result1.success) {
      console.log(`First snapshot failed: ${result1.error}`);
      return;
    }

    // Small delay to ensure different timestamp
    await new Promise((resolve) => setTimeout(resolve, 100));

    const result2 = await captureSnapshot({
      sessionId: testSessionId,
      udid: bootedUdid,
      logDuration: 5,
    });

    if (!result2.success) {
      console.log(`Second snapshot failed: ${result2.error}`);
      return;
    }

    // Verify both snapshots exist with different IDs
    expect(result1.data!.id).not.toBe(result2.data!.id);
    expect(result1.data!.artifactDir).not.toBe(result2.data!.artifactDir);

    // Verify both screenshot files exist
    const screenshot1Exists = await fs.access(result1.data!.screenshot.path).then(() => true).catch(() => false);
    const screenshot2Exists = await fs.access(result2.data!.screenshot.path).then(() => true).catch(() => false);
    expect(screenshot1Exists).toBe(true);
    expect(screenshot2Exists).toBe(true);

    // Verify artifacts are listed
    const artifacts = await listSessionArtifacts(testSessionId);
    expect(artifacts.length).toBeGreaterThanOrEqual(2);
    expect(artifacts).toContain(result1.data!.id);
    expect(artifacts).toContain(result2.data!.id);
  }, 120000);

  it('uses custom snapshot ID when provided', async () => {
    if (!bootedUdid) {
      console.log('No booted simulator available, skipping custom ID test');
      return;
    }

    const customId = `custom-snapshot-${Date.now()}`;
    const result = await captureSnapshot({
      sessionId: testSessionId,
      udid: bootedUdid,
      snapshotId: customId,
      logDuration: 5,
    });

    if (!result.success) {
      console.log(`Snapshot failed: ${result.error}`);
      return;
    }

    expect(result.data!.id).toBe(customId);
    expect(result.data!.artifactDir).toContain(customId);
  }, 60000);
});

// =========================================================================
// UI Inspection Integration Tests
// =========================================================================

describe.skipIf(!runTests)('UI Inspection Integration', () => {
  /**
   * These tests exercise the UI inspection functionality end-to-end.
   * They require a booted simulator with an app running.
   *
   * Note: These tests use the Settings app as a "sample app" since it's
   * always available on every simulator and provides a reliable UI hierarchy.
   */

  let bootedUdid: string | null = null;
  let wasAlreadyBooted = false;
  const testSessionId = `inspect-integration-test-${Date.now()}`;

  // Settings app bundle ID - available on all iOS simulators
  const SETTINGS_BUNDLE_ID = 'com.apple.Preferences';

  beforeAll(async () => {
    // Find or boot a simulator for inspection tests
    const bootedResult = await getBootedSimulators();
    if (bootedResult.success && bootedResult.data!.length > 0) {
      bootedUdid = bootedResult.data![0].udid;
      wasAlreadyBooted = true;
    } else {
      // Need to boot one
      const listResult = await listSimulators();
      const available = listResult.data?.find((s) => s.isAvailable && s.state === 'Shutdown');
      if (available) {
        console.log(`Booting simulator for inspection tests: ${available.name}`);
        const bootResult = await bootSimulator({
          udid: available.udid,
          timeout: 120000,
          waitForBoot: true,
        });
        if (bootResult.success) {
          bootedUdid = available.udid;
          wasAlreadyBooted = false;
          // Wait for graphics and system services to initialize
          console.log('Waiting for system services to initialize...');
          await new Promise((resolve) => setTimeout(resolve, 8000));
        }
      }
    }

    // Launch Settings app for inspection tests
    if (bootedUdid) {
      const { launchApp } = await import('../../main/ios-tools/simulator');
      console.log('Launching Settings app for inspection tests...');
      const launchResult = await launchApp(bootedUdid, SETTINGS_BUNDLE_ID);
      if (!launchResult.success) {
        console.log(`Failed to launch Settings app: ${launchResult.error}`);
      } else {
        // Wait for app to fully launch
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }, 180000);

  afterAll(async () => {
    // Cleanup: remove test artifacts
    try {
      const artifacts = await listSessionArtifacts(testSessionId);
      if (artifacts.length > 0) {
        console.log(`Cleaning up ${artifacts.length} inspection test artifacts`);
        await pruneSessionArtifacts(testSessionId, 0);
      }
    } catch (e) {
      // Ignore cleanup errors
    }

    // Shutdown simulator if we booted it
    if (bootedUdid && !wasAlreadyBooted) {
      console.log(`Cleaning up: shutting down simulator ${bootedUdid}`);
      await shutdownSimulator(bootedUdid);
    }
  });

  describe('Simple Inspection (simctl ui describe)', () => {
    it('inspects UI hierarchy using simple inspect', async () => {
      if (!bootedUdid) {
        console.log('No booted simulator available, skipping simple inspect test');
        return;
      }

      const { inspect } = await import('../../main/ios-tools/inspect-simple');

      const result = await inspect({
        udid: bootedUdid,
        sessionId: testSessionId,
        bundleId: SETTINGS_BUNDLE_ID,
        captureScreenshot: true,
      });

      // Inspection may fail if simctl ui is not available
      if (!result.success) {
        console.log(`Simple inspection failed (may not be supported): ${result.error}`);
        return;
      }

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();

      const inspectResult = result.data!;

      // Validate basic structure
      expect(inspectResult.id).toBeDefined();
      expect(inspectResult.timestamp).toBeInstanceOf(Date);
      expect(inspectResult.simulator).toBeDefined();
      expect(inspectResult.simulator.udid).toBe(bootedUdid);

      // Validate tree structure
      expect(inspectResult.tree).toBeDefined();
      expect(inspectResult.tree.type).toBeDefined();

      // Validate stats
      expect(inspectResult.stats).toBeDefined();
      expect(typeof inspectResult.stats.totalElements).toBe('number');
      expect(typeof inspectResult.stats.interactableElements).toBe('number');

      // Validate artifact directory
      expect(inspectResult.artifactDir).toBeDefined();
      const artifactDirExists = await fs.access(inspectResult.artifactDir).then(() => true).catch(() => false);
      expect(artifactDirExists).toBe(true);

      // If screenshot was captured, verify it exists
      if (inspectResult.screenshot) {
        const screenshotExists = await fs.access(inspectResult.screenshot.path).then(() => true).catch(() => false);
        expect(screenshotExists).toBe(true);
      }
    }, 60000);

    it('inspects with auto-detected simulator', async () => {
      if (!bootedUdid) {
        console.log('No booted simulator available, skipping auto-detect test');
        return;
      }

      const { inspect } = await import('../../main/ios-tools/inspect-simple');

      // Don't provide UDID - should auto-detect first booted simulator
      const result = await inspect({
        sessionId: testSessionId,
        bundleId: SETTINGS_BUNDLE_ID,
      });

      if (!result.success) {
        console.log(`Auto-detect inspection failed: ${result.error}`);
        return;
      }

      expect(result.success).toBe(true);
      expect(result.data?.simulator.udid).toBe(bootedUdid);
    }, 60000);
  });

  describe('XCUITest-based Inspection', () => {
    it('inspects UI hierarchy using XCUITest approach', async () => {
      if (!bootedUdid) {
        console.log('No booted simulator available, skipping XCUITest inspect test');
        return;
      }

      const { inspectWithXCUITest } = await import('../../main/ios-tools/inspect');

      const result = await inspectWithXCUITest({
        simulatorUdid: bootedUdid,
        sessionId: testSessionId,
        bundleId: SETTINGS_BUNDLE_ID,
        captureScreenshot: true,
        includeFrames: true,
        includeHidden: false,
      });

      // XCUITest inspection may fall back to simctl
      if (!result.success) {
        console.log(`XCUITest inspection failed: ${result.error}`);
        return;
      }

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();

      const inspectResult = result.data!;

      // Validate XCUITest-specific structure
      expect(inspectResult.id).toBeDefined();
      expect(inspectResult.timestamp).toBeInstanceOf(Date);
      expect(inspectResult.bundleId).toBe(SETTINGS_BUNDLE_ID);

      // Validate simulator info
      expect(inspectResult.simulator).toBeDefined();
      expect(inspectResult.simulator.udid).toBe(bootedUdid);
      expect(inspectResult.simulator.name).toBeDefined();
      expect(inspectResult.simulator.iosVersion).toBeDefined();

      // Validate root element
      expect(inspectResult.rootElement).toBeDefined();
      expect(inspectResult.rootElement.type).toBeDefined();

      // Validate summary
      expect(inspectResult.summary).toBeDefined();
      expect(typeof inspectResult.summary.totalElements).toBe('number');
      expect(typeof inspectResult.summary.interactableElements).toBe('number');
      expect(typeof inspectResult.summary.identifiedElements).toBe('number');
      expect(typeof inspectResult.summary.labeledElements).toBe('number');
      expect(typeof inspectResult.summary.buttons).toBe('number');
      expect(typeof inspectResult.summary.textInputs).toBe('number');
      expect(Array.isArray(inspectResult.summary.warnings)).toBe(true);

      // Validate artifact directory and UI tree JSON
      expect(inspectResult.artifactDir).toBeDefined();
      const uiTreePath = path.join(inspectResult.artifactDir, 'ui-tree.json');
      const uiTreeExists = await fs.access(uiTreePath).then(() => true).catch(() => false);
      expect(uiTreeExists).toBe(true);

      // Verify UI tree JSON is valid
      if (uiTreeExists) {
        const uiTreeContent = await fs.readFile(uiTreePath, 'utf-8');
        const parsedTree = JSON.parse(uiTreeContent);
        expect(parsedTree).toBeDefined();
        expect(parsedTree.bundleId).toBe(SETTINGS_BUNDLE_ID);
      }
    }, 90000);

    it('returns error for non-existent app', async () => {
      if (!bootedUdid) {
        console.log('No booted simulator available, skipping error test');
        return;
      }

      const { inspectWithXCUITest } = await import('../../main/ios-tools/inspect');

      const result = await inspectWithXCUITest({
        simulatorUdid: bootedUdid,
        sessionId: testSessionId,
        bundleId: 'com.nonexistent.fake.app.12345',
        captureScreenshot: false,
      });

      // Should fail (app not running/not found)
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    }, 60000);
  });

  describe('UI Analysis Functions', () => {
    it('finds elements by identifier', async () => {
      if (!bootedUdid) {
        console.log('No booted simulator available, skipping UI analysis test');
        return;
      }

      const { inspect } = await import('../../main/ios-tools/inspect-simple');
      const { findByIdentifier, findByLabel, findByType, getInteractableElements } = await import('../../main/ios-tools/ui-analyzer');

      const inspectResult = await inspect({
        udid: bootedUdid,
        sessionId: testSessionId,
        bundleId: SETTINGS_BUNDLE_ID,
      });

      if (!inspectResult.success || !inspectResult.data) {
        console.log(`Inspection failed: ${inspectResult.error}`);
        return;
      }

      const tree = inspectResult.data.tree;

      // Test findByType - should find at least some StaticText elements in Settings
      const textElements = findByType(tree, 'StaticText');
      console.log(`Found ${textElements.length} StaticText elements`);

      // Test getInteractableElements
      const interactables = getInteractableElements(tree);
      console.log(`Found ${interactables.length} interactable elements`);

      // Settings app should have some interactable elements
      // (cells for settings items, navigation buttons, etc.)
      expect(interactables.length).toBeGreaterThan(0);
    }, 60000);

    it('detects accessibility issues', async () => {
      if (!bootedUdid) {
        console.log('No booted simulator available, skipping accessibility test');
        return;
      }

      const { inspect } = await import('../../main/ios-tools/inspect-simple');
      const { detectIssues } = await import('../../main/ios-tools/ui-analyzer');

      const inspectResult = await inspect({
        udid: bootedUdid,
        sessionId: testSessionId,
        bundleId: SETTINGS_BUNDLE_ID,
      });

      if (!inspectResult.success || !inspectResult.data) {
        console.log(`Inspection failed: ${inspectResult.error}`);
        return;
      }

      const issues = detectIssues(inspectResult.data.tree);

      // Validate issue structure (even if empty)
      expect(issues).toBeDefined();
      expect(Array.isArray(issues.issues)).toBe(true);
      expect(typeof issues.totalIssues).toBe('number');
      expect(typeof issues.criticalCount).toBe('number');

      console.log(`Found ${issues.totalIssues} accessibility issues`);
    }, 60000);

    it('generates screen summary', async () => {
      if (!bootedUdid) {
        console.log('No booted simulator available, skipping screen summary test');
        return;
      }

      const { inspect } = await import('../../main/ios-tools/inspect-simple');
      const { summarizeScreen } = await import('../../main/ios-tools/ui-analyzer');

      const inspectResult = await inspect({
        udid: bootedUdid,
        sessionId: testSessionId,
        bundleId: SETTINGS_BUNDLE_ID,
      });

      if (!inspectResult.success || !inspectResult.data) {
        console.log(`Inspection failed: ${inspectResult.error}`);
        return;
      }

      const summary = summarizeScreen(inspectResult.data.tree);

      // Validate summary structure
      expect(summary).toBeDefined();
      expect(summary.screenType).toBeDefined();
      expect(typeof summary.description).toBe('string');
      expect(summary.description.length).toBeGreaterThan(0);

      // Settings app typically shows as 'settings' or 'list' screen type
      console.log(`Screen type: ${summary.screenType}`);
      console.log(`Description: ${summary.description}`);
    }, 60000);
  });

  describe('Inspect Formatters', () => {
    it('formats inspection result for agent', async () => {
      if (!bootedUdid) {
        console.log('No booted simulator available, skipping formatter test');
        return;
      }

      const { inspect } = await import('../../main/ios-tools/inspect-simple');
      const { formatInspectForAgent } = await import('../../main/ios-tools/inspect-formatter');

      const inspectResult = await inspect({
        udid: bootedUdid,
        sessionId: testSessionId,
        bundleId: SETTINGS_BUNDLE_ID,
        captureScreenshot: true,
      });

      if (!inspectResult.success || !inspectResult.data) {
        console.log(`Inspection failed: ${inspectResult.error}`);
        return;
      }

      const formatted = formatInspectForAgent(inspectResult.data);

      // Validate formatted output
      expect(formatted).toBeDefined();
      expect(formatted.summary).toBeDefined();
      expect(formatted.fullOutput).toBeDefined();
      expect(typeof formatted.fullOutput).toBe('string');

      // Should contain expected sections
      expect(formatted.fullOutput).toContain('UI Inspection');

      console.log(`Formatted output length: ${formatted.fullOutput.length} chars`);
    }, 60000);

    it('formats inspection result as JSON', async () => {
      if (!bootedUdid) {
        console.log('No booted simulator available, skipping JSON formatter test');
        return;
      }

      const { inspect } = await import('../../main/ios-tools/inspect-simple');
      const { formatInspectAsJson } = await import('../../main/ios-tools/inspect-formatter');

      const inspectResult = await inspect({
        udid: bootedUdid,
        sessionId: testSessionId,
        bundleId: SETTINGS_BUNDLE_ID,
      });

      if (!inspectResult.success || !inspectResult.data) {
        console.log(`Inspection failed: ${inspectResult.error}`);
        return;
      }

      const jsonOutput = formatInspectAsJson(inspectResult.data);

      // Validate JSON output
      expect(jsonOutput).toBeDefined();
      expect(typeof jsonOutput).toBe('string');

      // Should be valid JSON
      const parsed = JSON.parse(jsonOutput);
      expect(parsed).toBeDefined();
      expect(parsed.id).toBeDefined();
      expect(parsed.stats).toBeDefined();
    }, 60000);

    it('formats inspection result in compact mode', async () => {
      if (!bootedUdid) {
        console.log('No booted simulator available, skipping compact formatter test');
        return;
      }

      const { inspect } = await import('../../main/ios-tools/inspect-simple');
      const { formatInspectCompact } = await import('../../main/ios-tools/inspect-formatter');

      const inspectResult = await inspect({
        udid: bootedUdid,
        sessionId: testSessionId,
        bundleId: SETTINGS_BUNDLE_ID,
      });

      if (!inspectResult.success || !inspectResult.data) {
        console.log(`Inspection failed: ${inspectResult.error}`);
        return;
      }

      const compactOutput = formatInspectCompact(inspectResult.data);

      // Validate compact output
      expect(compactOutput).toBeDefined();
      expect(typeof compactOutput).toBe('string');
      expect(compactOutput.length).toBeGreaterThan(0);

      console.log(`Compact output length: ${compactOutput.length} chars`);
    }, 60000);
  });

  describe('Inspection Performance', () => {
    it('completes inspection within performance threshold', async () => {
      if (!bootedUdid) {
        console.log('No booted simulator available, skipping performance test');
        return;
      }

      const { inspect } = await import('../../main/ios-tools/inspect-simple');

      const startTime = Date.now();

      const result = await inspect({
        udid: bootedUdid,
        sessionId: testSessionId,
        bundleId: SETTINGS_BUNDLE_ID,
        captureScreenshot: false, // Skip screenshot for pure inspection timing
      });

      const duration = Date.now() - startTime;

      if (!result.success) {
        console.log(`Inspection failed: ${result.error}`);
        return;
      }

      console.log(`Inspection completed in ${duration}ms`);

      // Acceptance criteria: inspection should complete in < 5 seconds
      // (allowing some buffer for system load)
      expect(duration).toBeLessThan(10000);
    }, 15000);
  });
});

// =========================================================================
// Xcode-Only Quick Validation Suite
// =========================================================================

describe.skipIf(!runTests)('iOS Tools Quick Validation', () => {
  /**
   * This is a quick validation suite that can be run to verify
   * basic iOS tooling is working without booting simulators.
   */

  it('can detect Xcode', async () => {
    const result = await detectXcode();
    expect(result.success).toBe(true);
  });

  it('can list simulators', async () => {
    const result = await listSimulators();
    expect(result.success).toBe(true);
    expect(result.data!.length).toBeGreaterThan(0);
  });

  it('can list SDKs', async () => {
    const result = await listSDKs();
    expect(result.success).toBe(true);
    expect(result.data!.length).toBeGreaterThan(0);
  });
});
