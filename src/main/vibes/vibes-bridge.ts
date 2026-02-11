// VibesCheck CLI Bridge — Main-process module that interfaces with the `vibescheck` binary.
// Provides functions to detect, invoke, and parse output from vibescheck commands.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { access, constants } from 'fs/promises';
import * as path from 'path';

import type { VibesAssuranceLevel } from '../../shared/vibes-types';

const execFileAsync = promisify(execFile);

// ============================================================================
// Constants
// ============================================================================

/** Timeout for vibescheck commands (30 seconds). */
const VIBES_EXEC_TIMEOUT_MS = 30_000;

/** Maximum buffer size for vibescheck output (5MB). */
const VIBES_MAX_BUFFER = 5 * 1024 * 1024;

/** Name of the vibescheck binary. */
const VIBES_BINARY_NAME = 'vibescheck';

// ============================================================================
// Internal Helper
// ============================================================================

interface ExecVibesCheckResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Execute the vibescheck binary with the given arguments.
 * Uses child_process.execFile with a 30-second timeout.
 * Never throws — returns an ExecVibesCheckResult with exit code.
 */
async function execVibesCheck(
	binaryPath: string,
	args: string[],
	cwd: string,
): Promise<ExecVibesCheckResult> {
	try {
		const { stdout, stderr } = await execFileAsync(binaryPath, args, {
			cwd,
			encoding: 'utf8',
			timeout: VIBES_EXEC_TIMEOUT_MS,
			maxBuffer: VIBES_MAX_BUFFER,
		});
		return { stdout, stderr, exitCode: 0 };
	} catch (error: any) {
		return {
			stdout: error.stdout || '',
			stderr: error.stderr || error.message || '',
			exitCode: typeof error.code === 'number' ? error.code : (error.status ?? 1),
		};
	}
}

// ============================================================================
// Binary Detection
// ============================================================================

/**
 * Find the vibescheck binary. Checks custom path first, then searches $PATH.
 * Returns the absolute path to the binary, or null if not found.
 */
export async function findVibesCheckBinary(customPath?: string): Promise<string | null> {
	// Check custom path first
	if (customPath) {
		try {
			await access(customPath, constants.X_OK);
			return path.resolve(customPath);
		} catch {
			return null;
		}
	}

	// Search $PATH
	const pathDirs = (process.env.PATH || '').split(path.delimiter);
	for (const dir of pathDirs) {
		const candidate = path.join(dir, VIBES_BINARY_NAME);
		try {
			await access(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Not found in this directory, continue
		}
	}

	return null;
}

// ============================================================================
// Project Status
// ============================================================================

/**
 * Check if VIBES is initialized in a project by looking for .ai-audit/config.json.
 */
export async function isVibesInitialized(projectPath: string): Promise<boolean> {
	try {
		await access(path.join(projectPath, '.ai-audit', 'config.json'), constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

// ============================================================================
// Standard Result Type
// ============================================================================

interface VibesCommandResult {
	success: boolean;
	data?: string;
	error?: string;
}

/**
 * Resolve the binary path: use the provided custom path, or auto-detect from $PATH.
 * Returns the path or throws if not found.
 */
async function resolveBinary(customBinaryPath?: string): Promise<string> {
	const binaryPath = await findVibesCheckBinary(customBinaryPath);
	if (!binaryPath) {
		throw new Error(
			'vibescheck binary not found. Install it or set the path in Settings > VIBES.',
		);
	}
	return binaryPath;
}

// ============================================================================
// CLI Commands
// ============================================================================

/**
 * Initialize a VIBES audit directory in a project.
 * Runs `vibescheck init` with the specified configuration.
 */
export async function vibesInit(
	projectPath: string,
	config: {
		projectName: string;
		assuranceLevel: VibesAssuranceLevel;
		extensions?: string[];
	},
	customBinaryPath?: string,
): Promise<{ success: boolean; error?: string }> {
	const binaryPath = await resolveBinary(customBinaryPath);

	const args = [
		'init',
		'--project-name', config.projectName,
		'--assurance-level', config.assuranceLevel,
	];
	if (config.extensions && config.extensions.length > 0) {
		args.push('--extensions', config.extensions.join(','));
	}

	const result = await execVibesCheck(binaryPath, args, projectPath);
	if (result.exitCode !== 0) {
		return { success: false, error: result.stderr || `Exit code ${result.exitCode}` };
	}
	return { success: true };
}

/**
 * Run `vibescheck build` to rebuild the audit manifest from annotations.
 */
export async function vibesBuild(
	projectPath: string,
	customBinaryPath?: string,
): Promise<{ success: boolean; error?: string }> {
	const binaryPath = await resolveBinary(customBinaryPath);
	const result = await execVibesCheck(binaryPath, ['build'], projectPath);
	if (result.exitCode !== 0) {
		return { success: false, error: result.stderr || `Exit code ${result.exitCode}` };
	}
	return { success: true };
}

/**
 * Run `vibescheck stats` to get project statistics.
 * Optionally scoped to a specific file.
 */
export async function vibesStats(
	projectPath: string,
	file?: string,
	customBinaryPath?: string,
): Promise<VibesCommandResult> {
	const binaryPath = await resolveBinary(customBinaryPath);
	const args = ['stats'];
	if (file) {
		args.push(file);
	}

	const result = await execVibesCheck(binaryPath, args, projectPath);
	if (result.exitCode !== 0) {
		return { success: false, error: result.stderr || `Exit code ${result.exitCode}` };
	}
	return { success: true, data: result.stdout };
}

/**
 * Run `vibescheck blame --json <file>` to get per-line provenance data.
 */
export async function vibesBlame(
	projectPath: string,
	file: string,
	customBinaryPath?: string,
): Promise<VibesCommandResult> {
	const binaryPath = await resolveBinary(customBinaryPath);
	const result = await execVibesCheck(binaryPath, ['blame', '--json', file], projectPath);
	if (result.exitCode !== 0) {
		return { success: false, error: result.stderr || `Exit code ${result.exitCode}` };
	}
	return { success: true, data: result.stdout };
}

/**
 * Run `vibescheck log` with optional filters.
 */
export async function vibesLog(
	projectPath: string,
	options?: {
		file?: string;
		model?: string;
		session?: string;
		limit?: number;
		json?: boolean;
	},
	customBinaryPath?: string,
): Promise<VibesCommandResult> {
	const binaryPath = await resolveBinary(customBinaryPath);
	const args = ['log'];

	if (options?.file) {
		args.push('--file', options.file);
	}
	if (options?.model) {
		args.push('--model', options.model);
	}
	if (options?.session) {
		args.push('--session', options.session);
	}
	if (options?.limit !== undefined) {
		args.push('--limit', String(options.limit));
	}
	if (options?.json) {
		args.push('--json');
	}

	const result = await execVibesCheck(binaryPath, args, projectPath);
	if (result.exitCode !== 0) {
		return { success: false, error: result.stderr || `Exit code ${result.exitCode}` };
	}
	return { success: true, data: result.stdout };
}

/**
 * Run `vibescheck coverage` to get VIBES coverage statistics.
 */
export async function vibesCoverage(
	projectPath: string,
	json?: boolean,
	customBinaryPath?: string,
): Promise<VibesCommandResult> {
	const binaryPath = await resolveBinary(customBinaryPath);
	const args = ['coverage'];
	if (json) {
		args.push('--json');
	}

	const result = await execVibesCheck(binaryPath, args, projectPath);
	if (result.exitCode !== 0) {
		return { success: false, error: result.stderr || `Exit code ${result.exitCode}` };
	}
	return { success: true, data: result.stdout };
}

/**
 * Run `vibescheck report` to generate a VIBES report.
 */
export async function vibesReport(
	projectPath: string,
	format?: 'markdown' | 'html' | 'json',
	customBinaryPath?: string,
): Promise<VibesCommandResult> {
	const binaryPath = await resolveBinary(customBinaryPath);
	const args = ['report'];
	if (format) {
		args.push('--format', format);
	}

	const result = await execVibesCheck(binaryPath, args, projectPath);
	if (result.exitCode !== 0) {
		return { success: false, error: result.stderr || `Exit code ${result.exitCode}` };
	}
	return { success: true, data: result.stdout };
}

/**
 * Run `vibescheck sessions --json` to list all sessions.
 */
export async function vibesSessions(
	projectPath: string,
	customBinaryPath?: string,
): Promise<VibesCommandResult> {
	const binaryPath = await resolveBinary(customBinaryPath);
	const result = await execVibesCheck(binaryPath, ['sessions', '--json'], projectPath);
	if (result.exitCode !== 0) {
		return { success: false, error: result.stderr || `Exit code ${result.exitCode}` };
	}
	return { success: true, data: result.stdout };
}

/**
 * Run `vibescheck models --json` to list all models used.
 */
export async function vibesModels(
	projectPath: string,
	customBinaryPath?: string,
): Promise<VibesCommandResult> {
	const binaryPath = await resolveBinary(customBinaryPath);
	const result = await execVibesCheck(binaryPath, ['models', '--json'], projectPath);
	if (result.exitCode !== 0) {
		return { success: false, error: result.stderr || `Exit code ${result.exitCode}` };
	}
	return { success: true, data: result.stdout };
}
