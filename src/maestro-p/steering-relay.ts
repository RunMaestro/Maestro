// `maestro-p --steer-relay <socket>`: deliver one steering request to a turn
// running on THIS host, for a desktop that reached the host over ssh.
//
// The turn's maestro-p listens on a socket here, which the desktop cannot dial.
// The desktop runs this mode with one ssh command instead and sends the request
// frame on its stdin (see `sendRemoteSteeringRequest` in
// src/main/process-manager/steering-client.ts). The user's text therefore reaches
// the socket without ever being part of a command line.
//
// Output is two lines on stdout: STEERING_RELAY_STARTED_LINE, printed before the
// socket is dialed, then the verdict frame. The started line is what lets the
// desktop tell "nothing was typed" from "it may have been typed" when the ssh
// command ends without a verdict.

import {
	formatMaestroPCapabilities,
	MAESTRO_P_CAPABILITIES,
	MAESTRO_P_CAPABILITIES_FLAG,
	parseSteeringRequest,
	STEERING_RELAY_FLAG,
	STEERING_RELAY_SOCKET_TIMEOUT_MS,
	STEERING_RELAY_STARTED_LINE,
	type SteeringResultFrame,
} from '../shared/chatSteering';
import { requestSteeringOverSocket } from '../shared/chatSteeringSocket';
import { resolveSteeringSocketPath } from './steering-server';

export interface SteeringRelayOptions {
	/** The socket the turn listens on, as the desktop named it (may be `~/`-relative). */
	socketSpec: string;
	/** Everything read from stdin: one request frame line. */
	stdinText: string;
	/** Writes one line to stdout. */
	writeLine: (line: string) => void;
	/** Diagnostics to stderr. Never given the steering text. */
	warn?: (message: string) => void;
	home?: string;
	timeoutMs?: number;
}

/**
 * Run the relay. Resolves with the exit code: 0 once a verdict was printed, 2 when
 * stdin held no request frame (nothing was sent, and no started line is printed,
 * so the desktop reads it as a refusal).
 */
export async function runSteeringRelay(options: SteeringRelayOptions): Promise<number> {
	const warn = options.warn ?? ((m: string) => process.stderr.write(`${m}\n`));
	const firstLine = options.stdinText.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
	const frame = parseSteeringRequest(firstLine);
	if (!frame) {
		warn('maestro-p: --steer-relay expects one steering request frame on stdin.');
		return 2;
	}
	options.writeLine(STEERING_RELAY_STARTED_LINE);
	const result: SteeringResultFrame = await requestSteeringOverSocket({
		socketPath: resolveSteeringSocketPath(options.socketSpec, options.home),
		frame,
		timeoutMs: options.timeoutMs ?? STEERING_RELAY_SOCKET_TIMEOUT_MS,
		warn: (message) => warn(`maestro-p: steering relay: ${message}`),
	});
	options.writeLine(JSON.stringify(result));
	return 0;
}

/** A maestro-p invocation that is not a turn: answered before any turn setup runs. */
export type MaestroPEarlyMode =
	| { kind: 'capabilities' }
	| { kind: 'steer-relay'; socketSpec: string }
	| { kind: 'usage-error'; message: string };

/**
 * Recognize the invocations the desktop makes that are not turns, from the raw
 * argument list. Checked before commander parses (which would answer `--version`
 * and exit first) and before the turn's own parser (which forwards unknown flags
 * to claude). Both forms must lead the argument list, so a flag of the same name
 * further along a claude command line is never taken for one.
 */
export function parseMaestroPEarlyMode(argv: readonly string[]): MaestroPEarlyMode | null {
	const first = argv[0];
	if (first === STEERING_RELAY_FLAG) {
		const socketSpec = argv[1]?.trim();
		if (!socketSpec) {
			return { kind: 'usage-error', message: `${STEERING_RELAY_FLAG} needs a socket path.` };
		}
		return { kind: 'steer-relay', socketSpec };
	}
	const asksVersion = first === '--version' || first === '-v';
	if (
		first === MAESTRO_P_CAPABILITIES_FLAG ||
		(asksVersion && argv.includes(MAESTRO_P_CAPABILITIES_FLAG))
	) {
		return { kind: 'capabilities' };
	}
	return null;
}

/** What `maestro-p --version --capabilities` prints: the version, then the capabilities line. */
export function formatVersionWithCapabilities(version: string): string {
	return `${version}\n${formatMaestroPCapabilities(MAESTRO_P_CAPABILITIES)}\n`;
}
