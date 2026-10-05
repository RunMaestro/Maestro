/**
 * A file logger for a process that has no terminal to print to: the TUI (Ink owns stdout and
 * stderr while the UI is up) and a detached `maestro-cli host`. Synchronous appends keep the last
 * line on disk when the process exits straight after it.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { MaestroLibLogger } from '../host';

function formatData(data: unknown): string {
	if (data === undefined) return '';
	if (data instanceof Error) return ` ${data.stack ?? data.message}`;
	try {
		return ` ${JSON.stringify(data)}`;
	} catch {
		return ` ${String(data)}`;
	}
}

export function createFileLogger(
	logFile: string,
	now: () => Date = () => new Date()
): MaestroLibLogger {
	fs.mkdirSync(path.dirname(logFile), { recursive: true });
	const write =
		(level: string) =>
		(message: string, context?: string, data?: unknown): void => {
			const scope = context ? ` [${context}]` : '';
			fs.appendFileSync(
				logFile,
				`${now().toISOString()} ${level}${scope} ${message}${formatData(data)}\n`
			);
		};
	return {
		debug: write('DEBUG'),
		info: write('INFO'),
		warn: write('WARN'),
		error: write('ERROR'),
	};
}
