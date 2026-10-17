import type { CliServerInfo } from './discovery';

export class MaestroNotRunningError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MaestroNotRunningError';
	}
}

/**
 * Thrown when the running app echoes a command back unhandled - i.e. it does
 * not recognize the message type. From a desktop this almost always means the
 * app is an older build than this client (a new command was added since the app
 * was last built/restarted). Carrying a distinct type lets callers map it to the
 * `Unsupported` exit code and print a "rebuild/restart the app" hint instead of
 * a generic timeout.
 *
 * A headless host (`maestro-cli host`) echoes too, for a different reason: it
 * serves the runtime's commands and has no window to serve the rest with. So
 * the message names the peer that answered, and does not send someone with no
 * desktop running off to restart one.
 */
export class UnsupportedCommandError extends Error {
	readonly commandType: string;
	constructor(commandType: string, hostKind?: CliServerInfo['hostKind']) {
		super(
			hostKind === 'headless'
				? `The headless Maestro host (\`maestro-cli host\`) does not support the '${commandType}' command. ` +
						'It may need the desktop app, or a newer build of the host.'
				: `The running Maestro app does not support the '${commandType}' command. ` +
						'It is likely an older build - rebuild and restart the desktop app, then retry.'
		);
		this.name = 'UnsupportedCommandError';
		this.commandType = commandType;
	}
}

/** Thrown when the app was reachable but did not answer a command in time. */
export class CommandTimeoutError extends Error {
	readonly responseType: string;
	constructor(responseType: string) {
		super(
			`Timed out waiting for the Maestro app to respond (expected '${responseType}'). ` +
				'The app is reachable but its renderer did not reply - it may be busy or unresponsive.'
		);
		this.name = 'CommandTimeoutError';
		this.responseType = responseType;
	}
}

/**
 * Thrown when the socket ended with a call in flight (`closedByCaller: false`),
 * or when the caller disconnected first (`closedByCaller: true`). The messages
 * are the ones the CLI has always printed.
 */
export class ConnectionClosedError extends Error {
	readonly closedByCaller: boolean;
	readonly code?: number;
	readonly reason?: string;
	constructor(options: { closedByCaller: boolean; code?: number; reason?: string }) {
		super(
			options.closedByCaller
				? 'Client disconnected'
				: `Connection closed${options.code ? ` (code=${options.code})` : ''}${
						options.reason ? `: ${options.reason}` : ''
					}`
		);
		this.name = 'ConnectionClosedError';
		this.closedByCaller = options.closedByCaller;
		this.code = options.code;
		this.reason = options.reason;
	}
}
