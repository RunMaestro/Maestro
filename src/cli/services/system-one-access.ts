// Whether a System One request from an agent would be answered right now, as
// the Maestro desktop app says.
//
// The CLI spawns agents in its own process (`send`, Auto Run, goal runs), where
// there is no System One service: the settings, the key and the day's spend are
// the desktop's. So the CLI's system prompt builder asks the desktop the one
// question the renderer's and the main process's builders ask,
// `getSystemOneAgentAccess()`, over the WS bridge.
//
// No answer is an answer. The `maestro-cli s1` verbs reach the engine through
// the same desktop, so when it is closed, older than this CLI, or slow, they
// could not work either, and the agent is not told about System One.

import type { SystemOneAgentAccess } from '../../shared/local-models/system-one-agent';
import { withMaestroClient } from './maestro-client';

/** One small file read on loopback. A desktop that takes longer is not asked to hold a spawn. */
export const SYSTEM_ONE_ACCESS_TIMEOUT_MS = 3_000;

/** Asks whether a System One request from one agent would be answered. No answer is undefined. */
export type SystemOneAccessReader = (
	agentId: string
) => Promise<SystemOneAgentAccess | null | undefined>;

type AccessReply = { success: boolean; error?: string; access?: SystemOneAgentAccess };

/**
 * Ask the desktop app about one agent. Never throws and never prints: a spawn
 * goes ahead either way, and a closed desktop is a normal state for a headless
 * run. Reads the settings and the day's count; sends nothing to an engine.
 */
export const readSystemOneAccessFromDesktop: SystemOneAccessReader = async (agentId) => {
	try {
		const reply = await withMaestroClient((client) =>
			client.sendCommand<AccessReply>(
				{ type: 'system_one_access', agentId },
				'system_one_access_result',
				SYSTEM_ONE_ACCESS_TIMEOUT_MS
			)
		);
		return reply.success ? reply.access : undefined;
	} catch {
		// Not running, a stale discovery file, an app older than this message, or
		// no answer in time: every one means the verbs cannot be reached either.
		return undefined;
	}
};
