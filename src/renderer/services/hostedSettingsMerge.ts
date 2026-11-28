/**
 * Propose one merged text for a Federation settings conflict on a free-text field (nudge message,
 * new session message, custom arguments): the field two conductors both extended.
 *
 * The proposal is never applied by itself. The conflicts modal shows it in an editable box, and
 * only the person's "Use this" turns it into a resolution, because the nudge and the new session
 * message reach every later turn of the agent. The turn runs once on the agent's own remote, with
 * its own provider (already installed and signed in there), read-only, with no tools, and without
 * the cheap-model shortcut: its output becomes part of every turn, so a weak merge would compound.
 */

import { PROMPT_IDS } from '../../shared/promptDefinitions';
import type { LiftSyncConflict } from '../../shared/maestro-lib/agents/lift-settings-sync';
import type { MirroredPeer } from '../../shared/maestro-lib/client/peer-mirror';
import type { AgentRecord } from '../../shared/maestro-lib/store/records';
import { liftRemoteCwd } from '../../shared/maestro-lib/agents/lift-plan';

/** A merge that runs past this is abandoned; the person can still pick a side or write one. */
const MERGE_TIMEOUT_MS = 90_000;

function fill(template: string, values: Record<string, string>): string {
	return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, name: string) => values[name] ?? match);
}

/** Ask the agent's provider for one merged text. Throws a message a person can read. */
export async function proposeSettingsMerge(
	conflict: LiftSyncConflict,
	peer: Pick<MirroredPeer, 'remoteId'>,
	host: AgentRecord
): Promise<string> {
	const api = window.maestro;
	if (!api?.prompts || !api.context) throw new Error('Merging needs the desktop app.');
	const loaded = await api.prompts.get(PROMPT_IDS.FEDERATION_SETTINGS_MERGE);
	if (!loaded.success || !loaded.content) {
		throw new Error(loaded.error ?? 'The merge prompt could not be loaded.');
	}
	const prompt = fill(loaded.content, {
		FIELD: conflict.label,
		HOST_VALUE: typeof conflict.host === 'string' ? conflict.host : '',
		LOCAL_VALUE: typeof conflict.local === 'string' ? conflict.local : '',
	});
	const cwd = liftRemoteCwd(host);
	const merged = await api.context.groomContext(cwd, host.toolType, prompt, {
		sshRemoteConfig: { enabled: true, remoteId: peer.remoteId, workingDirOverride: cwd },
		readOnly: true,
		disableTools: true,
		timeoutMs: MERGE_TIMEOUT_MS,
	});
	const text = merged.trim();
	if (!text) throw new Error('The agent answered with nothing to merge.');
	return text;
}
