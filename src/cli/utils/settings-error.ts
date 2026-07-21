import { formatError } from '../output/formatter';

interface SettingsErrorOptions {
	json?: boolean;
}

/**
 * Preserve the settings command error-stream envelope while callers retain
 * command-specific context in their human-readable messages.
 */
export function reportSettingsCliError(
	error: unknown,
	options: SettingsErrorOptions,
	prefix?: string
): never {
	const message = error instanceof Error ? error.message : 'Unknown error';

	if (options.json) {
		console.error(JSON.stringify({ error: message }));
	} else {
		console.error(formatError(prefix ? `${prefix}: ${message}` : message));
	}

	process.exit(1);
}
