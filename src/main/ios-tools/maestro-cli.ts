/**
 * iOS Tools - Maestro CLI Integration
 *
 * Functions for detecting and interacting with the Maestro mobile testing CLI.
 * Maestro is an open-source UI automation framework for mobile apps.
 * https://maestro.mobile.dev/
 */

import { execFileNoThrow, ExecResult } from '../utils/execFile';
import { logger } from '../utils/logger';
import { IOSResult } from './types';

const LOG_CONTEXT = '[iOS-MaestroCLI]';

// =============================================================================
// Types
// =============================================================================

/**
 * Maestro CLI installation information
 */
export interface MaestroInfo {
  /** Path to maestro binary */
  path: string;
  /** Maestro version (e.g., "1.36.0") */
  version: string;
  /** Whether CLI is properly installed and working */
  isWorking: boolean;
}

/**
 * Result of Maestro CLI detection
 */
export interface MaestroDetectResult {
  /** Whether Maestro CLI is available */
  available: boolean;
  /** Path to maestro binary if found */
  path?: string;
  /** Maestro version if available */
  version?: string;
  /** Installation instructions if not available */
  installInstructions?: string;
}

// =============================================================================
// Maestro CLI Detection
// =============================================================================

/**
 * Common locations where Maestro CLI might be installed
 */
const MAESTRO_SEARCH_PATHS = [
  // Default installation via curl | bash
  `${process.env.HOME}/.maestro/bin/maestro`,
  // Homebrew installation
  '/opt/homebrew/bin/maestro',
  '/usr/local/bin/maestro',
  // Manual installations
  '/usr/bin/maestro',
];

/**
 * Run the maestro CLI command.
 *
 * @param args - Arguments to pass to maestro
 * @param cwd - Optional working directory
 * @returns ExecResult with stdout, stderr, and exitCode
 */
export async function runMaestro(args: string[], cwd?: string): Promise<ExecResult> {
  // First try to find the maestro binary
  const maestroPath = await findMaestroBinary();

  if (!maestroPath) {
    return {
      stdout: '',
      stderr: 'Maestro CLI not found. Install from https://maestro.mobile.dev/',
      exitCode: 'ENOENT',
    };
  }

  logger.debug(`${LOG_CONTEXT} Running: maestro ${args.join(' ')}`, LOG_CONTEXT);

  const result = await execFileNoThrow(maestroPath, args, cwd);

  if (result.exitCode !== 0) {
    logger.warn(
      `${LOG_CONTEXT} maestro command failed: maestro ${args.join(' ')} (exit: ${result.exitCode})`,
      LOG_CONTEXT
    );
    if (result.stderr) {
      logger.debug(`${LOG_CONTEXT} stderr: ${result.stderr}`, LOG_CONTEXT);
    }
  }

  return result;
}

/**
 * Find the maestro binary location.
 *
 * @returns Path to maestro binary or null if not found
 */
async function findMaestroBinary(): Promise<string | null> {
  // First try 'which' to find maestro in PATH
  const whichResult = await execFileNoThrow('which', ['maestro']);
  if (whichResult.exitCode === 0 && whichResult.stdout.trim()) {
    const path = whichResult.stdout.trim();
    logger.debug(`${LOG_CONTEXT} Found maestro via which: ${path}`, LOG_CONTEXT);
    return path;
  }

  // Try known installation paths
  for (const searchPath of MAESTRO_SEARCH_PATHS) {
    const checkResult = await execFileNoThrow('test', ['-x', searchPath]);
    if (checkResult.exitCode === 0) {
      logger.debug(`${LOG_CONTEXT} Found maestro at: ${searchPath}`, LOG_CONTEXT);
      return searchPath;
    }
  }

  logger.debug(`${LOG_CONTEXT} Maestro binary not found`, LOG_CONTEXT);
  return null;
}

/**
 * Detect Maestro CLI installation.
 *
 * @returns Full detection result with path, version, and instructions
 */
export async function detectMaestroCli(): Promise<IOSResult<MaestroDetectResult>> {
  const maestroPath = await findMaestroBinary();

  if (!maestroPath) {
    return {
      success: true,
      data: {
        available: false,
        installInstructions: getMaestroInstallInstructions(),
      },
    };
  }

  // Get version info
  const versionResult = await execFileNoThrow(maestroPath, ['--version']);

  let version: string | undefined;
  if (versionResult.exitCode === 0) {
    // Parse version from output like "maestro version: 1.36.0"
    const versionMatch = versionResult.stdout.match(/(\d+\.\d+\.\d+)/);
    if (versionMatch) {
      version = versionMatch[1];
    }
  }

  logger.info(`${LOG_CONTEXT} Maestro CLI detected: ${maestroPath} (v${version || 'unknown'})`, LOG_CONTEXT);

  return {
    success: true,
    data: {
      available: true,
      path: maestroPath,
      version,
    },
  };
}

/**
 * Quick check if Maestro CLI is available.
 *
 * @returns true if maestro CLI is installed and executable
 */
export async function isMaestroAvailable(): Promise<boolean> {
  const maestroPath = await findMaestroBinary();
  return maestroPath !== null;
}

/**
 * Get full Maestro CLI information.
 *
 * @returns MaestroInfo with path, version, and working status
 */
export async function getMaestroInfo(): Promise<IOSResult<MaestroInfo>> {
  const detectResult = await detectMaestroCli();

  if (!detectResult.success) {
    return {
      success: false,
      error: detectResult.error,
      errorCode: detectResult.errorCode,
    };
  }

  const detection = detectResult.data!;

  if (!detection.available) {
    return {
      success: false,
      error: 'Maestro CLI is not installed',
      errorCode: 'COMMAND_FAILED',
    };
  }

  // Verify it's working by running a simple command
  const helpResult = await execFileNoThrow(detection.path!, ['--help']);
  const isWorking = helpResult.exitCode === 0;

  return {
    success: true,
    data: {
      path: detection.path!,
      version: detection.version || 'unknown',
      isWorking,
    },
  };
}

/**
 * Validate Maestro CLI meets minimum version requirements.
 *
 * @param minVersion - Minimum required version (e.g., "1.30.0")
 * @returns Success if version is adequate, error otherwise
 */
export async function validateMaestroVersion(minVersion: string): Promise<IOSResult<void>> {
  const detectResult = await detectMaestroCli();

  if (!detectResult.success) {
    return {
      success: false,
      error: detectResult.error,
      errorCode: detectResult.errorCode,
    };
  }

  const detection = detectResult.data!;

  if (!detection.available) {
    return {
      success: false,
      error: `Maestro CLI is not installed. ${detection.installInstructions}`,
      errorCode: 'COMMAND_FAILED',
    };
  }

  if (!detection.version) {
    // Can't determine version, assume it's fine
    logger.warn(`${LOG_CONTEXT} Could not determine Maestro version, proceeding anyway`, LOG_CONTEXT);
    return { success: true };
  }

  // Compare versions
  const installedParts = detection.version.split('.').map(Number);
  const requiredParts = minVersion.split('.').map(Number);

  for (let i = 0; i < Math.max(installedParts.length, requiredParts.length); i++) {
    const installed = installedParts[i] || 0;
    const required = requiredParts[i] || 0;

    if (installed > required) {
      return { success: true };
    }
    if (installed < required) {
      return {
        success: false,
        error: `Maestro CLI version ${detection.version} is below minimum required ${minVersion}. Please update Maestro.`,
        errorCode: 'COMMAND_FAILED',
      };
    }
  }

  return { success: true };
}

// =============================================================================
// Installation Instructions
// =============================================================================

/**
 * Get installation instructions for Maestro CLI.
 *
 * @returns Human-readable installation instructions
 */
function getMaestroInstallInstructions(): string {
  return `Install Maestro CLI:

  macOS/Linux:
    curl -Ls "https://get.maestro.mobile.dev" | bash

  Or with Homebrew:
    brew tap mobile-dev-inc/tap
    brew install maestro

  After installation, restart your terminal or run:
    source ~/.zshrc

  More info: https://maestro.mobile.dev/getting-started/installing-maestro`;
}

/**
 * Get installation instructions as structured data.
 *
 * @returns Installation instructions object
 */
export function getInstallInstructions(): {
  message: string;
  methods: {
    name: string;
    command: string;
  }[];
  documentation: string;
} {
  return {
    message: 'Maestro CLI is not installed',
    methods: [
      {
        name: 'curl (recommended)',
        command: 'curl -Ls "https://get.maestro.mobile.dev" | bash',
      },
      {
        name: 'Homebrew',
        command: 'brew tap mobile-dev-inc/tap && brew install maestro',
      },
    ],
    documentation: 'https://maestro.mobile.dev/getting-started/installing-maestro',
  };
}

// =============================================================================
// Installation
// =============================================================================

/**
 * Installation method for Maestro CLI
 */
export type MaestroInstallMethod = 'homebrew' | 'curl';

/**
 * Options for installing Maestro CLI
 */
export interface InstallMaestroOptions {
  /** Installation method to use */
  method: MaestroInstallMethod;
}

/**
 * Result of Maestro CLI installation
 */
export interface InstallMaestroResult {
  /** Whether installation was successful */
  success: boolean;
  /** Path to installed maestro binary */
  path?: string;
  /** Installed version */
  version?: string;
  /** Error message if installation failed */
  error?: string;
  /** Installation method used */
  method: MaestroInstallMethod;
  /** Installation output */
  output: string;
}

/**
 * Install Maestro CLI if not already installed.
 *
 * @param options - Installation options
 * @returns Installation result
 */
export async function installMaestro(
  options: InstallMaestroOptions
): Promise<IOSResult<InstallMaestroResult>> {
  const { method } = options;

  logger.info(`${LOG_CONTEXT} Installing Maestro CLI via ${method}`, LOG_CONTEXT);

  // Check if already installed
  const alreadyInstalled = await isMaestroAvailable();
  if (alreadyInstalled) {
    const infoResult = await getMaestroInfo();
    if (infoResult.success && infoResult.data) {
      logger.info(`${LOG_CONTEXT} Maestro CLI already installed at ${infoResult.data.path}`, LOG_CONTEXT);
      return {
        success: true,
        data: {
          success: true,
          path: infoResult.data.path,
          version: infoResult.data.version,
          method,
          output: 'Already installed',
        },
      };
    }
  }

  let result: ExecResult;

  if (method === 'homebrew') {
    // First tap the homebrew repository
    logger.debug(`${LOG_CONTEXT} Tapping mobile-dev-inc/tap`, LOG_CONTEXT);
    const tapResult = await execFileNoThrow('brew', ['tap', 'mobile-dev-inc/tap']);
    if (tapResult.exitCode !== 0) {
      return {
        success: false,
        error: `Failed to tap mobile-dev-inc/tap: ${tapResult.stderr}`,
        errorCode: 'COMMAND_FAILED',
      };
    }

    // Then install maestro
    logger.debug(`${LOG_CONTEXT} Installing maestro via brew`, LOG_CONTEXT);
    result = await execFileNoThrow('brew', ['install', 'maestro']);
  } else {
    // curl installation
    // Note: We can't use execFileNoThrow for piped commands, so we need to use a shell
    // However, for security, we'll download and then run separately
    logger.debug(`${LOG_CONTEXT} Installing maestro via curl`, LOG_CONTEXT);

    // Download the installer script to a temp file
    const tempScript = `/tmp/maestro-install-${Date.now()}.sh`;
    const curlResult = await execFileNoThrow(
      'curl',
      ['-Ls', '-o', tempScript, 'https://get.maestro.mobile.dev']
    );

    if (curlResult.exitCode !== 0) {
      return {
        success: false,
        error: `Failed to download installer: ${curlResult.stderr}`,
        errorCode: 'COMMAND_FAILED',
      };
    }

    // Make script executable and run it
    await execFileNoThrow('chmod', ['+x', tempScript]);
    result = await execFileNoThrow('bash', [tempScript]);

    // Clean up temp script
    await execFileNoThrow('rm', ['-f', tempScript]);
  }

  const output = result.stdout + (result.stderr ? '\n' + result.stderr : '');

  if (result.exitCode !== 0) {
    logger.error(`${LOG_CONTEXT} Maestro installation failed: ${result.stderr}`, LOG_CONTEXT);
    return {
      success: false,
      error: `Installation failed: ${result.stderr || 'Unknown error'}`,
      errorCode: 'COMMAND_FAILED',
    };
  }

  // Verify installation succeeded
  const verifyResult = await detectMaestroCli();
  if (!verifyResult.success || !verifyResult.data?.available) {
    return {
      success: false,
      error: 'Installation completed but maestro binary not found. You may need to restart your terminal.',
      errorCode: 'COMMAND_FAILED',
    };
  }

  logger.info(
    `${LOG_CONTEXT} Maestro CLI installed successfully: v${verifyResult.data.version}`,
    LOG_CONTEXT
  );

  return {
    success: true,
    data: {
      success: true,
      path: verifyResult.data.path,
      version: verifyResult.data.version,
      method,
      output,
    },
  };
}

// =============================================================================
// Setup Validation
// =============================================================================

/**
 * Result of Maestro setup validation
 */
export interface MaestroSetupValidation {
  /** Whether setup is valid */
  valid: boolean;
  /** Whether CLI is installed */
  cliInstalled: boolean;
  /** CLI version if installed */
  version?: string;
  /** Whether iOS driver is working */
  iosDriverWorking: boolean;
  /** Whether a simulator is available for testing */
  simulatorAvailable: boolean;
  /** Issues found during validation */
  issues: string[];
  /** Recommendations to fix issues */
  recommendations: string[];
}

/**
 * Validate that Maestro Mobile is properly set up for iOS testing.
 *
 * Checks:
 * 1. Maestro CLI is installed
 * 2. iOS driver is functional
 * 3. A simulator is available
 *
 * @returns Validation result with issues and recommendations
 */
export async function validateMaestroSetup(): Promise<IOSResult<MaestroSetupValidation>> {
  logger.info(`${LOG_CONTEXT} Validating Maestro setup`, LOG_CONTEXT);

  const issues: string[] = [];
  const recommendations: string[] = [];
  let cliInstalled = false;
  let version: string | undefined;
  let iosDriverWorking = false;
  let simulatorAvailable = false;

  // Check if CLI is installed
  const detectResult = await detectMaestroCli();
  if (detectResult.success && detectResult.data?.available) {
    cliInstalled = true;
    version = detectResult.data.version;
    logger.debug(`${LOG_CONTEXT} CLI installed: v${version}`, LOG_CONTEXT);
  } else {
    issues.push('Maestro CLI is not installed');
    recommendations.push('Install Maestro CLI: curl -Ls "https://get.maestro.mobile.dev" | bash');
  }

  // Check for booted simulators
  const { getBootedSimulators } = await import('./simulator');
  const simulatorsResult = await getBootedSimulators();
  if (simulatorsResult.success && simulatorsResult.data && simulatorsResult.data.length > 0) {
    simulatorAvailable = true;
    logger.debug(
      `${LOG_CONTEXT} Found ${simulatorsResult.data.length} booted simulator(s)`,
      LOG_CONTEXT
    );
  } else {
    issues.push('No booted iOS simulators found');
    recommendations.push('Boot a simulator: xcrun simctl boot "iPhone 15 Pro"');
  }

  // Test iOS driver by running a simple command
  if (cliInstalled && simulatorAvailable) {
    // Use maestro doctor or a simple hierarchy dump to verify driver works
    const doctorResult = await runMaestro(['doctor']);
    if (doctorResult.exitCode === 0) {
      iosDriverWorking = true;
      logger.debug(`${LOG_CONTEXT} iOS driver is working`, LOG_CONTEXT);
    } else {
      // Check the output for iOS-specific errors
      const output = doctorResult.stdout + doctorResult.stderr;
      if (output.toLowerCase().includes('ios')) {
        issues.push('iOS driver may have issues');
        if (output.toLowerCase().includes('xcode')) {
          recommendations.push('Ensure Xcode and command line tools are properly installed');
        }
      }

      // Even if doctor fails, driver might still work for testing
      // Try running hierarchy as a more direct test
      const hierResult = await runMaestro(['hierarchy']);
      if (hierResult.exitCode === 0 || hierResult.stdout.includes('View') || hierResult.stdout.includes('Window')) {
        iosDriverWorking = true;
      } else {
        issues.push('iOS driver is not responding correctly');
        recommendations.push('Ensure the iOS simulator is fully booted and an app is running');
      }
    }
  }

  const valid = cliInstalled && iosDriverWorking && simulatorAvailable;

  if (valid) {
    logger.info(`${LOG_CONTEXT} Maestro setup is valid`, LOG_CONTEXT);
  } else {
    logger.warn(`${LOG_CONTEXT} Maestro setup has issues: ${issues.join(', ')}`, LOG_CONTEXT);
  }

  return {
    success: true,
    data: {
      valid,
      cliInstalled,
      version,
      iosDriverWorking,
      simulatorAvailable,
      issues,
      recommendations,
    },
  };
}
