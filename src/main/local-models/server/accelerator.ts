/**
 * Ask the installed `llama-server` what it will compute on, and remember the answer.
 *
 * Runs `llama-server --list-devices` (it prints and exits; no model, no port) and
 * classifies the output with `classifyAcceleratorProbe()`. The binary is spawned
 * directly with no shell, so a path with spaces needs no quoting and nothing in it
 * is interpreted. The run never throws: a binary that cannot start is itself the
 * finding (`status: 'failed'`), and an install must not be undone because the
 * check could not run.
 */

import * as path from 'path';

import {
	classifyAcceleratorProbe,
	LIST_DEVICES_FLAG,
	serverAcceleratorProblemMessage,
	type ListDevicesRun,
	type ServerAcceleratorReport,
} from '../../../shared/local-models/server-accelerator';
import type { ServerBuildKind } from '../../../shared/local-models/server-engine';
import { execFileNoThrow } from '../../utils/execFile';
import { logger } from '../../utils/logger';
import {
	installedServerBinary,
	readServerEngineManifest,
	writeServerEngineManifest,
} from './engine-store';

const LOG_CONTEXT = 'LocalModels';

/**
 * Generous: the first Vulkan or CUDA initialisation on a machine can compile or
 * load driver caches. A hung driver still ends the check instead of the install.
 */
export const ACCELERATOR_CHECK_TIMEOUT_MS = 30_000;

export type ListDevicesRunner = (binary: string) => Promise<ListDevicesRun>;

export interface AcceleratorCheckOptions {
	/** Injected in tests. Production runs the binary. */
	runListDevices?: ListDevicesRunner;
	platform?: string;
	arch?: string;
}

const runListDevicesDefault: ListDevicesRunner = (binary) =>
	// cwd is the install directory: Windows looks for the backend DLLs beside the
	// executable either way, and a relative lookup has nothing else to land on.
	execFileNoThrow(binary, [LIST_DEVICES_FLAG], path.dirname(binary), {
		timeout: ACCELERATOR_CHECK_TIMEOUT_MS,
	});

/** Run the device check against a binary of a known build kind. Never throws. */
export async function checkServerAccelerator(
	binary: string,
	kind: ServerBuildKind,
	options: AcceleratorCheckOptions = {}
): Promise<ServerAcceleratorReport> {
	const run = await (options.runListDevices ?? runListDevicesDefault)(binary).catch(
		(error: unknown): ListDevicesRun => ({
			stdout: '',
			stderr: error instanceof Error ? error.message : String(error),
			exitCode: 'ESPAWN',
		})
	);
	const report = classifyAcceleratorProbe({
		kind,
		platform: options.platform ?? process.platform,
		arch: options.arch ?? process.arch,
		run,
	});
	const problem = serverAcceleratorProblemMessage(report);
	if (problem) {
		logger.warn(`Model server accelerator check: ${problem}`, LOG_CONTEXT, {
			kind,
			problem: report.problem,
			detail: report.detail,
		});
	} else {
		logger.info(`Model server accelerator: ${report.label}`, LOG_CONTEXT);
	}
	return report;
}

/**
 * Re-run the check for the installed engine and store the new answer in its
 * manifest: after a driver install, or when the card asks again. Null when no
 * engine is installed.
 */
export async function recheckServerAccelerator(
	options: AcceleratorCheckOptions = {}
): Promise<ServerAcceleratorReport | null> {
	const manifest = await readServerEngineManifest();
	const binary = await installedServerBinary();
	if (!manifest || !binary) return null;
	const accelerator = await checkServerAccelerator(binary, manifest.kind, options);
	await writeServerEngineManifest({ ...manifest, accelerator });
	return accelerator;
}
