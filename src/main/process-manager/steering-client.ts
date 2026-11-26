// Main-process client for maestro-p's chat-steering channel (see
// src/shared/chatSteering.ts for the protocol, src/maestro-p/steering-server.ts
// for the other end).
//
// Two halves, and the first is why this module exists at all: the SPAWNER and the
// CLIENT have to agree on a socket path without one telling the other. The spawn
// decision happens deep in the handle-spawn chain (apply-local-interactive-spawn),
// which builds an env record and returns; the client runs later, from an IPC call
// that knows only the process key. Deriving the path from that key means neither
// has to carry a value for the other.

import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';

import {
	parseSteeringResult,
	remoteSteeringSocketSpec,
	STEERING_RELAY_FLAG,
	STEERING_RELAY_STARTED_LINE,
	STEERING_REPLY_TIMEOUT_MS,
	STEERING_TOO_LONG_DETAIL,
	steeringTextTooLong,
	type SteeringResultFrame,
	type SteeringRequestFrame,
} from '../../shared/chatSteering';
import { requestSteeringOverSocket } from '../../shared/chatSteeringSocket';
import { isWindows } from '../../shared/platformDetection';
import {
	describeSshUnreachable,
	isSshConnectionFailure,
	sshFailedBeforeSession,
} from '../../shared/sshConnection';
import type { SshRemoteConfig } from '../../shared/types';
import { logger } from '../utils/logger';
import { buildSshCommand, execSshCommand } from '../utils/ssh-command-builder';

const LOG_CONTEXT = '[Steering]';

/**
 * Socket path for a given process key (`${sessionId}-ai-${tabId}`).
 *
 * The key is HASHED rather than sanitized into the name, because a unix socket
 * address is capped near 104 bytes on macOS and a session UUID plus a tab id plus
 * a tmpdir already exceeds that - the socket would simply fail to bind, and
 * steering would be silently unavailable with no obvious cause. A short hash is
 * also stable across both callers, which is the whole point.
 *
 * Not a security boundary: anything able to read the directory can find the
 * socket. What protects it is that the server only ever types into the TUI it
 * owns, refuses when the editor is not accepting input, and caps the frame size.
 */
export function steeringSocketPathFor(processKey: string): string {
	const digest = steeringSocketDigest(processKey);
	// Node on Windows implements a local socket as a named pipe, whose address must
	// live in the pipe namespace: a filesystem path there fails to bind, so every
	// Windows turn would silently be un-steerable. The server recognizes this form
	// and never stats or unlinks it (a pipe is not a file).
	if (isWindows()) return `\\\\.\\pipe\\maestro-steer-${digest}`;
	return path.join(os.tmpdir(), `maestro-steer-${digest}.sock`);
}

/** The short, stable name both ends derive from a process key. See {@link steeringSocketPathFor}. */
function steeringSocketDigest(processKey: string): string {
	return crypto.createHash('sha1').update(processKey).digest('hex').slice(0, 16);
}

/**
 * A fresh socket for one turn on an SSH remote, named from its process key plus a
 * per-spawn token. Unlike the local path it is not re-derived later: the spawn
 * records it on the process ({@link RemoteSteeringChannel}), so it can be unique.
 * It has to be: a steer takes an ssh round trip to land, and a path the tab's NEXT
 * turn could bind again would let a steer meant for a turn that just ended be typed
 * into the one that replaced it. Home-relative because only the remote knows its
 * home (maestro-p expands it there).
 */
export function remoteSteeringSocketFor(processKey: string): string {
	const token = crypto.randomBytes(4).toString('hex');
	return remoteSteeringSocketSpec(`${steeringSocketDigest(processKey)}-${token}`);
}

/**
 * How to reach the steering channel of a turn on an SSH remote, recorded on the
 * process by the spawn that opened it. Present only when the remote's maestro-p
 * advertised the steering relay, so its absence means "no channel" exactly as a
 * missing local socket does.
 */
export interface RemoteSteeringChannel {
	/** The remote the turn runs on, as the spawn resolved it. */
	remote: SshRemoteConfig;
	/** The maestro-p command the spawn ran there. */
	command: string;
	/** Home-relative socket path on the remote ({@link remoteSteeringSocketFor}). */
	socket: string;
	/**
	 * Environment the relay needs to find that socket: the turn's own `HOME` when
	 * its env set one, so the relay expands `~/` to the same folder the turn did.
	 */
	env?: Record<string, string>;
}

// The socket reply budget lives in shared/chatSteering.ts so the CLI and the
// web-server round trip can size their own waits from it.
export { STEERING_REPLY_TIMEOUT_MS } from '../../shared/chatSteering';

/** The answer for an over-cap steer, from every transport. Never sent. */
function tooLongResult(id: string): SteeringResultFrame {
	return {
		type: 'steering',
		id,
		verdict: 'refused',
		refusal: 'too-long',
		detail: STEERING_TOO_LONG_DETAIL,
	};
}

/**
 * Ask a running maestro-p turn on THIS machine to take `text` into the turn in
 * flight.
 *
 * Always resolves, never rejects. The caller is a UI action, and every outcome
 * here is a thing to TELL the user rather than an exception to propagate: a
 * refusal is a normal answer ("a permission prompt is on screen"), and an
 * unreachable socket usually just means this turn is not steerable.
 */
export async function sendSteeringRequest(options: {
	processKey: string;
	text: string;
	/** Correlation id. Echoed back on the verdict. */
	id: string;
	timeoutMs?: number;
}): Promise<SteeringResultFrame> {
	// Never sent: the server would refuse it anyway, and the round trip costs a
	// connection for an answer known here.
	if (steeringTextTooLong(options.text)) return tooLongResult(options.id);
	const frame: SteeringRequestFrame = { type: 'steer', id: options.id, text: options.text };
	return requestSteeringOverSocket({
		socketPath: steeringSocketPathFor(options.processKey),
		frame,
		timeoutMs: options.timeoutMs ?? STEERING_REPLY_TIMEOUT_MS,
		warn: (message, stage) =>
			logger.warn(
				stage === 'connect'
					? 'Steering channel unreachable'
					: 'Steering channel failed mid-request',
				LOG_CONTEXT,
				{ processKey: options.processKey, error: message }
			),
	});
}

/**
 * Ask a running maestro-p turn on an SSH remote to take `text` into the turn in
 * flight: one ssh command runs `maestro-p --steer-relay <socket>` on the remote,
 * which delivers the frame to the turn's socket there and prints the verdict.
 *
 * The frame (the user's text) goes on the ssh command's STDIN and nowhere else;
 * the command line carries only the relay flag and the shell-escaped socket path.
 *
 * Same contract as {@link sendSteeringRequest}, and the same line between
 * `refused` and `unknown`: the relay prints {@link STEERING_RELAY_STARTED_LINE}
 * before it dials the socket, so no started line means nothing was typed (ssh never
 * reached the host, or the relay could not run) and the message stays the caller's.
 */
export async function sendRemoteSteeringRequest(options: {
	channel: RemoteSteeringChannel;
	processKey: string;
	text: string;
	id: string;
	timeoutMs?: number;
}): Promise<SteeringResultFrame> {
	const { channel, id } = options;
	if (steeringTextTooLong(options.text)) return tooLongResult(id);
	const frame: SteeringRequestFrame = { type: 'steer', id, text: options.text };
	const notSent = (detail: string): SteeringResultFrame => ({
		type: 'steering',
		id,
		verdict: 'refused',
		refusal: 'not-running',
		detail,
	});

	let result: Awaited<ReturnType<typeof execSshCommand>>;
	try {
		const sshCommand = await buildSshCommand(channel.remote, {
			command: channel.command,
			args: [STEERING_RELAY_FLAG, channel.socket],
			...(channel.env ? { env: channel.env } : {}),
			useStdin: true,
		});
		result = await execSshCommand(channel.remote, sshCommand, {
			input: `${JSON.stringify(frame)}\n`,
			timeout: options.timeoutMs ?? STEERING_REPLY_TIMEOUT_MS,
		});
	} catch (err) {
		logger.warn('Could not run the remote steering relay', LOG_CONTEXT, {
			processKey: options.processKey,
			error: err instanceof Error ? err.message : String(err),
		});
		return notSent('the steering command for the SSH remote could not be started');
	}

	const lines = result.stdout.split(/\r?\n/);
	let started = false;
	for (const line of lines) {
		if (line.trim() === STEERING_RELAY_STARTED_LINE) {
			started = true;
			continue;
		}
		const parsed = parseSteeringResult(line);
		if (parsed && parsed.id === id) return parsed;
	}
	if (!started) {
		// ssh exits 255 both when it never connected and when a live connection
		// dropped, possibly after the relay already delivered the text and before
		// its output arrived. Only stderr that proves no session opened is a refusal.
		if (isSshConnectionFailure(result.exitCode)) {
			if (sshFailedBeforeSession(result.stderr)) {
				return notSent(describeSshUnreachable(channel.remote, result.stderr));
			}
		} else if (result.exitCode !== 'ETIMEDOUT') {
			// Any other exit is the remote command's own: the session ran to its end
			// and its whole stdout arrived, so no started line means the relay never ran.
			logger.warn('Remote steering relay did not run', LOG_CONTEXT, {
				processKey: options.processKey,
				exitCode: result.exitCode,
			});
			return notSent('maestro-p on the SSH remote could not run the steering relay');
		}
	}
	// The relay started, or may have (a dropped connection, a timeout), so the text
	// may have been typed. Never invite a re-send that doubles it.
	logger.warn('Remote steering relay ended without a verdict', LOG_CONTEXT, {
		processKey: options.processKey,
		exitCode: result.exitCode,
	});
	return {
		type: 'steering',
		id,
		verdict: 'unknown',
		detail: 'the SSH remote did not report what became of the steering request',
	};
}
