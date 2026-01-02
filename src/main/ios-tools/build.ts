/**
 * iOS Tools - Xcode Build Operations
 *
 * Functions for building Xcode projects and workspaces.
 * Provides TypeScript API for xcodebuild commands.
 */

import * as path from 'path';
import * as fs from 'fs';
import { IOSResult } from './types';
import { runXcodebuild, parseJson } from './utils';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[iOS-Build]';

// =============================================================================
// Types
// =============================================================================

/**
 * Type of Xcode project container
 */
export type ProjectType = 'workspace' | 'project';

/**
 * Information about a detected Xcode project
 */
export interface XcodeProject {
  /** Full path to the project or workspace */
  path: string;
  /** Name of the project (without extension) */
  name: string;
  /** Type: workspace or project */
  type: ProjectType;
}

/**
 * Xcode scheme information
 */
export interface XcodeScheme {
  /** Scheme name */
  name: string;
  /** Whether the scheme is shared */
  shared?: boolean;
}

/**
 * Xcode target information
 */
export interface XcodeTarget {
  /** Target name */
  name: string;
  /** Target type (e.g., "application", "framework", "test") */
  type?: string;
}

/**
 * Build configuration options
 */
export interface BuildOptions {
  /** Path to project or workspace */
  projectPath: string;
  /** Scheme to build */
  scheme: string;
  /** Destination - simulator UDID or "generic/platform=iOS Simulator" */
  destination?: string;
  /** Build configuration (default: Debug) */
  configuration?: 'Debug' | 'Release' | string;
  /** Derived data path override */
  derivedDataPath?: string;
  /** Additional xcodebuild arguments */
  additionalArgs?: string[];
  /** Working directory for the command */
  cwd?: string;
  /** Whether to build for testing */
  buildForTesting?: boolean;
  /** Whether to clean before building */
  clean?: boolean;
}

/**
 * Build result information
 */
export interface BuildResult {
  /** Whether the build succeeded */
  success: boolean;
  /** Path to the built app bundle (if applicable) */
  appPath?: string;
  /** Derived data path used */
  derivedDataPath: string;
  /** Build duration in milliseconds */
  duration: number;
  /** Warnings encountered during build */
  warnings: string[];
  /** Errors encountered during build */
  errors: string[];
}

/**
 * Build progress callback
 */
export type BuildProgressCallback = (
  progress: BuildProgress
) => void;

/**
 * Build progress information
 */
export interface BuildProgress {
  /** Current phase (e.g., "Compiling", "Linking") */
  phase: string;
  /** Current file being processed */
  file?: string;
  /** Percentage complete (0-100) if known */
  percentage?: number;
}

// =============================================================================
// Project Detection
// =============================================================================

/**
 * Detect Xcode project or workspace in a directory.
 * Prefers .xcworkspace over .xcodeproj if both exist.
 *
 * @param directory - Directory to search in
 * @returns Detected project info or error
 */
export async function detectProject(directory: string): Promise<IOSResult<XcodeProject>> {
  logger.info(`${LOG_CONTEXT} Detecting project in: ${directory}`, LOG_CONTEXT);

  // Check if directory exists
  if (!fs.existsSync(directory)) {
    return {
      success: false,
      error: `Directory does not exist: ${directory}`,
      errorCode: 'COMMAND_FAILED',
    };
  }

  const entries = fs.readdirSync(directory);

  // Look for workspaces first (preferred)
  const workspaces = entries.filter((e) => e.endsWith('.xcworkspace'));
  if (workspaces.length > 0) {
    // Prefer non-Pods workspace if multiple exist
    const workspace = workspaces.find((w) => !w.includes('Pods')) || workspaces[0];
    const fullPath = path.join(directory, workspace);

    logger.info(`${LOG_CONTEXT} Found workspace: ${workspace}`, LOG_CONTEXT);
    return {
      success: true,
      data: {
        path: fullPath,
        name: workspace.replace('.xcworkspace', ''),
        type: 'workspace',
      },
    };
  }

  // Look for projects
  const projects = entries.filter((e) => e.endsWith('.xcodeproj'));
  if (projects.length > 0) {
    const project = projects[0];
    const fullPath = path.join(directory, project);

    logger.info(`${LOG_CONTEXT} Found project: ${project}`, LOG_CONTEXT);
    return {
      success: true,
      data: {
        path: fullPath,
        name: project.replace('.xcodeproj', ''),
        type: 'project',
      },
    };
  }

  return {
    success: false,
    error: `No Xcode project or workspace found in: ${directory}`,
    errorCode: 'COMMAND_FAILED',
  };
}

// =============================================================================
// Scheme & Target Listing
// =============================================================================

/**
 * List available schemes in a project or workspace.
 *
 * @param projectPath - Path to .xcodeproj or .xcworkspace
 * @returns Array of available schemes or error
 */
export async function listSchemes(projectPath: string): Promise<IOSResult<XcodeScheme[]>> {
  logger.info(`${LOG_CONTEXT} Listing schemes for: ${projectPath}`, LOG_CONTEXT);

  const projectArg = projectPath.endsWith('.xcworkspace')
    ? ['-workspace', projectPath]
    : ['-project', projectPath];

  const result = await runXcodebuild([...projectArg, '-list', '-json']);

  if (result.exitCode !== 0) {
    return {
      success: false,
      error: `Failed to list schemes: ${result.stderr || 'Unknown error'}`,
      errorCode: 'COMMAND_FAILED',
    };
  }

  const parseResult = parseJson<{
    workspace?: { name: string; schemes: string[] };
    project?: { name: string; schemes: string[]; targets: string[] };
  }>(result.stdout);

  if (!parseResult.success) {
    return {
      success: false,
      error: parseResult.error,
      errorCode: 'PARSE_ERROR',
    };
  }

  const data = parseResult.data!;
  const schemeNames = data.workspace?.schemes || data.project?.schemes || [];

  const schemes: XcodeScheme[] = schemeNames.map((name) => ({
    name,
  }));

  logger.info(`${LOG_CONTEXT} Found ${schemes.length} schemes`, LOG_CONTEXT);
  return {
    success: true,
    data: schemes,
  };
}

/**
 * List available targets in a project.
 * Note: Works only with .xcodeproj, not workspaces.
 *
 * @param projectPath - Path to .xcodeproj
 * @returns Array of available targets or error
 */
export async function listTargets(projectPath: string): Promise<IOSResult<XcodeTarget[]>> {
  logger.info(`${LOG_CONTEXT} Listing targets for: ${projectPath}`, LOG_CONTEXT);

  if (projectPath.endsWith('.xcworkspace')) {
    return {
      success: false,
      error: 'Cannot list targets for a workspace. Use listSchemes instead or specify a project.',
      errorCode: 'COMMAND_FAILED',
    };
  }

  const result = await runXcodebuild(['-project', projectPath, '-list', '-json']);

  if (result.exitCode !== 0) {
    return {
      success: false,
      error: `Failed to list targets: ${result.stderr || 'Unknown error'}`,
      errorCode: 'COMMAND_FAILED',
    };
  }

  const parseResult = parseJson<{
    project: { name: string; schemes: string[]; targets: string[] };
  }>(result.stdout);

  if (!parseResult.success) {
    return {
      success: false,
      error: parseResult.error,
      errorCode: 'PARSE_ERROR',
    };
  }

  const targetNames = parseResult.data!.project?.targets || [];
  const targets: XcodeTarget[] = targetNames.map((name) => ({
    name,
  }));

  logger.info(`${LOG_CONTEXT} Found ${targets.length} targets`, LOG_CONTEXT);
  return {
    success: true,
    data: targets,
  };
}

// =============================================================================
// Build Operations
// =============================================================================

/**
 * Build an Xcode project or workspace.
 *
 * @param options - Build configuration options
 * @returns Build result with app path and status
 */
export async function build(options: BuildOptions): Promise<IOSResult<BuildResult>> {
  const startTime = Date.now();
  logger.info(`${LOG_CONTEXT} Building: ${options.projectPath} (scheme: ${options.scheme})`, LOG_CONTEXT);

  const projectArg = options.projectPath.endsWith('.xcworkspace')
    ? ['-workspace', options.projectPath]
    : ['-project', options.projectPath];

  const configuration = options.configuration || 'Debug';

  // Build the xcodebuild command arguments
  const args: string[] = [
    ...projectArg,
    '-scheme', options.scheme,
    '-configuration', configuration,
    '-sdk', 'iphonesimulator',
  ];

  // Add destination if specified
  if (options.destination) {
    args.push('-destination', options.destination);
  } else {
    // Default to generic simulator destination
    args.push('-destination', 'generic/platform=iOS Simulator');
  }

  // Add derived data path if specified
  if (options.derivedDataPath) {
    args.push('-derivedDataPath', options.derivedDataPath);
  }

  // Add clean if requested
  if (options.clean) {
    args.push('clean');
  }

  // Add build action
  if (options.buildForTesting) {
    args.push('build-for-testing');
  } else {
    args.push('build');
  }

  // Add any additional arguments
  if (options.additionalArgs) {
    args.push(...options.additionalArgs);
  }

  const result = await runXcodebuild(args, options.cwd);
  const duration = Date.now() - startTime;

  // Parse warnings and errors from output
  const warnings = extractWarnings(result.stdout + '\n' + result.stderr);
  const errors = extractErrors(result.stdout + '\n' + result.stderr);

  // Determine derived data path
  const derivedDataPath = options.derivedDataPath || getDefaultDerivedDataPath();

  if (result.exitCode !== 0) {
    return {
      success: false,
      error: `Build failed: ${errors.join('; ') || result.stderr || 'Unknown error'}`,
      errorCode: 'BUILD_FAILED',
      data: {
        success: false,
        derivedDataPath,
        duration,
        warnings,
        errors,
      },
    };
  }

  // Try to find the built app
  let appPath: string | undefined;
  if (!options.buildForTesting) {
    const appResult = await getBuiltAppPath(derivedDataPath, options.scheme, configuration);
    if (appResult.success && appResult.data) {
      appPath = appResult.data;
    }
  }

  logger.info(
    `${LOG_CONTEXT} Build completed in ${duration}ms. App: ${appPath || 'not found'}`,
    LOG_CONTEXT
  );

  return {
    success: true,
    data: {
      success: true,
      appPath,
      derivedDataPath,
      duration,
      warnings,
      errors,
    },
  };
}

/**
 * Build an Xcode project for testing.
 * Convenience wrapper around build() with buildForTesting enabled.
 *
 * @param options - Build configuration options
 * @returns Build result
 */
export async function buildForTesting(
  options: Omit<BuildOptions, 'buildForTesting'>
): Promise<IOSResult<BuildResult>> {
  return build({
    ...options,
    buildForTesting: true,
  });
}

// =============================================================================
// Derived Data
// =============================================================================

/**
 * Get the default derived data path for Xcode builds.
 *
 * @returns Default derived data path
 */
export function getDefaultDerivedDataPath(): string {
  const homeDir = process.env.HOME || '/Users';
  return path.join(homeDir, 'Library', 'Developer', 'Xcode', 'DerivedData');
}

/**
 * Get the derived data path for a specific project.
 * Searches the default derived data directory for a matching folder.
 *
 * @param projectPath - Path to the Xcode project
 * @returns Path to the project's derived data folder or error
 */
export async function getDerivedDataPath(projectPath: string): Promise<IOSResult<string>> {
  const derivedDataRoot = getDefaultDerivedDataPath();

  if (!fs.existsSync(derivedDataRoot)) {
    return {
      success: false,
      error: 'Derived data directory does not exist. No builds have been performed.',
      errorCode: 'COMMAND_FAILED',
    };
  }

  // Extract project name from path
  const projectName = path.basename(projectPath).replace(/\.(xcodeproj|xcworkspace)$/, '');

  // List entries in derived data and find matching folder
  const entries = fs.readdirSync(derivedDataRoot);

  // Xcode creates folders like "ProjectName-hash"
  const matchingEntry = entries.find((entry) => {
    // Match "ProjectName-" prefix
    return entry.startsWith(projectName + '-') || entry === projectName;
  });

  if (!matchingEntry) {
    return {
      success: false,
      error: `No derived data found for project: ${projectName}`,
      errorCode: 'COMMAND_FAILED',
    };
  }

  const fullPath = path.join(derivedDataRoot, matchingEntry);

  logger.info(`${LOG_CONTEXT} Found derived data at: ${fullPath}`, LOG_CONTEXT);
  return {
    success: true,
    data: fullPath,
  };
}

/**
 * Get the path to the built .app bundle.
 *
 * @param derivedDataPath - Path to derived data directory
 * @param scheme - Scheme name that was built
 * @param configuration - Build configuration (default: Debug)
 * @returns Path to .app bundle or error
 */
export async function getBuiltAppPath(
  derivedDataPath: string,
  scheme: string,
  configuration: string = 'Debug'
): Promise<IOSResult<string>> {
  // The app is typically at:
  // DerivedData/ProjectName-hash/Build/Products/Debug-iphonesimulator/AppName.app
  const productsDir = path.join(derivedDataPath, 'Build', 'Products');

  if (!fs.existsSync(productsDir)) {
    return {
      success: false,
      error: `Build products directory not found: ${productsDir}`,
      errorCode: 'COMMAND_FAILED',
    };
  }

  // Find the configuration folder for simulator
  const configFolder = `${configuration}-iphonesimulator`;
  const configPath = path.join(productsDir, configFolder);

  if (!fs.existsSync(configPath)) {
    // Try to find any iphonesimulator folder
    const entries = fs.readdirSync(productsDir);
    const simFolder = entries.find((e) => e.includes('iphonesimulator'));

    if (!simFolder) {
      return {
        success: false,
        error: `No simulator build found in: ${productsDir}`,
        errorCode: 'COMMAND_FAILED',
      };
    }

    return getBuiltAppPath(derivedDataPath, scheme, simFolder.split('-')[0]);
  }

  // Find .app bundle in the config folder
  const entries = fs.readdirSync(configPath);

  // Prefer app matching scheme name
  let appBundle = entries.find((e) => e === `${scheme}.app`);

  // Fall back to any .app
  if (!appBundle) {
    appBundle = entries.find((e) => e.endsWith('.app'));
  }

  if (!appBundle) {
    return {
      success: false,
      error: `No .app bundle found in: ${configPath}`,
      errorCode: 'COMMAND_FAILED',
    };
  }

  const appPath = path.join(configPath, appBundle);

  logger.info(`${LOG_CONTEXT} Found app bundle: ${appPath}`, LOG_CONTEXT);
  return {
    success: true,
    data: appPath,
  };
}

// =============================================================================
// Build Settings
// =============================================================================

/**
 * Get build settings for a project/scheme combination.
 *
 * @param projectPath - Path to project or workspace
 * @param scheme - Scheme name
 * @returns Build settings dictionary or error
 */
export async function getBuildSettings(
  projectPath: string,
  scheme: string
): Promise<IOSResult<Record<string, string>>> {
  logger.info(`${LOG_CONTEXT} Getting build settings for: ${scheme}`, LOG_CONTEXT);

  const projectArg = projectPath.endsWith('.xcworkspace')
    ? ['-workspace', projectPath]
    : ['-project', projectPath];

  const result = await runXcodebuild([
    ...projectArg,
    '-scheme', scheme,
    '-showBuildSettings',
    '-json',
  ]);

  if (result.exitCode !== 0) {
    return {
      success: false,
      error: `Failed to get build settings: ${result.stderr || 'Unknown error'}`,
      errorCode: 'COMMAND_FAILED',
    };
  }

  const parseResult = parseJson<Array<{
    action: string;
    target: string;
    buildSettings: Record<string, string>;
  }>>(result.stdout);

  if (!parseResult.success) {
    return {
      success: false,
      error: parseResult.error,
      errorCode: 'PARSE_ERROR',
    };
  }

  // Combine all build settings (may be multiple targets)
  const settings: Record<string, string> = {};
  for (const item of parseResult.data!) {
    Object.assign(settings, item.buildSettings);
  }

  return {
    success: true,
    data: settings,
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Extract warning messages from xcodebuild output.
 */
function extractWarnings(output: string): string[] {
  const warnings: string[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    // Match various warning patterns
    if (line.includes(': warning:') || line.includes('⚠️')) {
      const match = line.match(/(?:warning:\s*)(.+)/i);
      if (match) {
        warnings.push(match[1].trim());
      } else {
        warnings.push(line.trim());
      }
    }
  }

  return warnings;
}

/**
 * Extract error messages from xcodebuild output.
 */
function extractErrors(output: string): string[] {
  const errors: string[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    // Match various error patterns
    if (line.includes(': error:') || line.includes('❌')) {
      const match = line.match(/(?:error:\s*)(.+)/i);
      if (match) {
        errors.push(match[1].trim());
      } else {
        errors.push(line.trim());
      }
    }
  }

  return errors;
}
