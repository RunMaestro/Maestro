/**
 * Resolves the coworking IPC bridge socket path (Unix domain socket on POSIX,
 * per-user named pipe on Windows).
 *
 * Extracted into its own tiny, side-effect-free module so callers that only
 * need the path - notably ProcessManager, which injects the owning window's
 * socket into every agent spawn - do not have to pull in the full
 * bridge/net/registry/tools module graph from coworking-bridge.
 */

import { app } from 'electron';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';

/**
 * Longest usable Unix domain socket path, including the trailing NUL.
 * `sockaddr_un.sun_path` is a fixed-size char array: 104 bytes on macOS/BSD,
 * 108 on Linux. Going over does not truncate - bind() rejects the address and
 * Node surfaces `listen EINVAL`, which is what a deep userData directory hit
 * in the field (MAESTRO-WH).
 */
const SUN_PATH_MAX = process.platform === 'linux' ? 108 : 104;

/** Stable 16-hex-char identifier for a userData directory. */
function userDataSlug(userData: string): string {
	return crypto.createHash('sha1').update(userData).digest('hex').slice(0, 16);
}

/** Compute the platform-appropriate IPC bridge socket path. */
export function getBridgeSocketPath(): string {
	const userData = app.getPath('userData');

	if (process.platform === 'win32') {
		// Per-user named pipe. Derive the slug from a hash of the FULL userData
		// path so the pipe name is unique per OS user; path.basename would be the
		// same app-folder name for every account and collide across users.
		return `\\\\.\\pipe\\maestro-coworking-${userDataSlug(userData)}`;
	}

	// Preferred: alongside the rest of the per-userData runtime state.
	const preferred = path.join(userData, 'coworking.sock');
	if (Buffer.byteLength(preferred) + 1 <= SUN_PATH_MAX) return preferred;

	// The userData path is too deep to hold a bindable socket (long home
	// directory, nested portable/test data dir, ...). Fall back to a short path
	// under the temp dir, keyed by the same userData hash the Windows pipe uses
	// so the socket stays unique per data directory. Callers all resolve the
	// path through this function, so the bridge and the env var agents read
	// (COWORKING_SOCKET_ENV_VAR) stay in sync automatically.
	return path.join(os.tmpdir(), `maestro-coworking-${userDataSlug(userData)}.sock`);
}
