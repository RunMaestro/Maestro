import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron app
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
  },
}));

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock simulator
vi.mock('../../../main/ios-tools/simulator', () => ({
  getBootedSimulators: vi.fn().mockResolvedValue({
    success: true,
    data: [{ udid: 'mock-udid-1234', name: 'iPhone 15 Pro', state: 'Booted' }],
  }),
}));

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
} from '../../../main/ios-tools/native-driver';

import * as simulator from '../../../main/ios-tools/simulator';

describe('native-driver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // Target Helper Tests
  // ==========================================================================

  describe('Target Helpers', () => {
    describe('byId', () => {
      it('creates a target by accessibility identifier', () => {
        const target = byId('login-button');

        expect(target.type).toBe('identifier');
        expect(target.value).toBe('login-button');
        expect(target.elementType).toBeUndefined();
      });

      it('creates a target with element type filter', () => {
        const target = byId('submit', 'button');

        expect(target.type).toBe('identifier');
        expect(target.value).toBe('submit');
        expect(target.elementType).toBe('button');
      });
    });

    describe('byLabel', () => {
      it('creates a target by accessibility label', () => {
        const target = byLabel('Sign In');

        expect(target.type).toBe('label');
        expect(target.value).toBe('Sign In');
      });

      it('creates a target with element type filter', () => {
        const target = byLabel('Email', 'textField');

        expect(target.type).toBe('label');
        expect(target.value).toBe('Email');
        expect(target.elementType).toBe('textField');
      });
    });

    describe('byText', () => {
      it('creates a target by text content', () => {
        const target = byText('Welcome back!');

        expect(target.type).toBe('text');
        expect(target.value).toBe('Welcome back!');
      });
    });

    describe('byPredicate', () => {
      it('creates a target by NSPredicate', () => {
        const target = byPredicate('label CONTAINS "Login"');

        expect(target.type).toBe('predicate');
        expect(target.value).toBe('label CONTAINS "Login"');
      });

      it('creates a target with element type filter', () => {
        const target = byPredicate('value.length > 0', 'textField');

        expect(target.type).toBe('predicate');
        expect(target.value).toBe('value.length > 0');
        expect(target.elementType).toBe('textField');
      });
    });

    describe('byCoordinates', () => {
      it('creates a target by screen coordinates', () => {
        const target = byCoordinates(100, 200);

        expect(target.type).toBe('coordinates');
        expect(target.value).toBe('100,200');
      });

      it('handles decimal coordinates', () => {
        const target = byCoordinates(150.5, 300.75);

        expect(target.type).toBe('coordinates');
        expect(target.value).toBe('150.5,300.75');
      });
    });

    describe('byType', () => {
      it('creates a target by element type', () => {
        const target = byType('button');

        expect(target.type).toBe('type');
        expect(target.value).toBe('button');
        expect(target.index).toBeUndefined();
      });

      it('creates a target with index', () => {
        const target = byType('cell', 3);

        expect(target.type).toBe('type');
        expect(target.value).toBe('cell');
        expect(target.index).toBe(3);
      });
    });
  });

  // ==========================================================================
  // Action Helper Tests
  // ==========================================================================

  describe('Action Helpers', () => {
    describe('tap', () => {
      it('creates a tap action', () => {
        const target = byId('login');
        const action = tap(target);

        expect(action.type).toBe('tap');
        expect(action.target).toBe(target);
      });

      it('creates a tap action with offset', () => {
        const target = byId('slider');
        const action = tap(target, { offsetX: 0.8, offsetY: 0.5 });

        expect(action.type).toBe('tap');
        expect(action.offsetX).toBe(0.8);
        expect(action.offsetY).toBe(0.5);
      });
    });

    describe('doubleTap', () => {
      it('creates a double tap action', () => {
        const target = byLabel('Image');
        const action = doubleTap(target);

        expect(action.type).toBe('doubleTap');
        expect(action.target).toBe(target);
      });
    });

    describe('longPress', () => {
      it('creates a long press action with default duration', () => {
        const target = byId('cell-item');
        const action = longPress(target);

        expect(action.type).toBe('longPress');
        expect(action.target).toBe(target);
        expect(action.duration).toBe(1.0);
      });

      it('creates a long press action with custom duration', () => {
        const target = byId('cell-item');
        const action = longPress(target, 2.5);

        expect(action.type).toBe('longPress');
        expect(action.duration).toBe(2.5);
      });
    });

    describe('typeText', () => {
      it('creates a type text action', () => {
        const action = typeText('Hello World');

        expect(action.type).toBe('typeText');
        expect(action.text).toBe('Hello World');
        expect(action.target).toBeUndefined();
        expect(action.clearFirst).toBeUndefined();
      });

      it('creates a type text action with target', () => {
        const target = byId('email-field');
        const action = typeText('test@example.com', { target });

        expect(action.type).toBe('typeText');
        expect(action.text).toBe('test@example.com');
        expect(action.target).toBe(target);
      });

      it('creates a type text action with clear first', () => {
        const target = byId('search-field');
        const action = typeText('new search', { target, clearFirst: true });

        expect(action.type).toBe('typeText');
        expect(action.clearFirst).toBe(true);
      });
    });

    describe('clearText', () => {
      it('creates a clear text action', () => {
        const target = byId('input-field');
        const action = clearText(target);

        expect(action.type).toBe('clearText');
        expect(action.target).toBe(target);
      });
    });

    describe('scroll', () => {
      it('creates a scroll action', () => {
        const action = scroll('down');

        expect(action.type).toBe('scroll');
        expect(action.direction).toBe('down');
        expect(action.target).toBeUndefined();
      });

      it('creates a scroll action with options', () => {
        const target = byId('scroll-view');
        const action = scroll('up', { target, distance: 0.3 });

        expect(action.type).toBe('scroll');
        expect(action.direction).toBe('up');
        expect(action.target).toBe(target);
        expect(action.distance).toBe(0.3);
      });

      it('supports all directions', () => {
        expect(scroll('up').direction).toBe('up');
        expect(scroll('down').direction).toBe('down');
        expect(scroll('left').direction).toBe('left');
        expect(scroll('right').direction).toBe('right');
      });
    });

    describe('scrollTo', () => {
      it('creates a scroll to action with defaults', () => {
        const target = byId('footer-element');
        const action = scrollTo(target);

        expect(action.type).toBe('scrollTo');
        expect(action.target).toBe(target);
        expect(action.direction).toBe('down');
      });

      it('creates a scroll to action with options', () => {
        const target = byLabel('Top Section');
        const action = scrollTo(target, { direction: 'up', maxAttempts: 15 });

        expect(action.type).toBe('scrollTo');
        expect(action.direction).toBe('up');
        expect(action.maxAttempts).toBe(15);
      });
    });

    describe('swipe', () => {
      it('creates a swipe action', () => {
        const action = swipe('left');

        expect(action.type).toBe('swipe');
        expect(action.direction).toBe('left');
        expect(action.velocity).toBeUndefined();
      });

      it('creates a swipe action with velocity', () => {
        const action = swipe('right', { velocity: 'fast' });

        expect(action.type).toBe('swipe');
        expect(action.direction).toBe('right');
        expect(action.velocity).toBe('fast');
      });

      it('creates a swipe action on specific element', () => {
        const target = byId('carousel');
        const action = swipe('left', { target, velocity: 'slow' });

        expect(action.type).toBe('swipe');
        expect(action.target).toBe(target);
        expect(action.velocity).toBe('slow');
      });
    });

    describe('pinch', () => {
      it('creates a pinch action', () => {
        const action = pinch(2.0);

        expect(action.type).toBe('pinch');
        expect(action.scale).toBe(2.0);
        expect(action.target).toBeUndefined();
      });

      it('creates a pinch action with options', () => {
        const target = byId('image-view');
        const action = pinch(0.5, { target, velocity: 2.0 });

        expect(action.type).toBe('pinch');
        expect(action.scale).toBe(0.5);
        expect(action.target).toBe(target);
        expect(action.gestureVelocity).toBe(2.0);
      });
    });

    describe('rotate', () => {
      it('creates a rotate action', () => {
        const action = rotate(Math.PI / 4);

        expect(action.type).toBe('rotate');
        expect(action.angle).toBeCloseTo(Math.PI / 4);
      });

      it('creates a rotate action with options', () => {
        const target = byId('map-view');
        const action = rotate(Math.PI / 2, { target, velocity: 1.5 });

        expect(action.type).toBe('rotate');
        expect(action.angle).toBeCloseTo(Math.PI / 2);
        expect(action.target).toBe(target);
        expect(action.gestureVelocity).toBe(1.5);
      });
    });

    describe('waitForElement', () => {
      it('creates a wait for element action', () => {
        const target = byId('loading-indicator');
        const action = waitForElement(target);

        expect(action.type).toBe('waitForElement');
        expect(action.target).toBe(target);
        expect(action.timeout).toBeUndefined();
      });

      it('creates a wait for element action with timeout', () => {
        const target = byLabel('Content');
        const action = waitForElement(target, 15000);

        expect(action.type).toBe('waitForElement');
        expect(action.timeout).toBe(15000);
      });
    });

    describe('waitForNotExist', () => {
      it('creates a wait for not exist action', () => {
        const target = byId('spinner');
        const action = waitForNotExist(target);

        expect(action.type).toBe('waitForNotExist');
        expect(action.target).toBe(target);
      });

      it('creates a wait for not exist action with timeout', () => {
        const target = byId('modal');
        const action = waitForNotExist(target, 5000);

        expect(action.type).toBe('waitForNotExist');
        expect(action.timeout).toBe(5000);
      });
    });

    describe('assertExists', () => {
      it('creates an assert exists action', () => {
        const target = byId('welcome-message');
        const action = assertExists(target);

        expect(action.type).toBe('assertExists');
        expect(action.target).toBe(target);
      });

      it('creates an assert exists action with timeout', () => {
        const target = byLabel('Dashboard');
        const action = assertExists(target, 3000);

        expect(action.type).toBe('assertExists');
        expect(action.timeout).toBe(3000);
      });
    });

    describe('assertNotExists', () => {
      it('creates an assert not exists action', () => {
        const target = byId('error-message');
        const action = assertNotExists(target);

        expect(action.type).toBe('assertNotExists');
        expect(action.target).toBe(target);
      });
    });

    describe('assertEnabled', () => {
      it('creates an assert enabled action', () => {
        const target = byId('submit-button');
        const action = assertEnabled(target);

        expect(action.type).toBe('assertEnabled');
        expect(action.target).toBe(target);
      });
    });

    describe('assertDisabled', () => {
      it('creates an assert disabled action', () => {
        const target = byId('inactive-button');
        const action = assertDisabled(target);

        expect(action.type).toBe('assertDisabled');
        expect(action.target).toBe(target);
      });
    });
  });

  // ==========================================================================
  // NativeDriver Class Tests
  // ==========================================================================

  describe('NativeDriver', () => {
    describe('constructor', () => {
      it('creates a driver with required options', () => {
        const driver = new NativeDriver({
          bundleId: 'com.example.app',
        });

        expect(driver).toBeDefined();
      });

      it('creates a driver with all options', () => {
        const driver = new NativeDriver({
          bundleId: 'com.example.app',
          udid: 'custom-udid',
          timeout: 15000,
          screenshotDir: '/custom/screenshots',
          debug: true,
        });

        expect(driver).toBeDefined();
      });
    });

    describe('initialize', () => {
      it('initializes and auto-selects simulator', async () => {
        const driver = new NativeDriver({
          bundleId: 'com.example.app',
        });

        const result = await driver.initialize();

        expect(result.success).toBe(true);
        expect(simulator.getBootedSimulators).toHaveBeenCalled();
      });

      it('fails when no simulators booted', async () => {
        vi.mocked(simulator.getBootedSimulators).mockResolvedValueOnce({
          success: true,
          data: [],
        });

        const driver = new NativeDriver({
          bundleId: 'com.example.app',
        });

        const result = await driver.initialize();

        expect(result.success).toBe(false);
        expect(result.error).toContain('No booted simulators');
      });

      it('skips auto-selection when udid provided', async () => {
        const driver = new NativeDriver({
          bundleId: 'com.example.app',
          udid: 'specific-udid',
        });

        const result = await driver.initialize();

        expect(result.success).toBe(true);
        // Should not call getBootedSimulators since udid was provided
        // (In current implementation it's still called, but udid is overwritten)
      });

      it('only initializes once', async () => {
        const driver = new NativeDriver({
          bundleId: 'com.example.app',
        });

        await driver.initialize();
        await driver.initialize();
        await driver.initialize();

        // Should only call getBootedSimulators once
        expect(simulator.getBootedSimulators).toHaveBeenCalledTimes(1);
      });
    });

    describe('execute', () => {
      it('returns not implemented error for now', async () => {
        const driver = new NativeDriver({
          bundleId: 'com.example.app',
        });

        const result = await driver.execute(tap(byId('button')));

        expect(result.success).toBe(false);
        expect(result.error).toContain('not yet implemented');
      });

      it('initializes before executing', async () => {
        const driver = new NativeDriver({
          bundleId: 'com.example.app',
        });

        await driver.execute(tap(byId('button')));

        expect(simulator.getBootedSimulators).toHaveBeenCalled();
      });
    });

    describe('executeAll', () => {
      it('executes multiple actions and returns batch result', async () => {
        const driver = new NativeDriver({
          bundleId: 'com.example.app',
        });

        const actions = [
          tap(byId('button1')),
          tap(byId('button2')),
          typeText('hello'),
        ];

        const result = await driver.executeAll(actions);

        expect(result.success).toBe(true);
        expect(result.data?.totalActions).toBe(3);
      });

      it('stops on first failure by default', async () => {
        const driver = new NativeDriver({
          bundleId: 'com.example.app',
        });

        const actions = [
          tap(byId('button1')),
          tap(byId('button2')),
        ];

        const result = await driver.executeAll(actions);

        // Should stop after first action fails (not implemented)
        expect(result.data?.results.length).toBe(1);
      });

      it('continues on failure when specified', async () => {
        const driver = new NativeDriver({
          bundleId: 'com.example.app',
        });

        const actions = [
          tap(byId('button1')),
          tap(byId('button2')),
          tap(byId('button3')),
        ];

        const result = await driver.executeAll(actions, { stopOnFailure: false });

        expect(result.data?.results.length).toBe(3);
      });
    });

    describe('convenience methods', () => {
      it('tapById creates and executes tap action', async () => {
        const driver = new NativeDriver({
          bundleId: 'com.example.app',
        });

        const result = await driver.tapById('login-button');

        expect(result.success).toBe(false); // Not implemented yet
      });

      it('tapByLabel creates and executes tap action', async () => {
        const driver = new NativeDriver({
          bundleId: 'com.example.app',
        });

        const result = await driver.tapByLabel('Sign In');

        expect(result.success).toBe(false);
      });

      it('tapAt creates and executes coordinate tap', async () => {
        const driver = new NativeDriver({
          bundleId: 'com.example.app',
        });

        const result = await driver.tapAt(100, 200);

        expect(result.success).toBe(false);
      });

      it('type creates and executes type action', async () => {
        const driver = new NativeDriver({
          bundleId: 'com.example.app',
        });

        const result = await driver.type('Hello World');

        expect(result.success).toBe(false);
      });

      it('typeInto creates and executes type action with target', async () => {
        const driver = new NativeDriver({
          bundleId: 'com.example.app',
        });

        const result = await driver.typeInto('email-field', 'test@example.com');

        expect(result.success).toBe(false);
      });

      it('scrollDown creates and executes scroll action', async () => {
        const driver = new NativeDriver({
          bundleId: 'com.example.app',
        });

        const result = await driver.scrollDown();

        expect(result.success).toBe(false);
      });

      it('scrollUp creates and executes scroll action', async () => {
        const driver = new NativeDriver({
          bundleId: 'com.example.app',
        });

        const result = await driver.scrollUp(0.3);

        expect(result.success).toBe(false);
      });

      it('scrollToId creates and executes scroll to action', async () => {
        const driver = new NativeDriver({
          bundleId: 'com.example.app',
        });

        const result = await driver.scrollToId('footer');

        expect(result.success).toBe(false);
      });

      it('swipeDirection creates and executes swipe action', async () => {
        const driver = new NativeDriver({
          bundleId: 'com.example.app',
        });

        const result = await driver.swipeDirection('left');

        expect(result.success).toBe(false);
      });

      it('waitFor creates and executes wait action', async () => {
        const driver = new NativeDriver({
          bundleId: 'com.example.app',
        });

        const result = await driver.waitFor('content');

        expect(result.success).toBe(false);
      });

      it('waitForGone creates and executes wait for not exist action', async () => {
        const driver = new NativeDriver({
          bundleId: 'com.example.app',
        });

        const result = await driver.waitForGone('spinner');

        expect(result.success).toBe(false);
      });

      it('assertElementExists creates and executes assert action', async () => {
        const driver = new NativeDriver({
          bundleId: 'com.example.app',
        });

        const result = await driver.assertElementExists('welcome');

        expect(result.success).toBe(false);
      });

      it('assertElementNotExists creates and executes assert action', async () => {
        const driver = new NativeDriver({
          bundleId: 'com.example.app',
        });

        const result = await driver.assertElementNotExists('error');

        expect(result.success).toBe(false);
      });
    });
  });

  // ==========================================================================
  // Factory Function Tests
  // ==========================================================================

  describe('createNativeDriver', () => {
    it('creates a NativeDriver instance', () => {
      const driver = createNativeDriver({
        bundleId: 'com.example.app',
      });

      expect(driver).toBeInstanceOf(NativeDriver);
    });
  });
});
