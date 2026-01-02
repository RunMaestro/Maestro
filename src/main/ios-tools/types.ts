/**
 * iOS Tools - TypeScript Interfaces
 *
 * Core type definitions for all iOS tooling operations.
 * These types provide a clean API surface for Xcode, simulator,
 * screenshot capture, and log collection operations.
 */

// =============================================================================
// Common Result Types
// =============================================================================

/**
 * Generic result type for all iOS operations.
 * Success/failure pattern with typed data.
 */
export interface IOSResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  errorCode?: string;
}

// =============================================================================
// Xcode Types
// =============================================================================

/**
 * Xcode installation information
 */
export interface XcodeInfo {
  /** Path to Xcode.app/Contents/Developer */
  path: string;
  /** Xcode version (e.g., "15.4") */
  version: string;
  /** Build number (e.g., "15F31d") */
  build: string;
  /** Whether command line tools are installed */
  commandLineToolsInstalled: boolean;
}

/**
 * iOS SDK information
 */
export interface IOSSDK {
  /** SDK name (e.g., "iphonesimulator17.5") */
  name: string;
  /** SDK version (e.g., "17.5") */
  version: string;
  /** SDK type */
  type: 'iphoneos' | 'iphonesimulator';
  /** Full path to SDK */
  path: string;
}

// =============================================================================
// Simulator Types
// =============================================================================

/**
 * Simulator device state
 */
export type SimulatorState = 'Shutdown' | 'Booted' | 'Booting' | 'ShuttingDown' | 'Creating';

/**
 * Simulator device information
 */
export interface Simulator {
  /** Unique device identifier (UUID) */
  udid: string;
  /** Device name (e.g., "iPhone 15 Pro") */
  name: string;
  /** Device state */
  state: SimulatorState;
  /** Whether this is an available (usable) device */
  isAvailable: boolean;
  /** Runtime identifier (e.g., "com.apple.CoreSimulator.SimRuntime.iOS-17-5") */
  runtime: string;
  /** Parsed iOS version (e.g., "17.5") */
  iosVersion: string;
  /** Device type identifier (e.g., "com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro") */
  deviceType: string;
  /** Reason if not available */
  availabilityError?: string;
}

/**
 * Simulator list organized by runtime
 */
export interface SimulatorsByRuntime {
  [runtimeId: string]: Simulator[];
}

/**
 * Options for booting a simulator
 */
export interface BootSimulatorOptions {
  /** Simulator UDID to boot */
  udid: string;
  /** Timeout in milliseconds for boot to complete (default: 60000) */
  timeout?: number;
  /** Whether to wait for full boot completion */
  waitForBoot?: boolean;
}

/**
 * Options for launching an app
 */
export interface LaunchAppOptions {
  /** Simulator UDID */
  udid: string;
  /** App bundle identifier */
  bundleId: string;
  /** Optional launch arguments */
  args?: string[];
  /** Optional environment variables */
  env?: Record<string, string>;
  /** Whether to wait for app to launch (default: true) */
  waitForLaunch?: boolean;
}

/**
 * Options for installing an app
 */
export interface InstallAppOptions {
  /** Simulator UDID */
  udid: string;
  /** Path to .app bundle */
  appPath: string;
}

// =============================================================================
// Screenshot/Capture Types
// =============================================================================

/**
 * Options for capturing a screenshot
 */
export interface ScreenshotOptions {
  /** Simulator UDID */
  udid: string;
  /** Output path for the screenshot (PNG format) */
  outputPath: string;
  /** Screenshot type (default: 'display') */
  type?: 'window' | 'display';
  /** Display to capture (for multi-display setups) */
  display?: 'internal' | 'external';
  /** Mask type for status bar, etc. */
  mask?: 'ignored' | 'alpha' | 'black';
}

/**
 * Result of a screenshot capture
 */
export interface ScreenshotResult {
  /** Path to the captured screenshot */
  path: string;
  /** File size in bytes */
  size: number;
  /** Capture timestamp */
  timestamp: Date;
}

/**
 * Options for video recording
 */
export interface RecordingOptions {
  /** Simulator UDID */
  udid: string;
  /** Output path for the video file */
  outputPath: string;
  /** Video codec (default: 'h264') */
  codec?: 'h264' | 'hevc';
  /** Force to use a specific display */
  display?: 'internal' | 'external';
  /** Mask type */
  mask?: 'ignored' | 'alpha' | 'black';
}

// =============================================================================
// Log Types
// =============================================================================

/**
 * Log entry from system log
 */
export interface LogEntry {
  /** Log timestamp */
  timestamp: Date;
  /** Process name */
  process: string;
  /** Process ID */
  pid?: number;
  /** Log level */
  level: 'default' | 'info' | 'debug' | 'error' | 'fault';
  /** Log message */
  message: string;
  /** Subsystem (e.g., "com.apple.UIKit") */
  subsystem?: string;
  /** Category within subsystem */
  category?: string;
}

/**
 * Options for retrieving system logs
 */
export interface SystemLogOptions {
  /** Simulator UDID */
  udid: string;
  /** Start time for logs (ISO string or Date) */
  since?: string | Date;
  /** End time for logs */
  until?: string | Date;
  /** Log level to filter */
  level?: 'default' | 'info' | 'debug' | 'error' | 'fault';
  /** Process name to filter */
  process?: string;
  /** Predicate for filtering (NSPredicate format) */
  predicate?: string;
  /** Maximum number of entries to return */
  limit?: number;
}

/**
 * Crash report information
 */
export interface CrashReport {
  /** Crash report identifier */
  id: string;
  /** Process name that crashed */
  process: string;
  /** Bundle ID if available */
  bundleId?: string;
  /** Crash timestamp */
  timestamp: Date;
  /** Exception type */
  exceptionType?: string;
  /** Exception message */
  exceptionMessage?: string;
  /** Path to full crash log file */
  path: string;
  /** Raw crash log content (may be truncated) */
  content?: string;
}

/**
 * Options for retrieving crash logs
 */
export interface CrashLogOptions {
  /** Simulator UDID */
  udid: string;
  /** Filter by bundle ID */
  bundleId?: string;
  /** Only get crashes since this time */
  since?: Date;
  /** Maximum number of crash reports to return */
  limit?: number;
  /** Whether to include full crash content */
  includeContent?: boolean;
}

/**
 * Options for streaming real-time logs
 */
export interface StreamLogOptions {
  /** Simulator UDID */
  udid: string;
  /** Log level to filter */
  level?: 'default' | 'info' | 'debug' | 'error' | 'fault';
  /** Process name to filter */
  process?: string;
  /** Predicate for filtering (NSPredicate format) */
  predicate?: string;
  /** Subsystem to filter (e.g., "com.apple.UIKit") */
  subsystem?: string;
}

/**
 * Handle returned from streamLog for controlling the stream
 */
export interface LogStreamHandle {
  /** Unique identifier for this stream */
  id: string;
  /** Stop the log stream */
  stop: () => void;
  /** Whether the stream is active */
  isActive: () => boolean;
}

// =============================================================================
// App Container Types
// =============================================================================

/**
 * App container types
 */
export type ContainerType = 'app' | 'data' | 'groups';

/**
 * App container path information
 */
export interface AppContainer {
  /** Container type */
  type: ContainerType;
  /** Full path to container */
  path: string;
  /** Bundle ID */
  bundleId: string;
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * iOS-specific error codes
 */
export type IOSErrorCode =
  | 'XCODE_NOT_FOUND'
  | 'XCODE_VERSION_UNSUPPORTED'
  | 'SIMULATOR_NOT_FOUND'
  | 'SIMULATOR_NOT_BOOTED'
  | 'SIMULATOR_BOOT_FAILED'
  | 'APP_NOT_INSTALLED'
  | 'APP_INSTALL_FAILED'
  | 'APP_LAUNCH_FAILED'
  | 'SCREENSHOT_FAILED'
  | 'RECORDING_FAILED'
  | 'LOG_COLLECTION_FAILED'
  | 'BUILD_FAILED'
  | 'TEST_FAILED'
  | 'TIMEOUT'
  | 'COMMAND_FAILED'
  | 'PARSE_ERROR'
  | 'UNKNOWN';

/**
 * iOS operation error
 */
export interface IOSError {
  /** Error code */
  code: IOSErrorCode;
  /** Human-readable message */
  message: string;
  /** Underlying error details */
  details?: string;
  /** Command that was executed (if applicable) */
  command?: string;
  /** Exit code if command failed */
  exitCode?: number | string;
}

// =============================================================================
// Raw simctl Output Types (for parsing)
// =============================================================================

/**
 * Raw device info from simctl list devices --json
 */
export interface RawSimctlDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
  availabilityError?: string;
  deviceTypeIdentifier: string;
}

/**
 * Raw simctl list output structure
 */
export interface RawSimctlListOutput {
  devices: {
    [runtimeId: string]: RawSimctlDevice[];
  };
}
