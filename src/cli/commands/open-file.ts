// Open file command - open a file as a preview tab in the Maestro desktop app

import * as fs from 'fs';
import * as path from 'path';
import { withMaestroClient, resolveSessionId } from '../services/maestro-client';

interface OpenFileOptions {
	session?: string;
}

export async function openFile(filePath: string, options: OpenFileOptions): Promise<void> {
	const sessionId = resolveSessionId(options);

	// Resolve relative paths against the agent's working directory, not the CLI's cwd.
	// This allows `open-file README.md -s <id>` to open files from the agent's project.
	let absolutePath: string;
	if (path.isAbsolute(filePath)) {
		absolutePath = filePath;
	} else {
		// Try agent's cwd first by reading session info
		const { getSessionById } = await import('../services/storage');
		const session = getSessionById(sessionId);
		const basePath = session?.cwd || process.cwd();
		absolutePath = path.resolve(basePath, filePath);
	}

	if (!fs.existsSync(absolutePath)) {
		console.error(`Error: File not found: ${absolutePath}`);
		process.exit(1);
	}

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<{ type: string; success: boolean; error?: string }>(
				{ type: 'open_file_tab', sessionId, filePath: absolutePath },
				'open_file_tab_result'
			);
		});

		if (result.success) {
			console.log(`Opened ${path.basename(absolutePath)} in Maestro`);
		} else {
			console.error(`Error: ${result.error || 'Failed to open file'}`);
			process.exit(1);
		}
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
