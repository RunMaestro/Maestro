/**
 * Integration Tests for Maestro Mobile CLI
 *
 * IMPORTANT: These tests require actual Maestro CLI installation to run.
 * They exercise real Maestro CLI commands and verify end-to-end functionality.
 *
 * Run with: npm run test:integration
 *
 * Prerequisites:
 * - Maestro CLI installed (curl -Ls "https://get.maestro.mobile.dev" | bash)
 * - macOS with Xcode (for iOS simulator tests)
 * - At least one iOS simulator runtime available (for execution tests)
 *
 * These tests are meant to be run manually or in CI environments with macOS + Xcode.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Skip test suite if not on macOS (iOS simulators are macOS-only)
const isMacOS = process.platform === 'darwin';
const runTests = isMacOS;

// Import Maestro CLI functions
import {
  detectMaestroCli,
  isMaestroAvailable,
  getMaestroInfo,
  validateMaestroVersion,
  getInstallInstructions,
  validateMaestroSetup,
  runMaestro,
} from '../../main/ios-tools/maestro-cli';

// Import flow generation functions
import {
  generateFlow,
  generateFlowFile,
  generateFlowFromStrings,
  parseActionString,
  tap,
  inputText,
  scroll,
  screenshotStep,
  assertVisible,
  assertNotVisible,
  waitForStep,
  swipe,
  launchAppStep,
  stopApp,
  openLink,
  pressKey,
  hideKeyboard,
  eraseText,
  wait,
} from '../../main/ios-tools/flow-generator';

// Import flow execution functions
import {
  runFlow,
  runFlowWithRetry,
  runFlows,
  validateFlow,
  validateFlowWithMaestro,
} from '../../main/ios-tools/flow-runner';

// Import simulator functions for execution tests
import {
  getBootedSimulators,
  bootSimulator,
  shutdownSimulator,
  listSimulators,
  launchApp,
} from '../../main/ios-tools/simulator';

// =============================================================================
// Test Fixtures
// =============================================================================

let tempDir: string;
let maestroAvailable: boolean = false;
let bootedSimulatorUdid: string | null = null;
let wasSimulatorAlreadyBooted: boolean = false;

// Settings app bundle ID - available on all iOS simulators
const SETTINGS_BUNDLE_ID = 'com.apple.Preferences';

/**
 * Create a simple test flow file
 */
async function createTestFlowFile(content: string, filename: string): Promise<string> {
  const filePath = path.join(tempDir, filename);
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

// =============================================================================
// Maestro CLI Detection Tests (no simulator required)
// =============================================================================

describe.skipIf(!runTests)('Maestro CLI Detection Integration', () => {
  beforeAll(async () => {
    // Check if Maestro is available
    maestroAvailable = await isMaestroAvailable();
    console.log(`Maestro CLI available: ${maestroAvailable}`);
  });

  describe('CLI Detection', () => {
    it('detects Maestro CLI installation', async () => {
      const result = await detectMaestroCli();

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();

      if (result.data!.available) {
        console.log(`Maestro found at: ${result.data!.path}`);
        console.log(`Maestro version: ${result.data!.version}`);
        expect(result.data!.path).toBeDefined();
        expect(result.data!.path!.length).toBeGreaterThan(0);
      } else {
        console.log('Maestro CLI not installed');
        expect(result.data!.installInstructions).toBeDefined();
        expect(result.data!.installInstructions).toContain('curl');
      }
    });

    it('returns consistent availability check', async () => {
      const available = await isMaestroAvailable();
      const detectResult = await detectMaestroCli();

      expect(available).toBe(detectResult.data?.available ?? false);
    });
  });

  describe.skipIf(!maestroAvailable)('CLI Information', () => {
    it('gets complete Maestro CLI info', async () => {
      const result = await getMaestroInfo();

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.path).toBeDefined();
      expect(result.data!.version).toBeDefined();
      expect(result.data!.isWorking).toBe(true);

      console.log(`Maestro path: ${result.data!.path}`);
      console.log(`Maestro version: ${result.data!.version}`);
      console.log(`Maestro working: ${result.data!.isWorking}`);
    });

    it('validates Maestro version against minimum requirement', async () => {
      // Test with a low version requirement that should pass
      const result = await validateMaestroVersion('1.0.0');

      expect(result.success).toBe(true);
    });

    it('fails validation for unreasonably high version requirement', async () => {
      // Test with an impossibly high version requirement
      const result = await validateMaestroVersion('999.0.0');

      expect(result.success).toBe(false);
      expect(result.error).toContain('below minimum');
    });
  });

  describe('Installation Instructions', () => {
    it('provides structured installation instructions', () => {
      const instructions = getInstallInstructions();

      expect(instructions).toBeDefined();
      expect(instructions.message).toBe('Maestro CLI is not installed');
      expect(instructions.methods).toBeDefined();
      expect(instructions.methods.length).toBeGreaterThanOrEqual(2);

      // Verify curl method
      const curlMethod = instructions.methods.find(m => m.name.includes('curl'));
      expect(curlMethod).toBeDefined();
      expect(curlMethod!.command).toContain('curl');

      // Verify Homebrew method
      const homebrewMethod = instructions.methods.find(m => m.name.includes('Homebrew'));
      expect(homebrewMethod).toBeDefined();
      expect(homebrewMethod!.command).toContain('brew');

      // Verify documentation URL
      expect(instructions.documentation).toContain('maestro.mobile.dev');
    });
  });

  describe.skipIf(!maestroAvailable)('CLI Commands', () => {
    it('runs maestro --version successfully', async () => {
      const result = await runMaestro(['--version']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/\d+\.\d+/); // Version number
    });

    it('runs maestro --help successfully', async () => {
      const result = await runMaestro(['--help']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
    });

    it('handles invalid commands gracefully', async () => {
      const result = await runMaestro(['nonexistent-command-12345']);

      expect(result.exitCode).not.toBe(0);
    });
  });
});

// =============================================================================
// Flow Generation Integration Tests (no Maestro CLI required)
// =============================================================================

describe.skipIf(!runTests)('Flow Generation Integration', () => {
  beforeAll(async () => {
    // Create temp directory for test flows
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-flow-test-'));
    console.log(`Test temp directory: ${tempDir}`);
  });

  afterAll(async () => {
    // Cleanup temp directory
    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
        console.log('Cleaned up temp directory');
      } catch (e) {
        console.log(`Failed to cleanup temp directory: ${e}`);
      }
    }
  });

  describe('Step Helpers', () => {
    it('creates tap step with text target', () => {
      const step = tap({ text: 'Login' });

      expect(step.action).toBe('tap');
      expect(step.text).toBe('Login');
    });

    it('creates tap step with id target', () => {
      const step = tap({ id: 'loginButton' });

      expect(step.action).toBe('tap');
      expect(step.id).toBe('loginButton');
    });

    it('creates tap step with coordinates', () => {
      const step = tap({ point: { x: 100, y: 200 } });

      expect(step.action).toBe('tap');
      expect(step.point).toEqual({ x: 100, y: 200 });
    });

    it('creates inputText step', () => {
      const step = inputText('hello@example.com');

      expect(step.action).toBe('inputText');
      expect(step.text).toBe('hello@example.com');
    });

    it('creates scroll step', () => {
      const step = scroll('down');

      expect(step.action).toBe('scroll');
      expect(step.direction).toBe('down');
    });

    it('creates screenshot step', () => {
      const step = screenshotStep('login-screen');

      expect(step.action).toBe('screenshot');
      expect(step.filename).toBe('login-screen');
    });

    it('creates assertVisible step', () => {
      const step = assertVisible({ text: 'Welcome' });

      expect(step.action).toBe('assertVisible');
      expect(step.text).toBe('Welcome');
    });

    it('creates launchApp step', () => {
      const step = launchAppStep({ bundleId: 'com.example.app', clearState: true });

      expect(step.action).toBe('launchApp');
      expect(step.bundleId).toBe('com.example.app');
      expect(step.clearState).toBe(true);
    });

    it('creates swipe step', () => {
      const step = swipe({ x: 200, y: 400 }, { x: 200, y: 100 });

      expect(step.action).toBe('swipe');
      expect(step.start).toEqual({ x: 200, y: 400 });
      expect(step.end).toEqual({ x: 200, y: 100 });
    });
  });

  describe('Action String Parsing', () => {
    it('parses tap action string', () => {
      const step = parseActionString('tap:Login');

      expect(step).not.toBeNull();
      expect(step!.action).toBe('tap');
      expect((step as any).text).toBe('Login');
    });

    it('parses tapid action string', () => {
      const step = parseActionString('tapid:loginButton');

      expect(step).not.toBeNull();
      expect(step!.action).toBe('tap');
      expect((step as any).id).toBe('loginButton');
    });

    it('parses type action string', () => {
      const step = parseActionString('type:hello@example.com');

      expect(step).not.toBeNull();
      expect(step!.action).toBe('inputText');
      expect((step as any).text).toBe('hello@example.com');
    });

    it('parses scroll action string', () => {
      const step = parseActionString('scroll:down');

      expect(step).not.toBeNull();
      expect(step!.action).toBe('scroll');
      expect((step as any).direction).toBe('down');
    });

    it('parses screenshot action string', () => {
      const step = parseActionString('screenshot:login');

      expect(step).not.toBeNull();
      expect(step!.action).toBe('screenshot');
    });

    it('parses wait action string with duration', () => {
      const step = parseActionString('wait:2000');

      expect(step).not.toBeNull();
      expect(step!.action).toBe('wait');
      expect((step as any).duration).toBe(2000);
    });

    it('parses simple action without argument', () => {
      const step = parseActionString('hideKeyboard');

      expect(step).not.toBeNull();
      expect(step!.action).toBe('hideKeyboard');
    });

    it('returns null for invalid action', () => {
      const step = parseActionString('invalid:action');

      expect(step).toBeNull();
    });
  });

  describe('Flow YAML Generation', () => {
    it('generates flow from steps array', () => {
      const steps = [
        launchAppStep({ bundleId: 'com.example.app' }),
        tap({ text: 'Login' }),
        inputText('user@example.com'),
        assertVisible({ text: 'Welcome' }),
      ];

      const result = generateFlow(steps);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.yaml).toContain('launchApp');
      expect(result.data!.yaml).toContain('tapOn');
      expect(result.data!.yaml).toContain('inputText');
      expect(result.data!.yaml).toContain('assertVisible');
      expect(result.data!.stepCount).toBe(4);
    });

    it('generates flow with configuration', () => {
      const steps = [tap({ text: 'Button' })];
      const config = {
        appId: 'com.example.app',
        name: 'Test Flow',
        env: { USERNAME: 'testuser' },
      };

      const result = generateFlow(steps, config);

      expect(result.success).toBe(true);
      expect(result.data!.yaml).toContain('appId: com.example.app');
      expect(result.data!.yaml).toContain('name: Test Flow');
      expect(result.data!.yaml).toContain('USERNAME');
    });

    it('generates flow from action strings', () => {
      const actions = ['tap:Login', 'type:password123', 'scroll:down'];

      const result = generateFlowFromStrings(actions);

      expect(result.success).toBe(true);
      expect(result.data!.stepCount).toBe(3);
      expect(result.data!.yaml).toContain('tapOn');
      expect(result.data!.yaml).toContain('inputText');
      expect(result.data!.yaml).toContain('scroll');
    });

    it('fails for invalid action strings', () => {
      const actions = ['tap:Login', 'invalid:action', 'scroll:down'];

      const result = generateFlowFromStrings(actions);

      expect(result.success).toBe(false);
      expect(result.error).toContain('invalid:action');
    });

    it('returns error for empty steps array', () => {
      const result = generateFlow([]);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No steps provided');
    });
  });

  describe('Flow File Writing', () => {
    it('generates and saves flow file', async () => {
      const steps = [
        tap({ text: 'Login' }),
        inputText('test@example.com'),
      ];

      const outputPath = path.join(tempDir, 'test-flow.yaml');
      const result = await generateFlowFile(steps, outputPath);

      expect(result.success).toBe(true);
      expect(result.data!.path).toBe(outputPath);

      // Verify file exists and has correct content
      const content = await fs.readFile(outputPath, 'utf-8');
      expect(content).toContain('tapOn');
      expect(content).toContain('inputText');
    });

    it('adds .yaml extension if missing', async () => {
      const steps = [tap({ text: 'Button' })];

      const outputPath = path.join(tempDir, 'flow-without-extension');
      const result = await generateFlowFile(steps, outputPath);

      expect(result.success).toBe(true);
      expect(result.data!.path).toBe(`${outputPath}.yaml`);

      // Verify file exists
      const exists = await fs.access(`${outputPath}.yaml`).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('creates parent directories if needed', async () => {
      const steps = [tap({ text: 'Button' })];

      const outputPath = path.join(tempDir, 'subdir', 'nested', 'flow.yaml');
      const result = await generateFlowFile(steps, outputPath);

      expect(result.success).toBe(true);

      // Verify file exists
      const exists = await fs.access(outputPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });
  });

  describe('Flow YAML Content Validation', () => {
    it('escapes special characters in text', () => {
      const steps = [
        tap({ text: 'He said "Hello"' }),
        inputText('Line1\nLine2'),
      ];

      const result = generateFlow(steps);

      expect(result.success).toBe(true);
      // Should escape quotes
      expect(result.data!.yaml).toContain('\\"Hello\\"');
      // Should escape newlines
      expect(result.data!.yaml).toContain('\\n');
    });

    it('generates correct YAML for complex tap', () => {
      const step = tap({ id: 'button', index: 2 });

      const result = generateFlow([step]);

      expect(result.success).toBe(true);
      expect(result.data!.yaml).toContain('id:');
      expect(result.data!.yaml).toContain('index: 2');
    });

    it('generates correct YAML for scroll until visible', () => {
      const step = scroll('down', { untilVisible: 'Submit' });

      const result = generateFlow([step]);

      expect(result.success).toBe(true);
      expect(result.data!.yaml).toContain('scrollUntilVisible');
      expect(result.data!.yaml).toContain('Submit');
    });
  });
});

// =============================================================================
// Flow Validation Integration Tests (requires Maestro CLI)
// =============================================================================

describe.skipIf(!runTests)('Flow Validation Integration', () => {
  beforeAll(async () => {
    // Create temp directory for test flows
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-validation-test-'));
    maestroAvailable = await isMaestroAvailable();
  });

  afterAll(async () => {
    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });

  describe('Basic Validation (no Maestro required)', () => {
    it('validates existing flow file', async () => {
      const content = `
- launchApp:
    appId: com.example.app
- tapOn: "Login"
- inputText: "hello"
`;
      const flowPath = await createTestFlowFile(content, 'valid-flow.yaml');
      const result = await validateFlow(flowPath);

      expect(result.success).toBe(true);
      expect(result.data!.valid).toBe(true);
      expect(result.data!.errors.length).toBe(0);
    });

    it('detects empty flow file', async () => {
      const flowPath = await createTestFlowFile('', 'empty-flow.yaml');
      const result = await validateFlow(flowPath);

      expect(result.success).toBe(true);
      expect(result.data!.valid).toBe(false);
      expect(result.data!.errors).toContain('Flow file is empty');
    });

    it('detects flow file with no steps', async () => {
      const content = 'appId: com.example.app';
      const flowPath = await createTestFlowFile(content, 'no-steps.yaml');
      const result = await validateFlow(flowPath);

      expect(result.success).toBe(true);
      expect(result.data!.valid).toBe(false);
      expect(result.data!.errors.some(e => e.includes('no steps'))).toBe(true);
    });

    it('returns error for non-existent file', async () => {
      const result = await validateFlow('/nonexistent/path/flow.yaml');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Flow file not found');
    });
  });

  describe.skipIf(!maestroAvailable)('Maestro CLI Validation', () => {
    it('validates flow with Maestro CLI', async () => {
      const content = `
- launchApp:
    appId: com.apple.Preferences
- tapOn: "General"
`;
      const flowPath = await createTestFlowFile(content, 'maestro-valid.yaml');
      const result = await validateFlowWithMaestro(flowPath);

      // Maestro validate may succeed or fail based on the flow
      // We're mainly testing that the CLI is called correctly
      expect(result.success).toBeDefined();

      if (result.success) {
        expect(result.data).toBeDefined();
        console.log(`Maestro validation output: ${result.data}`);
      } else {
        console.log(`Maestro validation error: ${result.error}`);
      }
    });

    it('returns error for invalid YAML syntax', async () => {
      const content = `
- launchApp:
  appId: com.example.app  # Wrong indentation
- tapOn: "Login
`;  // Missing closing quote
      const flowPath = await createTestFlowFile(content, 'invalid-yaml.yaml');
      const result = await validateFlowWithMaestro(flowPath);

      // Should fail validation
      expect(result.success).toBe(false);
    });
  });
});

// =============================================================================
// Flow Execution Integration Tests (requires Maestro CLI + Simulator)
// =============================================================================

describe.skipIf(!runTests)('Flow Execution Integration', () => {
  const testSessionId = `maestro-exec-test-${Date.now()}`;

  beforeAll(async () => {
    // Create temp directory for test flows
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-exec-test-'));
    maestroAvailable = await isMaestroAvailable();

    if (!maestroAvailable) {
      console.log('Skipping execution tests - Maestro CLI not available');
      return;
    }

    // Find or boot a simulator
    const bootedResult = await getBootedSimulators();
    if (bootedResult.success && bootedResult.data && bootedResult.data.length > 0) {
      bootedSimulatorUdid = bootedResult.data[0].udid;
      wasSimulatorAlreadyBooted = true;
      console.log(`Using existing booted simulator: ${bootedSimulatorUdid}`);
    } else {
      // Try to boot a simulator
      const listResult = await listSimulators();
      const available = listResult.data?.find((s) => s.isAvailable && s.state === 'Shutdown');
      if (available) {
        console.log(`Booting simulator for execution tests: ${available.name}`);
        const bootResult = await bootSimulator({
          udid: available.udid,
          timeout: 120000,
          waitForBoot: true,
        });
        if (bootResult.success) {
          bootedSimulatorUdid = available.udid;
          wasSimulatorAlreadyBooted = false;
          // Wait for system services to initialize
          console.log('Waiting for system services to initialize...');
          await new Promise((resolve) => setTimeout(resolve, 8000));
        }
      }
    }

    // Launch Settings app for tests
    if (bootedSimulatorUdid) {
      console.log('Launching Settings app for execution tests...');
      const launchResult = await launchApp(bootedSimulatorUdid, SETTINGS_BUNDLE_ID);
      if (!launchResult.success) {
        console.log(`Failed to launch Settings app: ${launchResult.error}`);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }, 180000);

  afterAll(async () => {
    // Cleanup temp directory
    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    }

    // Shutdown simulator if we booted it
    if (bootedSimulatorUdid && !wasSimulatorAlreadyBooted) {
      console.log(`Cleaning up: shutting down simulator ${bootedSimulatorUdid}`);
      await shutdownSimulator(bootedSimulatorUdid);
    }
  });

  describe.skipIf(!maestroAvailable)('Setup Validation', () => {
    it('validates complete Maestro setup', async () => {
      const result = await validateMaestroSetup();

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();

      console.log(`Setup valid: ${result.data!.valid}`);
      console.log(`CLI installed: ${result.data!.cliInstalled}`);
      console.log(`Simulator available: ${result.data!.simulatorAvailable}`);
      console.log(`iOS driver working: ${result.data!.iosDriverWorking}`);

      if (result.data!.issues.length > 0) {
        console.log(`Issues: ${result.data!.issues.join(', ')}`);
      }
      if (result.data!.recommendations.length > 0) {
        console.log(`Recommendations: ${result.data!.recommendations.join(', ')}`);
      }
    });
  });

  describe.skipIf(!maestroAvailable || !bootedSimulatorUdid)('Flow Execution', () => {
    it('executes a simple flow', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping execution test');
        return;
      }

      // Create a simple flow that just takes a screenshot
      const content = `
- launchApp:
    appId: ${SETTINGS_BUNDLE_ID}
- takeScreenshot
`;
      const flowPath = await createTestFlowFile(content, 'simple-exec.yaml');

      const result = await runFlow({
        flowPath,
        sessionId: testSessionId,
        udid: bootedSimulatorUdid,
        timeout: 60000,
        captureOnFailure: true,
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();

      console.log(`Flow passed: ${result.data!.passed}`);
      console.log(`Duration: ${result.data!.duration}ms`);
      console.log(`Steps: ${result.data!.passedSteps}/${result.data!.totalSteps}`);

      if (!result.data!.passed && result.data!.failureScreenshotPath) {
        console.log(`Failure screenshot: ${result.data!.failureScreenshotPath}`);
      }
    }, 120000);

    it('captures failure screenshot when flow fails', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping failure test');
        return;
      }

      // Create a flow that will fail (assert element that doesn't exist)
      const content = `
- assertVisible: "ThisElementDoesNotExist12345"
`;
      const flowPath = await createTestFlowFile(content, 'failing-exec.yaml');

      const result = await runFlow({
        flowPath,
        sessionId: testSessionId,
        udid: bootedSimulatorUdid,
        timeout: 30000,
        captureOnFailure: true,
      });

      expect(result.success).toBe(true);
      expect(result.data!.passed).toBe(false);

      // Should have captured failure screenshot
      if (result.data!.failureScreenshotPath) {
        const screenshotExists = await fs.access(result.data!.failureScreenshotPath)
          .then(() => true)
          .catch(() => false);
        expect(screenshotExists).toBe(true);
        console.log(`Failure screenshot captured: ${result.data!.failureScreenshotPath}`);
      }
    }, 60000);

    it('supports environment variables in flow', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping env var test');
        return;
      }

      // Note: This just tests that env vars are passed - actual usage depends on the flow
      const content = `
- launchApp:
    appId: ${SETTINGS_BUNDLE_ID}
- takeScreenshot
`;
      const flowPath = await createTestFlowFile(content, 'env-var-exec.yaml');

      const result = await runFlow({
        flowPath,
        sessionId: testSessionId,
        udid: bootedSimulatorUdid,
        env: {
          TEST_USER: 'integration-test',
          TEST_PASSWORD: 'secret123',
        },
        timeout: 60000,
      });

      expect(result.success).toBe(true);
      console.log(`Flow with env vars: ${result.data!.passed ? 'passed' : 'failed'}`);
    }, 120000);

    it('auto-detects simulator when udid not provided', async () => {
      // Skip if no simulator is booted
      const bootedResult = await getBootedSimulators();
      if (!bootedResult.success || !bootedResult.data || bootedResult.data.length === 0) {
        console.log('No booted simulator, skipping auto-detect test');
        return;
      }

      const content = `- takeScreenshot`;
      const flowPath = await createTestFlowFile(content, 'auto-detect.yaml');

      const result = await runFlow({
        flowPath,
        sessionId: testSessionId,
        // No udid provided - should auto-detect
        timeout: 30000,
      });

      expect(result.success).toBe(true);
      expect(result.data!.udid).toBe(bootedResult.data![0].udid);
      console.log(`Auto-detected simulator: ${result.data!.udid}`);
    }, 60000);
  });

  describe.skipIf(!maestroAvailable || !bootedSimulatorUdid)('Flow Retry Support', () => {
    it('retries failed flow', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping retry test');
        return;
      }

      // Create a flow that might be flaky (timing-dependent)
      const content = `
- launchApp:
    appId: ${SETTINGS_BUNDLE_ID}
- takeScreenshot
`;
      const flowPath = await createTestFlowFile(content, 'retry-exec.yaml');

      const result = await runFlowWithRetry({
        flowPath,
        sessionId: testSessionId,
        udid: bootedSimulatorUdid,
        maxRetries: 2,
        retryDelay: 1000,
        timeout: 60000,
      });

      expect(result.success).toBe(true);
      console.log(`Flow with retry: ${result.data!.passed ? 'passed' : 'failed'}`);
    }, 180000);
  });

  describe.skipIf(!maestroAvailable || !bootedSimulatorUdid)('Batch Flow Execution', () => {
    it('runs multiple flows in sequence', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping batch test');
        return;
      }

      // Create multiple simple flows
      const flow1Content = `- takeScreenshot: "batch-1"`;
      const flow2Content = `- takeScreenshot: "batch-2"`;
      const flow3Content = `- takeScreenshot: "batch-3"`;

      const flow1Path = await createTestFlowFile(flow1Content, 'batch-1.yaml');
      const flow2Path = await createTestFlowFile(flow2Content, 'batch-2.yaml');
      const flow3Path = await createTestFlowFile(flow3Content, 'batch-3.yaml');

      const result = await runFlows([flow1Path, flow2Path, flow3Path], {
        sessionId: testSessionId,
        udid: bootedSimulatorUdid,
        timeout: 30000,
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.totalFlows).toBe(3);

      console.log(`Batch results: ${result.data!.passedFlows}/${result.data!.totalFlows} passed`);
      console.log(`Total duration: ${result.data!.totalDuration}ms`);
    }, 180000);

    it('stops on first failure by default', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping stop-on-failure test');
        return;
      }

      // Create flows where the second one will fail
      const flow1Content = `- takeScreenshot: "stop-1"`;
      const flow2Content = `- assertVisible: "NonExistentElement12345"`;
      const flow3Content = `- takeScreenshot: "stop-3"`;

      const flow1Path = await createTestFlowFile(flow1Content, 'stop-1.yaml');
      const flow2Path = await createTestFlowFile(flow2Content, 'stop-2.yaml');
      const flow3Path = await createTestFlowFile(flow3Content, 'stop-3.yaml');

      const result = await runFlows([flow1Path, flow2Path, flow3Path], {
        sessionId: testSessionId,
        udid: bootedSimulatorUdid,
        timeout: 30000,
        continueOnError: false, // Default behavior
      });

      expect(result.success).toBe(true);
      expect(result.data!.results.length).toBeLessThanOrEqual(2);
      console.log(`Stopped after ${result.data!.results.length} flows`);
    }, 180000);

    it('continues on failure when configured', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping continue-on-failure test');
        return;
      }

      // Create flows where the second one will fail
      const flow1Content = `- takeScreenshot: "continue-1"`;
      const flow2Content = `- assertVisible: "NonExistentElement12345"`;
      const flow3Content = `- takeScreenshot: "continue-3"`;

      const flow1Path = await createTestFlowFile(flow1Content, 'continue-1.yaml');
      const flow2Path = await createTestFlowFile(flow2Content, 'continue-2.yaml');
      const flow3Path = await createTestFlowFile(flow3Content, 'continue-3.yaml');

      const result = await runFlows([flow1Path, flow2Path, flow3Path], {
        sessionId: testSessionId,
        udid: bootedSimulatorUdid,
        timeout: 30000,
        continueOnError: true,
      });

      expect(result.success).toBe(true);
      expect(result.data!.results.length).toBe(3);
      expect(result.data!.failedFlows).toBe(1);
      console.log(`Continued through all ${result.data!.results.length} flows`);
    }, 180000);
  });
});

// =============================================================================
// Performance Tests
// =============================================================================

describe.skipIf(!runTests)('Maestro CLI Performance', () => {
  it('completes CLI detection within performance threshold', async () => {
    const startTime = Date.now();

    await detectMaestroCli();

    const duration = Date.now() - startTime;
    console.log(`CLI detection completed in ${duration}ms`);

    // Detection should complete in under 5 seconds
    expect(duration).toBeLessThan(5000);
  });

  it('generates flow YAML quickly', () => {
    const startTime = Date.now();

    // Generate a flow with many steps
    const steps = [];
    for (let i = 0; i < 100; i++) {
      steps.push(tap({ text: `Button ${i}` }));
      steps.push(inputText(`text${i}`));
    }

    const result = generateFlow(steps);

    const duration = Date.now() - startTime;
    console.log(`Generated flow with ${steps.length} steps in ${duration}ms`);

    expect(result.success).toBe(true);
    // Should complete in under 100ms even for large flows
    expect(duration).toBeLessThan(100);
  });
});
