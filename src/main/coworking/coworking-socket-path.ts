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
import * as path from 'path';

/** Compute the platform-appropriate IPC bridge socket path. */
export function getBridgeSocketPath(): string {
	if (process.platform === 'win32') {
		// Per-user named pipe. Derive the slug from a hash of the FULL userData
		// path so the pipe name is unique per OS user; path.basename would be the
		// same app-folder name for every account and collide across users.
		const userData = app.getPath('userData');
		const slug = crypto.createHash('sha1').update(userData).digest('hex').slice(0, 16);
		return `\\\\.\\pipe\\maestro-coworking-${slug}`;
	}
	return path.join(app.getPath('userData'), 'coworking.sock');
}
