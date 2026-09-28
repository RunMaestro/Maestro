/**
 * `maestro-cli support-package` - the palette's "Create Debug Package", for an
 * agent. Writes the same sanitized diagnostics zip (system info, settings,
 * agents, logs, errors, sessions, group chats) into a directory the caller
 * names, instead of raising a save dialog nobody is watching.
 *
 * The section toggles mirror the Debug Package modal's checkboxes. Auto Run
 * live state is held only by the renderer, so a CLI-built package marks that
 * section unavailable rather than claiming no runs were active.
 */

import { withMaestroClient } from '../services/maestro-client';
import { ExitCode, exitCodeForError, exitWith } from '../exit-codes';
import { resolveCliPath } from '../utils/parse';
import { formatSize } from '../../shared/formatters';
import type { DebugPackageOptions } from '../../shared/debugPackage';

/** Log collection and zipping can take a while on a large install. */
const CREATE_TIMEOUT_MS = 120_000;

interface SupportPackageOptions {
	output: string;
	/** Commander turns `--no-logs` into `logs: false`; absent means included. */
	logs?: boolean;
	errors?: boolean;
	sessions?: boolean;
	groupChats?: boolean;
	batchState?: boolean;
	json?: boolean;
}

export async function supportPackage(options: SupportPackageOptions): Promise<void> {
	const outputDir = resolveCliPath(options.output);
	const packageOptions: DebugPackageOptions = {
		includeLogs: options.logs !== false,
		includeErrors: options.errors !== false,
		includeSessions: options.sessions !== false,
		includeGroupChats: options.groupChats !== false,
		includeBatchState: options.batchState !== false,
	};

	let result: {
		success: boolean;
		path?: string;
		filesIncluded?: string[];
		totalSizeBytes?: number;
		error?: string;
	};
	try {
		result = await withMaestroClient((client) =>
			client.sendCommand(
				{ type: 'support_package_create', outputDir, options: packageOptions },
				'support_package_create_result',
				CREATE_TIMEOUT_MS
			)
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (options.json) console.log(JSON.stringify({ success: false, error: message }));
		else console.error(`Error: ${message}`);
		exitWith(exitCodeForError(error));
	}

	if (!result.success) {
		const message = result.error || 'Failed to create support package';
		if (options.json) console.log(JSON.stringify({ success: false, error: message }));
		else console.error(`Error: ${message}`);
		exitWith(ExitCode.GeneralError);
	}

	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				path: result.path,
				filesIncluded: result.filesIncluded ?? [],
				totalSizeBytes: result.totalSizeBytes ?? 0,
			})
		);
		return;
	}
	console.log(`Support package saved: ${result.path}`);
	console.log(
		`  ${(result.filesIncluded ?? []).length} files, ${formatSize(result.totalSizeBytes ?? 0)}`
	);
}
