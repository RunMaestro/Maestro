// Open file command
// Opens a file as a preview tab in the running Maestro desktop app.

import * as fs from 'fs';
import * as path from 'path';
import { resolveSessionId, withMaestroClient } from '../services/maestro-client';
import { formatError } from '../output/formatter';

interface OpenFileOptions {
	session?: string;
}

interface OpenFileResult {
	type: 'open_file_tab_result';
	success?: boolean;
	sessionId?: string;
	filePath?: string;
	error?: string;
}

export async function openFile(filePathArg: string, options: OpenFileOptions): Promise<void> {
	try {
		const filePath = path.resolve(filePathArg);
		if (!fs.existsSync(filePath)) {
			throw new Error(`File not found: ${filePath}`);
		}

		const sessionId = resolveSessionId(options);

		await withMaestroClient(async (client) => {
			const result = await client.sendCommand<OpenFileResult>(
				{ type: 'open_file_tab', sessionId, filePath },
				'open_file_tab_result'
			);

			if (result.success === false) {
				throw new Error(result.error || 'Failed to open file in Maestro');
			}
		});

		console.log(`Opened ${path.basename(filePath)} in Maestro`);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		console.error(formatError(`Failed to open file: ${message}`));
		process.exit(1);
	}
}
