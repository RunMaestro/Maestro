/**
 * iOS Tools - Native XCUITest Driver
 *
 * TypeScript wrapper for the XCUITest-based action runner.
 * Provides a high-level API for executing UI actions via native XCUITest.
 *
 * This driver uses the Swift code in xcuitest-driver/ to execute actions
 * on iOS simulators, offering more reliable and faster execution than
 * coordinate-based approaches.
 */

import { IOSResult } from './types';
import { logger } from '../utils/logger';
import { getBootedSimulators } from './simulator';

const LOG_CONTEXT = '[iOS-NativeDriver]';

// =============================================================================
// Types
// =============================================================================

/**
 * Target specification for finding elements
 */
export interface ActionTarget {
  /** How to find the target: identifier, label, text, predicate, coordinates, type */
  type: 'identifier' | 'label' | 'text' | 'predicate' | 'coordinates' | 'type';
  /** The value to match */
  value: string;
  /** Optional element type filter */
  elementType?: string;
  /** Optional index when multiple elements match (0-based) */
  index?: number;
  /** Optional timeout for finding element (milliseconds) */
  timeout?: number;
}

/**
 * Direction for scroll/swipe actions
 */
export type SwipeDirection = 'up' | 'down' | 'left' | 'right';

/**
 * Velocity for swipe gestures
 */
export type SwipeVelocity = 'slow' | 'normal' | 'fast';

/**
 * Action types supported by the native driver
 */
export type ActionType =
  | 'tap'
  | 'doubleTap'
  | 'longPress'
  | 'typeText'
  | 'clearText'
  | 'scroll'
  | 'scrollTo'
  | 'swipe'
  | 'pinch'
  | 'rotate'
  | 'waitForElement'
  | 'waitForNotExist'
  | 'assertExists'
  | 'assertNotExists'
  | 'assertEnabled'
  | 'assertDisabled';

/**
 * Status codes for action results
 */
export type ActionStatus =
  | 'success'
  | 'failed'
  | 'timeout'
  | 'notFound'
  | 'notHittable'
  | 'notEnabled'
  | 'error';

/**
 * Action request to send to the native driver
 */
export interface ActionRequest {
  type: ActionType;
  target?: ActionTarget;
  text?: string;
  duration?: number;
  timeout?: number;
  direction?: SwipeDirection;
  velocity?: SwipeVelocity;
  /** Gesture velocity for pinch/rotate (number, different from swipe velocity) */
  gestureVelocity?: number;
  scale?: number;
  angle?: number;
  distance?: number;
  maxAttempts?: number;
  clearFirst?: boolean;
  offsetX?: number;
  offsetY?: number;
}

/**
 * Element information from action result
 */
export interface ElementInfo {
  type: string;
  identifier?: string;
  label?: string;
  value?: string;
  frame?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  isEnabled: boolean;
  isHittable: boolean;
}

/**
 * Details about action execution
 */
export interface ActionDetails {
  element?: ElementInfo;
  suggestions?: string[];
  typedText?: string;
  scrollAttempts?: number;
  direction?: string;
  screenshotPath?: string;
}

/**
 * Result of a single action execution
 */
export interface ActionResult {
  success: boolean;
  status: ActionStatus;
  actionType: ActionType;
  duration: number;
  error?: string;
  details?: ActionDetails;
  timestamp: string;
}

/**
 * Result of executing multiple actions
 */
export interface BatchActionResult {
  allPassed: boolean;
  totalActions: number;
  passedActions: number;
  failedActions: number;
  totalDuration: number;
  results: ActionResult[];
  timestamp: string;
}

/**
 * Options for the native driver
 */
export interface NativeDriverOptions {
  /** Simulator UDID (auto-detects if not provided) */
  udid?: string;
  /** App bundle identifier to target */
  bundleId: string;
  /** Default timeout for element operations (ms, default: 10000) */
  timeout?: number;
  /** Directory for screenshots */
  screenshotDir?: string;
  /** Enable debug logging */
  debug?: boolean;
}

// =============================================================================
// Target Helpers
// =============================================================================

/**
 * Create a target by accessibility identifier
 */
export function byId(identifier: string, elementType?: string): ActionTarget {
  return { type: 'identifier', value: identifier, elementType };
}

/**
 * Create a target by accessibility label
 */
export function byLabel(label: string, elementType?: string): ActionTarget {
  return { type: 'label', value: label, elementType };
}

/**
 * Create a target by text content
 */
export function byText(text: string): ActionTarget {
  return { type: 'text', value: text };
}

/**
 * Create a target by NSPredicate
 */
export function byPredicate(predicate: string, elementType?: string): ActionTarget {
  return { type: 'predicate', value: predicate, elementType };
}

/**
 * Create a target by screen coordinates
 */
export function byCoordinates(x: number, y: number): ActionTarget {
  return { type: 'coordinates', value: `${x},${y}` };
}

/**
 * Create a target by element type and optional index
 */
export function byType(elementType: string, index?: number): ActionTarget {
  return { type: 'type', value: elementType, index };
}

// =============================================================================
// Action Helpers
// =============================================================================

/**
 * Create a tap action
 */
export function tap(target: ActionTarget, options?: { offsetX?: number; offsetY?: number }): ActionRequest {
  return {
    type: 'tap',
    target,
    offsetX: options?.offsetX,
    offsetY: options?.offsetY,
  };
}

/**
 * Create a double tap action
 */
export function doubleTap(target: ActionTarget): ActionRequest {
  return { type: 'doubleTap', target };
}

/**
 * Create a long press action
 */
export function longPress(target: ActionTarget, duration = 1.0): ActionRequest {
  return { type: 'longPress', target, duration };
}

/**
 * Create a type text action
 */
export function typeText(
  text: string,
  options?: { target?: ActionTarget; clearFirst?: boolean }
): ActionRequest {
  return {
    type: 'typeText',
    text,
    target: options?.target,
    clearFirst: options?.clearFirst,
  };
}

/**
 * Create a clear text action
 */
export function clearText(target: ActionTarget): ActionRequest {
  return { type: 'clearText', target };
}

/**
 * Create a scroll action
 */
export function scroll(
  direction: SwipeDirection,
  options?: { target?: ActionTarget; distance?: number }
): ActionRequest {
  return {
    type: 'scroll',
    direction,
    target: options?.target,
    distance: options?.distance,
  };
}

/**
 * Create a scroll-to action
 */
export function scrollTo(
  target: ActionTarget,
  options?: { direction?: SwipeDirection; maxAttempts?: number }
): ActionRequest {
  return {
    type: 'scrollTo',
    target,
    direction: options?.direction || 'down',
    maxAttempts: options?.maxAttempts,
  };
}

/**
 * Create a swipe action
 */
export function swipe(
  direction: SwipeDirection,
  options?: { target?: ActionTarget; velocity?: SwipeVelocity }
): ActionRequest {
  return {
    type: 'swipe',
    direction,
    target: options?.target,
    velocity: options?.velocity,
  };
}

/**
 * Create a pinch action
 */
export function pinch(scale: number, options?: { target?: ActionTarget; velocity?: number }): ActionRequest {
  return {
    type: 'pinch',
    scale,
    target: options?.target,
    gestureVelocity: options?.velocity,
  };
}

/**
 * Create a rotate action
 */
export function rotate(angle: number, options?: { target?: ActionTarget; velocity?: number }): ActionRequest {
  return {
    type: 'rotate',
    angle,
    target: options?.target,
    gestureVelocity: options?.velocity,
  };
}

/**
 * Create a wait for element action
 */
export function waitForElement(target: ActionTarget, timeout?: number): ActionRequest {
  return { type: 'waitForElement', target, timeout };
}

/**
 * Create a wait for not exist action
 */
export function waitForNotExist(target: ActionTarget, timeout?: number): ActionRequest {
  return { type: 'waitForNotExist', target, timeout };
}

/**
 * Create an assert exists action
 */
export function assertExists(target: ActionTarget, timeout?: number): ActionRequest {
  return { type: 'assertExists', target, timeout };
}

/**
 * Create an assert not exists action
 */
export function assertNotExists(target: ActionTarget): ActionRequest {
  return { type: 'assertNotExists', target };
}

/**
 * Create an assert enabled action
 */
export function assertEnabled(target: ActionTarget): ActionRequest {
  return { type: 'assertEnabled', target };
}

/**
 * Create an assert disabled action
 */
export function assertDisabled(target: ActionTarget): ActionRequest {
  return { type: 'assertDisabled', target };
}

// =============================================================================
// Native Driver Class
// =============================================================================

/**
 * Native XCUITest driver for executing UI actions.
 *
 * This driver creates a temporary XCUITest project, builds it,
 * and runs actions through the XCUITest framework for reliable
 * element interaction.
 */
export class NativeDriver {
  private options: Required<Omit<NativeDriverOptions, 'udid'>> & { udid?: string };
  private initialized = false;

  constructor(options: NativeDriverOptions) {
    this.options = {
      bundleId: options.bundleId,
      udid: options.udid,
      timeout: options.timeout ?? 10000,
      screenshotDir: options.screenshotDir ?? '',
      debug: options.debug ?? false,
    };
  }

  /**
   * Initialize the driver (verify simulator, etc.)
   */
  async initialize(): Promise<IOSResult<void>> {
    if (this.initialized) {
      return { success: true };
    }

    // Determine simulator UDID
    if (!this.options.udid) {
      const bootedResult = await getBootedSimulators();
      if (!bootedResult.success || !bootedResult.data || bootedResult.data.length === 0) {
        return {
          success: false,
          error: 'No booted simulators found. Please boot a simulator first.',
          errorCode: 'SIMULATOR_NOT_BOOTED',
        };
      }
      this.options.udid = bootedResult.data[0].udid;
      logger.debug(`${LOG_CONTEXT} Auto-selected simulator: ${this.options.udid}`, LOG_CONTEXT);
    }

    this.initialized = true;
    logger.info(`${LOG_CONTEXT} Initialized for ${this.options.bundleId}`, LOG_CONTEXT);

    return { success: true };
  }

  /**
   * Execute a single action
   */
  async execute(action: ActionRequest): Promise<IOSResult<ActionResult>> {
    const initResult = await this.initialize();
    if (!initResult.success) {
      return {
        success: false,
        error: initResult.error,
        errorCode: initResult.errorCode,
      };
    }

    logger.debug(`${LOG_CONTEXT} Executing action: ${action.type}`, LOG_CONTEXT);

    // For now, this returns a placeholder - actual implementation
    // requires building and running the XCUITest project
    // This will be fully implemented when XCUITest project creation is ready

    return {
      success: false,
      error: 'Native driver execution not yet implemented. Use Maestro Mobile CLI (/ios.run_flow) for now.',
      errorCode: 'COMMAND_FAILED',
    };
  }

  /**
   * Execute multiple actions in sequence
   */
  async executeAll(
    actions: ActionRequest[],
    options?: { stopOnFailure?: boolean }
  ): Promise<IOSResult<BatchActionResult>> {
    const initResult = await this.initialize();
    if (!initResult.success) {
      return {
        success: false,
        error: initResult.error,
        errorCode: initResult.errorCode,
      };
    }

    const stopOnFailure = options?.stopOnFailure ?? true;
    const results: ActionResult[] = [];
    const startTime = Date.now();

    for (const action of actions) {
      const result = await this.execute(action);

      if (result.success && result.data) {
        results.push(result.data);

        if (!result.data.success && stopOnFailure) {
          break;
        }
      } else {
        // Create a failed result for actions that couldn't execute
        results.push({
          success: false,
          status: 'error',
          actionType: action.type,
          duration: 0,
          error: result.error || 'Action execution failed',
          timestamp: new Date().toISOString(),
        });

        if (stopOnFailure) {
          break;
        }
      }
    }

    const totalDuration = Date.now() - startTime;
    const passedActions = results.filter((r) => r.success).length;

    return {
      success: true,
      data: {
        allPassed: passedActions === results.length,
        totalActions: actions.length,
        passedActions,
        failedActions: results.length - passedActions,
        totalDuration,
        results,
        timestamp: new Date().toISOString(),
      },
    };
  }

  // =============================================================================
  // Convenience Methods
  // =============================================================================

  /**
   * Tap an element by identifier
   */
  async tapById(identifier: string): Promise<IOSResult<ActionResult>> {
    return this.execute(tap(byId(identifier)));
  }

  /**
   * Tap an element by label
   */
  async tapByLabel(label: string): Promise<IOSResult<ActionResult>> {
    return this.execute(tap(byLabel(label)));
  }

  /**
   * Tap at screen coordinates
   */
  async tapAt(x: number, y: number): Promise<IOSResult<ActionResult>> {
    return this.execute(tap(byCoordinates(x, y)));
  }

  /**
   * Type text into the focused element
   */
  async type(text: string): Promise<IOSResult<ActionResult>> {
    return this.execute(typeText(text));
  }

  /**
   * Type text into an element by identifier
   */
  async typeInto(identifier: string, text: string, clearFirst = false): Promise<IOSResult<ActionResult>> {
    return this.execute(typeText(text, { target: byId(identifier), clearFirst }));
  }

  /**
   * Scroll in a direction
   */
  async scrollDown(distance = 0.5): Promise<IOSResult<ActionResult>> {
    return this.execute(scroll('down', { distance }));
  }

  /**
   * Scroll up
   */
  async scrollUp(distance = 0.5): Promise<IOSResult<ActionResult>> {
    return this.execute(scroll('up', { distance }));
  }

  /**
   * Scroll until element with identifier is visible
   */
  async scrollToId(identifier: string, maxAttempts = 10): Promise<IOSResult<ActionResult>> {
    return this.execute(scrollTo(byId(identifier), { maxAttempts }));
  }

  /**
   * Swipe in a direction
   */
  async swipeDirection(direction: SwipeDirection): Promise<IOSResult<ActionResult>> {
    return this.execute(swipe(direction));
  }

  /**
   * Wait for an element to exist
   */
  async waitFor(identifier: string, timeout?: number): Promise<IOSResult<ActionResult>> {
    return this.execute(waitForElement(byId(identifier), timeout ?? this.options.timeout));
  }

  /**
   * Wait for an element to disappear
   */
  async waitForGone(identifier: string, timeout?: number): Promise<IOSResult<ActionResult>> {
    return this.execute(waitForNotExist(byId(identifier), timeout ?? this.options.timeout));
  }

  /**
   * Assert an element exists
   */
  async assertElementExists(identifier: string): Promise<IOSResult<ActionResult>> {
    return this.execute(assertExists(byId(identifier)));
  }

  /**
   * Assert an element does not exist
   */
  async assertElementNotExists(identifier: string): Promise<IOSResult<ActionResult>> {
    return this.execute(assertNotExists(byId(identifier)));
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new native driver instance
 */
export function createNativeDriver(options: NativeDriverOptions): NativeDriver {
  return new NativeDriver(options);
}

