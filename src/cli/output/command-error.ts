import { formatError } from './formatter';

/** Writes the established create-command error envelope without changing exit control flow. */
export function writeCommandError(json: boolean | undefined, message: string): void {
	if (json) {
		console.log(JSON.stringify({ success: false, error: message }));
	} else {
		console.error(formatError(message));
	}
}
