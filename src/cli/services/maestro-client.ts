// CLI WebSocket client for communicating with the running Maestro desktop app.
//
// The connection moved into maestro-lib (client/bridge-connection.ts) so the
// TUI shares it. There the class is `BridgeConnection`, because the library's
// client interface owns the name `MaestroClient`; the CLI keeps its own names
// through these aliases, so every command and test resolves unchanged.

import { readSessions, resolveAgentId } from './storage';

export {
	BridgeConnection as MaestroClient,
	withBridgeConnection as withMaestroClient,
	UnsupportedCommandError,
	CommandTimeoutError,
} from '../../shared/maestro-lib/client/bridge-connection';

/**
 * Resolve session ID from CLI options.
 * Uses the provided --session value, or falls back to the first available session.
 */
export function resolveSessionId(options: { session?: string }): string {
	if (options.session) {
		return options.session;
	}

	const sessions = readSessions();
	if (sessions.length === 0) {
		console.error('Error: No agents found. Create an agent in Maestro first.');
		process.exit(1);
	}

	return sessions[0].id;
}

/**
 * Resolve a target agent (sessionId) from an optional `--agent` value, or fall
 * back to the first available agent. Centralizes the duplicated try/catch +
 * resolveSessionId pattern that several desktop-handoff verbs share.
 *
 * Only the known `resolveAgentId` errors (ambiguous / not-found) get the
 * friendly stderr + exit(1) treatment. Anything else (e.g. corrupted store
 * read in `readSessions`) re-throws so it surfaces as a stack trace - per the
 * codebase's "let exceptions bubble up" rule for unexpected failures.
 */
export function resolveTargetSessionId(agent?: string): string {
	if (agent) {
		try {
			return resolveAgentId(agent);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const isExpected =
				message.startsWith('Ambiguous agent ID') || message.startsWith('Agent not found:');
			if (!isExpected) {
				throw error;
			}
			console.error(`Error: ${message}`);
			process.exit(1);
		}
	}
	return resolveSessionId({});
}
