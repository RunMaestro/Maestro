/**
 * Integration Tests for Native XCUITest Driver
 *
 * IMPORTANT: These tests require actual iOS simulator and XCUITest capabilities to run.
 * They exercise the native driver's interaction with real iOS simulators.
 *
 * Run with: npm run test:integration -- src/__tests__/integration/native-driver.integration.test.ts
 *
 * Prerequisites:
 * - macOS with Xcode installed
 * - At least one iOS simulator runtime available
 * - A booted iOS simulator for execution tests
 *
 * Note: The native driver currently returns "not yet implemented" for actual execution
 * since it requires building XCUITest projects dynamically. These tests validate the
 * driver's initialization, target creation, action creation, and batch execution logic,
 * while gracefully handling the not-implemented state.
 *
 * When the native driver is fully implemented, these tests will validate actual
 * UI interactions on iOS simulators.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Skip test suite if not on macOS (iOS simulators are macOS-only)
const isMacOS = process.platform === 'darwin';
const runTests = isMacOS;

// Import native driver functions
import {
  NativeDriver,
  createNativeDriver,
  byId,
  byLabel,
  byText,
  byPredicate,
  byCoordinates,
  byType,
  tap,
  doubleTap,
  longPress,
  typeText,
  clearText,
  scroll,
  scrollTo,
  swipe,
  pinch,
  rotate,
  waitForElement,
  waitForNotExist,
  assertExists,
  assertNotExists,
  assertEnabled,
  assertDisabled,
  ActionTarget,
  ActionRequest,
  ActionResult,
  BatchActionResult,
  NativeDriverOptions,
} from '../../main/ios-tools/native-driver';

// Import simulator functions for environment tests
import {
  getBootedSimulators,
  listSimulators,
  bootSimulator,
  shutdownSimulator,
} from '../../main/ios-tools/simulator';

// =============================================================================
// Test Fixtures
// =============================================================================

let bootedSimulatorUdid: string | null = null;
let wasSimulatorAlreadyBooted: boolean = false;

// Settings app bundle ID - available on all iOS simulators
const SETTINGS_BUNDLE_ID = 'com.apple.Preferences';

// =============================================================================
// Target Helper Integration Tests
// =============================================================================

describe.skipIf(!runTests)('Native Driver Target Helpers Integration', () => {
  describe('Target Creation', () => {
    it('creates targets with all supported types', () => {
      // Test all target creation helpers
      const targets: ActionTarget[] = [
        byId('login-button'),
        byId('submit', 'button'),
        byLabel('Sign In'),
        byLabel('Email', 'textField'),
        byText('Welcome back!'),
        byPredicate('label CONTAINS "Login"'),
        byPredicate('value.length > 0', 'textField'),
        byCoordinates(100, 200),
        byCoordinates(150.5, 300.75),
        byType('button'),
        byType('cell', 3),
      ];

      expect(targets.length).toBe(11);

      // Verify each target has correct structure
      targets.forEach((target) => {
        expect(target).toHaveProperty('type');
        expect(target).toHaveProperty('value');
        expect(typeof target.value).toBe('string');
      });
    });

    it('creates identifier targets correctly', () => {
      const target = byId('my-button-id');

      expect(target.type).toBe('identifier');
      expect(target.value).toBe('my-button-id');
      expect(target.elementType).toBeUndefined();
    });

    it('creates identifier targets with element type filter', () => {
      const target = byId('submit', 'button');

      expect(target.type).toBe('identifier');
      expect(target.value).toBe('submit');
      expect(target.elementType).toBe('button');
    });

    it('creates label targets correctly', () => {
      const target = byLabel('Continue');

      expect(target.type).toBe('label');
      expect(target.value).toBe('Continue');
    });

    it('creates text targets correctly', () => {
      const target = byText('Hello World');

      expect(target.type).toBe('text');
      expect(target.value).toBe('Hello World');
    });

    it('creates predicate targets correctly', () => {
      const target = byPredicate('label BEGINSWITH "Test"');

      expect(target.type).toBe('predicate');
      expect(target.value).toBe('label BEGINSWITH "Test"');
    });

    it('creates coordinate targets correctly', () => {
      const target = byCoordinates(250, 400);

      expect(target.type).toBe('coordinates');
      expect(target.value).toBe('250,400');
    });

    it('creates type targets correctly', () => {
      const target = byType('textField', 0);

      expect(target.type).toBe('type');
      expect(target.value).toBe('textField');
      expect(target.index).toBe(0);
    });
  });

  describe('Target Edge Cases', () => {
    it('handles empty identifier', () => {
      const target = byId('');

      expect(target.type).toBe('identifier');
      expect(target.value).toBe('');
    });

    it('handles special characters in label', () => {
      const target = byLabel('Button with "quotes" & <special> chars');

      expect(target.value).toBe('Button with "quotes" & <special> chars');
    });

    it('handles unicode in text', () => {
      const target = byText('Приветствие 日本語 🎉');

      expect(target.value).toBe('Приветствие 日本語 🎉');
    });

    it('handles negative coordinates', () => {
      const target = byCoordinates(-10, -20);

      expect(target.value).toBe('-10,-20');
    });

    it('handles zero coordinates', () => {
      const target = byCoordinates(0, 0);

      expect(target.value).toBe('0,0');
    });

    it('handles very large coordinates', () => {
      const target = byCoordinates(10000, 20000);

      expect(target.value).toBe('10000,20000');
    });
  });
});

// =============================================================================
// Action Helper Integration Tests
// =============================================================================

describe.skipIf(!runTests)('Native Driver Action Helpers Integration', () => {
  describe('Tap Actions', () => {
    it('creates tap action with target', () => {
      const target = byId('button');
      const action = tap(target);

      expect(action.type).toBe('tap');
      expect(action.target).toBe(target);
    });

    it('creates tap action with offset', () => {
      const target = byId('slider');
      const action = tap(target, { offsetX: 0.9, offsetY: 0.5 });

      expect(action.type).toBe('tap');
      expect(action.offsetX).toBe(0.9);
      expect(action.offsetY).toBe(0.5);
    });

    it('creates double tap action', () => {
      const target = byLabel('Image');
      const action = doubleTap(target);

      expect(action.type).toBe('doubleTap');
      expect(action.target).toBe(target);
    });

    it('creates long press action with default duration', () => {
      const target = byId('cell');
      const action = longPress(target);

      expect(action.type).toBe('longPress');
      expect(action.duration).toBe(1.0);
    });

    it('creates long press action with custom duration', () => {
      const target = byId('cell');
      const action = longPress(target, 3.5);

      expect(action.type).toBe('longPress');
      expect(action.duration).toBe(3.5);
    });
  });

  describe('Text Actions', () => {
    it('creates type text action', () => {
      const action = typeText('Hello World');

      expect(action.type).toBe('typeText');
      expect(action.text).toBe('Hello World');
    });

    it('creates type text action with target', () => {
      const target = byId('email-field');
      const action = typeText('test@example.com', { target });

      expect(action.type).toBe('typeText');
      expect(action.text).toBe('test@example.com');
      expect(action.target).toBe(target);
    });

    it('creates type text action with clear first', () => {
      const target = byId('search');
      const action = typeText('new query', { target, clearFirst: true });

      expect(action.type).toBe('typeText');
      expect(action.clearFirst).toBe(true);
    });

    it('creates clear text action', () => {
      const target = byId('input');
      const action = clearText(target);

      expect(action.type).toBe('clearText');
      expect(action.target).toBe(target);
    });
  });

  describe('Scroll and Swipe Actions', () => {
    it('creates scroll action with direction', () => {
      const action = scroll('down');

      expect(action.type).toBe('scroll');
      expect(action.direction).toBe('down');
    });

    it('creates scroll action with all options', () => {
      const target = byId('scroll-view');
      const action = scroll('up', { target, distance: 0.8 });

      expect(action.type).toBe('scroll');
      expect(action.direction).toBe('up');
      expect(action.target).toBe(target);
      expect(action.distance).toBe(0.8);
    });

    it('supports all scroll directions', () => {
      expect(scroll('up').direction).toBe('up');
      expect(scroll('down').direction).toBe('down');
      expect(scroll('left').direction).toBe('left');
      expect(scroll('right').direction).toBe('right');
    });

    it('creates scroll to action', () => {
      const target = byId('footer');
      const action = scrollTo(target);

      expect(action.type).toBe('scrollTo');
      expect(action.target).toBe(target);
      expect(action.direction).toBe('down'); // Default direction
    });

    it('creates scroll to action with options', () => {
      const target = byLabel('Header');
      const action = scrollTo(target, { direction: 'up', maxAttempts: 20 });

      expect(action.type).toBe('scrollTo');
      expect(action.direction).toBe('up');
      expect(action.maxAttempts).toBe(20);
    });

    it('creates swipe action', () => {
      const action = swipe('left');

      expect(action.type).toBe('swipe');
      expect(action.direction).toBe('left');
    });

    it('creates swipe action with velocity', () => {
      const action = swipe('right', { velocity: 'fast' });

      expect(action.type).toBe('swipe');
      expect(action.velocity).toBe('fast');
    });

    it('creates swipe action on specific element', () => {
      const target = byId('carousel');
      const action = swipe('left', { target, velocity: 'slow' });

      expect(action.type).toBe('swipe');
      expect(action.target).toBe(target);
      expect(action.velocity).toBe('slow');
    });
  });

  describe('Gesture Actions', () => {
    it('creates pinch action for zoom in', () => {
      const action = pinch(2.0);

      expect(action.type).toBe('pinch');
      expect(action.scale).toBe(2.0);
    });

    it('creates pinch action for zoom out', () => {
      const action = pinch(0.5);

      expect(action.type).toBe('pinch');
      expect(action.scale).toBe(0.5);
    });

    it('creates pinch action with options', () => {
      const target = byId('map');
      const action = pinch(1.5, { target, velocity: 2.0 });

      expect(action.type).toBe('pinch');
      expect(action.target).toBe(target);
      expect(action.gestureVelocity).toBe(2.0);
    });

    it('creates rotate action', () => {
      const action = rotate(Math.PI / 2);

      expect(action.type).toBe('rotate');
      expect(action.angle).toBeCloseTo(Math.PI / 2);
    });

    it('creates rotate action with options', () => {
      const target = byId('image');
      const action = rotate(Math.PI, { target, velocity: 3.0 });

      expect(action.type).toBe('rotate');
      expect(action.angle).toBeCloseTo(Math.PI);
      expect(action.target).toBe(target);
      expect(action.gestureVelocity).toBe(3.0);
    });
  });

  describe('Wait Actions', () => {
    it('creates wait for element action', () => {
      const target = byId('loading');
      const action = waitForElement(target);

      expect(action.type).toBe('waitForElement');
      expect(action.target).toBe(target);
    });

    it('creates wait for element action with timeout', () => {
      const target = byLabel('Content');
      const action = waitForElement(target, 30000);

      expect(action.type).toBe('waitForElement');
      expect(action.timeout).toBe(30000);
    });

    it('creates wait for not exist action', () => {
      const target = byId('spinner');
      const action = waitForNotExist(target);

      expect(action.type).toBe('waitForNotExist');
      expect(action.target).toBe(target);
    });

    it('creates wait for not exist action with timeout', () => {
      const target = byId('modal');
      const action = waitForNotExist(target, 15000);

      expect(action.type).toBe('waitForNotExist');
      expect(action.timeout).toBe(15000);
    });
  });

  describe('Assert Actions', () => {
    it('creates assert exists action', () => {
      const target = byId('welcome');
      const action = assertExists(target);

      expect(action.type).toBe('assertExists');
      expect(action.target).toBe(target);
    });

    it('creates assert exists action with timeout', () => {
      const target = byLabel('Dashboard');
      const action = assertExists(target, 5000);

      expect(action.type).toBe('assertExists');
      expect(action.timeout).toBe(5000);
    });

    it('creates assert not exists action', () => {
      const target = byId('error');
      const action = assertNotExists(target);

      expect(action.type).toBe('assertNotExists');
      expect(action.target).toBe(target);
    });

    it('creates assert enabled action', () => {
      const target = byId('submit-button');
      const action = assertEnabled(target);

      expect(action.type).toBe('assertEnabled');
      expect(action.target).toBe(target);
    });

    it('creates assert disabled action', () => {
      const target = byId('locked-button');
      const action = assertDisabled(target);

      expect(action.type).toBe('assertDisabled');
      expect(action.target).toBe(target);
    });
  });
});

// =============================================================================
// Native Driver Class Integration Tests
// =============================================================================

describe.skipIf(!runTests)('Native Driver Class Integration', () => {
  beforeAll(async () => {
    // Find a booted simulator for tests
    const bootedResult = await getBootedSimulators();
    if (bootedResult.success && bootedResult.data && bootedResult.data.length > 0) {
      bootedSimulatorUdid = bootedResult.data[0].udid;
      wasSimulatorAlreadyBooted = true;
      console.log(`Using existing booted simulator: ${bootedSimulatorUdid}`);
    } else {
      // Try to boot a simulator
      const listResult = await listSimulators();
      const available = listResult.data?.find(
        (s) => s.isAvailable && s.state === 'Shutdown' && s.name?.includes('iPhone')
      );
      if (available) {
        console.log(`Booting simulator for native driver tests: ${available.name}`);
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
        } else {
          console.log(`Failed to boot simulator: ${bootResult.error}`);
        }
      } else {
        console.log('No available simulators to boot');
      }
    }
  }, 180000);

  afterAll(async () => {
    // Shutdown simulator if we booted it
    if (bootedSimulatorUdid && !wasSimulatorAlreadyBooted) {
      console.log(`Cleaning up: shutting down simulator ${bootedSimulatorUdid}`);
      await shutdownSimulator(bootedSimulatorUdid);
    }
  });

  describe('Driver Creation', () => {
    it('creates driver with required options', () => {
      const driver = createNativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
      });

      expect(driver).toBeInstanceOf(NativeDriver);
    });

    it('creates driver with all options', () => {
      const driver = createNativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: 'custom-udid',
        timeout: 15000,
        screenshotDir: '/tmp/screenshots',
        debug: true,
      });

      expect(driver).toBeInstanceOf(NativeDriver);
    });

    it('creates driver using NativeDriver constructor', () => {
      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
      });

      expect(driver).toBeDefined();
    });
  });

  describe('Driver Initialization', () => {
    it('initializes successfully with booted simulator', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping initialization test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      const result = await driver.initialize();

      expect(result.success).toBe(true);
    });

    it('initializes and auto-selects simulator when udid not provided', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping auto-select test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
      });

      const result = await driver.initialize();

      expect(result.success).toBe(true);
    });

    it('fails when no simulators are booted', async () => {
      // This test only works when we control the simulator state
      // Skip if we found a booted simulator
      if (bootedSimulatorUdid) {
        console.log('Simulator is booted, skipping no-simulator test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
      });

      const result = await driver.initialize();

      expect(result.success).toBe(false);
      expect(result.error).toContain('No booted simulators');
    });

    it('initializes only once for multiple calls', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping multiple init test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      // Call initialize multiple times
      const result1 = await driver.initialize();
      const result2 = await driver.initialize();
      const result3 = await driver.initialize();

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result3.success).toBe(true);
    });
  });

  describe('Action Execution (Not Implemented State)', () => {
    // These tests verify the driver's behavior in its current "not implemented" state
    // When execution is implemented, these tests should be updated to verify actual behavior

    it('returns not implemented error for tap action', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping tap execution test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      const result = await driver.execute(tap(byId('button')));

      expect(result.success).toBe(false);
      expect(result.error).toContain('not yet implemented');
      expect(result.errorCode).toBe('COMMAND_FAILED');
    });

    it('returns not implemented error for type action', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping type execution test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      const result = await driver.execute(typeText('test'));

      expect(result.success).toBe(false);
      expect(result.error).toContain('not yet implemented');
    });

    it('returns not implemented error for scroll action', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping scroll execution test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      const result = await driver.execute(scroll('down'));

      expect(result.success).toBe(false);
      expect(result.error).toContain('not yet implemented');
    });

    it('returns not implemented error for swipe action', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping swipe execution test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      const result = await driver.execute(swipe('left'));

      expect(result.success).toBe(false);
      expect(result.error).toContain('not yet implemented');
    });

    it('returns not implemented error for wait action', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping wait execution test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      const result = await driver.execute(waitForElement(byId('element')));

      expect(result.success).toBe(false);
      expect(result.error).toContain('not yet implemented');
    });
  });

  describe('Batch Action Execution', () => {
    it('executes batch and returns batch result structure', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping batch execution test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      const actions = [tap(byId('button1')), tap(byId('button2')), typeText('hello')];

      const result = await driver.executeAll(actions);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.totalActions).toBe(3);
      expect(result.data!.results).toBeDefined();
      expect(result.data!.timestamp).toBeDefined();
    });

    it('stops on first failure by default', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping stop-on-failure test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      const actions = [tap(byId('button1')), tap(byId('button2')), tap(byId('button3'))];

      const result = await driver.executeAll(actions);

      // Should stop after first action fails (not implemented)
      expect(result.data?.results.length).toBe(1);
    });

    it('continues on failure when specified', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping continue-on-failure test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      const actions = [tap(byId('button1')), tap(byId('button2')), tap(byId('button3'))];

      const result = await driver.executeAll(actions, { stopOnFailure: false });

      expect(result.data?.results.length).toBe(3);
      expect(result.data?.allPassed).toBe(false);
      expect(result.data?.failedActions).toBe(3);
    });

    it('calculates total duration correctly', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping duration test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      const actions = [tap(byId('button1')), tap(byId('button2'))];

      const result = await driver.executeAll(actions, { stopOnFailure: false });

      expect(result.data?.totalDuration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Convenience Methods', () => {
    it('tapById creates and executes tap action', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping tapById test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      const result = await driver.tapById('login-button');

      expect(result).toBeDefined();
      expect(result.success).toBe(false); // Not implemented yet
    });

    it('tapByLabel creates and executes tap action', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping tapByLabel test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      const result = await driver.tapByLabel('Sign In');

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
    });

    it('tapAt creates and executes coordinate tap', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping tapAt test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      const result = await driver.tapAt(100, 200);

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
    });

    it('type creates and executes type action', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping type test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      const result = await driver.type('Hello World');

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
    });

    it('typeInto creates and executes type action with target', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping typeInto test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      const result = await driver.typeInto('email-field', 'test@example.com');

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
    });

    it('typeInto with clearFirst creates correct action', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping typeInto with clear test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      const result = await driver.typeInto('search', 'new query', true);

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
    });

    it('scrollDown creates and executes scroll action', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping scrollDown test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      const result = await driver.scrollDown();

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
    });

    it('scrollDown with custom distance creates correct action', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping scrollDown with distance test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      const result = await driver.scrollDown(0.8);

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
    });

    it('scrollUp creates and executes scroll action', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping scrollUp test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      const result = await driver.scrollUp(0.3);

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
    });

    it('scrollToId creates and executes scroll to action', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping scrollToId test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      const result = await driver.scrollToId('footer');

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
    });

    it('scrollToId with maxAttempts creates correct action', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping scrollToId with maxAttempts test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      const result = await driver.scrollToId('element', 15);

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
    });

    it('swipeDirection creates and executes swipe action', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping swipeDirection test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      const result = await driver.swipeDirection('left');

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
    });

    it('waitFor creates and executes wait action', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping waitFor test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      const result = await driver.waitFor('content');

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
    });

    it('waitFor with timeout creates correct action', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping waitFor with timeout test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      const result = await driver.waitFor('content', 20000);

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
    });

    it('waitForGone creates and executes wait for not exist action', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping waitForGone test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      const result = await driver.waitForGone('spinner');

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
    });

    it('assertElementExists creates and executes assert action', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping assertElementExists test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      const result = await driver.assertElementExists('welcome');

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
    });

    it('assertElementNotExists creates and executes assert action', async () => {
      if (!bootedSimulatorUdid) {
        console.log('No booted simulator, skipping assertElementNotExists test');
        return;
      }

      const driver = new NativeDriver({
        bundleId: SETTINGS_BUNDLE_ID,
        udid: bootedSimulatorUdid,
      });

      const result = await driver.assertElementNotExists('error');

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
    });
  });
});

// =============================================================================
// Performance Tests
// =============================================================================

describe.skipIf(!runTests)('Native Driver Performance', () => {
  it('creates targets quickly', () => {
    const startTime = Date.now();

    // Create many targets
    for (let i = 0; i < 1000; i++) {
      byId(`button-${i}`);
      byLabel(`Label ${i}`);
      byCoordinates(i, i * 2);
    }

    const duration = Date.now() - startTime;
    console.log(`Created 3000 targets in ${duration}ms`);

    // Should complete in under 100ms
    expect(duration).toBeLessThan(100);
  });

  it('creates actions quickly', () => {
    const startTime = Date.now();

    // Create many actions
    for (let i = 0; i < 1000; i++) {
      tap(byId(`button-${i}`));
      typeText(`text-${i}`);
      scroll('down');
      swipe('left');
    }

    const duration = Date.now() - startTime;
    console.log(`Created 4000 actions in ${duration}ms`);

    // Should complete in under 100ms
    expect(duration).toBeLessThan(100);
  });

  it('initializes driver quickly', async () => {
    if (!bootedSimulatorUdid) {
      console.log('No booted simulator, skipping initialization performance test');
      return;
    }

    const startTime = Date.now();

    const driver = new NativeDriver({
      bundleId: SETTINGS_BUNDLE_ID,
      udid: bootedSimulatorUdid,
    });

    await driver.initialize();

    const duration = Date.now() - startTime;
    console.log(`Driver initialized in ${duration}ms`);

    // Should complete in under 5 seconds
    expect(duration).toBeLessThan(5000);
  });
});

// =============================================================================
// Error Handling Tests
// =============================================================================

describe.skipIf(!runTests)('Native Driver Error Handling', () => {
  it('handles initialization failure gracefully', async () => {
    // Create driver with invalid UDID
    const driver = new NativeDriver({
      bundleId: SETTINGS_BUNDLE_ID,
      udid: 'non-existent-udid-12345',
    });

    // Initialize should succeed because we provided a UDID
    // (it won't verify the UDID exists until execution)
    const result = await driver.initialize();
    expect(result.success).toBe(true);
  });

  it('returns proper error structure on failure', async () => {
    if (!bootedSimulatorUdid) {
      console.log('No booted simulator, skipping error structure test');
      return;
    }

    const driver = new NativeDriver({
      bundleId: SETTINGS_BUNDLE_ID,
      udid: bootedSimulatorUdid,
    });

    const result = await driver.execute(tap(byId('button')));

    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('error');
    expect(result).toHaveProperty('errorCode');
    expect(result.success).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.error!.length).toBeGreaterThan(0);
  });

  it('handles batch execution with all failures', async () => {
    if (!bootedSimulatorUdid) {
      console.log('No booted simulator, skipping batch failure test');
      return;
    }

    const driver = new NativeDriver({
      bundleId: SETTINGS_BUNDLE_ID,
      udid: bootedSimulatorUdid,
    });

    const actions = [tap(byId('b1')), tap(byId('b2')), tap(byId('b3')), tap(byId('b4')), tap(byId('b5'))];

    const result = await driver.executeAll(actions, { stopOnFailure: false });

    expect(result.success).toBe(true); // executeAll itself succeeds
    expect(result.data?.allPassed).toBe(false); // But all actions failed
    expect(result.data?.failedActions).toBe(5);
    expect(result.data?.passedActions).toBe(0);
  });
});

// =============================================================================
// Type Safety Tests
// =============================================================================

describe.skipIf(!runTests)('Native Driver Type Safety', () => {
  it('enforces correct action types', () => {
    // These are compile-time tests, but we verify runtime behavior
    const tapAction = tap(byId('button'));
    const typeAction = typeText('hello');
    const scrollAction = scroll('down');
    const swipeAction = swipe('left');

    expect(tapAction.type).toBe('tap');
    expect(typeAction.type).toBe('typeText');
    expect(scrollAction.type).toBe('scroll');
    expect(swipeAction.type).toBe('swipe');
  });

  it('enforces correct target types', () => {
    const idTarget = byId('button');
    const labelTarget = byLabel('Button');
    const coordTarget = byCoordinates(100, 200);

    expect(idTarget.type).toBe('identifier');
    expect(labelTarget.type).toBe('label');
    expect(coordTarget.type).toBe('coordinates');
  });

  it('enforces correct direction types', () => {
    const scrollUp = scroll('up');
    const scrollDown = scroll('down');
    const scrollLeft = scroll('left');
    const scrollRight = scroll('right');

    expect(scrollUp.direction).toBe('up');
    expect(scrollDown.direction).toBe('down');
    expect(scrollLeft.direction).toBe('left');
    expect(scrollRight.direction).toBe('right');
  });

  it('enforces correct velocity types', () => {
    const slowSwipe = swipe('left', { velocity: 'slow' });
    const normalSwipe = swipe('left', { velocity: 'normal' });
    const fastSwipe = swipe('left', { velocity: 'fast' });

    expect(slowSwipe.velocity).toBe('slow');
    expect(normalSwipe.velocity).toBe('normal');
    expect(fastSwipe.velocity).toBe('fast');
  });
});
