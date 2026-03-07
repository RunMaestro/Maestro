// Open file command - open a file as a preview tab in the Maestro desktop app

import * as fs from 'fs';
import * as path from 'path';
import { withMaestroClient, resolveSessionId } from '../services/maestro-client';

interface OpenFileOptions {
	session?: string;
}

export async function openFile(filePath: string, options: OpenFileOptions): Promise<void> {
	const absolutePath = path.resolve(filePath);

	if (!fs.existsSync(absolutePath)) {
		console.error(`Error: File not found: ${absolutePath}`);
		process.exit(1);
	}

	const sessionId = resolveSessionId(options);

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
