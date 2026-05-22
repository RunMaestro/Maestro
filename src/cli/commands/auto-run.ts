// Auto Run command
// Configures or launches Auto Run in the running Maestro desktop app.

import * as fs from 'fs';
import * as path from 'path';
import { resolveSessionId, withMaestroClient } from '../services/maestro-client';
import { getSessionById } from '../services/storage';
import { formatError } from '../output/formatter';

interface AutoRunOptions {
	session?: string;
	prompt?: string;
	loop?: boolean;
	maxLoops?: string;
	saveAs?: string;
	launch?: boolean;
	resetOnCompletion?: boolean;
}

interface ConfigureAutoRunResult {
	type: 'configure_auto_run_result';
	success: boolean;
	playbookId?: string;
	error?: string;
}

function resolveMarkdownDocument(documentPathArg: string): string {
	const documentPath = path.resolve(documentPathArg);

	if (!fs.existsSync(documentPath)) {
		throw new Error(`Document not found: ${documentPath}`);
	}

	const stats = fs.statSync(documentPath);
	if (!stats.isFile()) {
		throw new Error(`Document is not a file: ${documentPath}`);
	}

	if (path.extname(documentPath).toLowerCase() !== '.md') {
		throw new Error(`Document must be a Markdown file: ${documentPath}`);
	}

	return documentPath;
}

function parseMaxLoops(value: string | undefined): number | undefined {
	if (value === undefined) {
		return undefined;
	}

	const maxLoops = Number.parseInt(value, 10);
	if (!Number.isInteger(maxLoops) || maxLoops < 1 || String(maxLoops) !== value) {
		throw new Error('--max-loops must be a positive integer');
	}

	return maxLoops;
}

export async function autoRun(documentPathArgs: string[], options: AutoRunOptions): Promise<void> {
	try {
		const documentPaths = documentPathArgs.map(resolveMarkdownDocument);
		const maxLoops = parseMaxLoops(options.maxLoops);
		const sessionId = resolveSessionId(options);
		const session = getSessionById(sessionId);
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`);
		}
		if (!session.autoRunFolderPath) {
			throw new Error(`Session has no Auto Run folder configured: ${sessionId}`);
		}

		const autoRunFolderPath = path.resolve(session.autoRunFolderPath);
		const documents = documentPaths.map((documentPath) => ({
			filename: getAutoRunDocumentFilename(documentPath, autoRunFolderPath),
			resetOnCompletion: options.resetOnCompletion || false,
		}));

		await withMaestroClient(async (client) => {
			const result = await client.sendCommand<ConfigureAutoRunResult>(
				{
					type: 'configure_auto_run',
					sessionId,
					documents,
					prompt: options.prompt,
					loopEnabled: options.loop || maxLoops !== undefined,
					maxLoops,
					saveAsPlaybook: options.saveAs,
					launch: options.launch || false,
				},
				'configure_auto_run_result'
			);

			if (!result.success) {
				throw new Error(result.error || 'Failed to configure Auto Run');
			}
		});

		if (options.saveAs) {
			console.log(`Playbook '${options.saveAs}' saved`);
		} else if (options.launch) {
			console.log(`Auto-run launched with ${documents.length} documents`);
		} else {
			console.log(`Auto-run configured with ${documents.length} documents`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		console.error(formatError(`Failed to configure Auto Run: ${message}`));
		process.exit(1);
	}
}

function getAutoRunDocumentFilename(documentPath: string, autoRunFolderPath: string): string {
	const resolvedDocumentPath = path.resolve(documentPath);
	const documentDir = path.dirname(resolvedDocumentPath);
	if (documentDir !== autoRunFolderPath) {
		throw new Error(
			`Document must be in the session Auto Run folder: ${autoRunFolderPath}. Received: ${resolvedDocumentPath}`
		);
	}

	return path.basename(resolvedDocumentPath);
}
