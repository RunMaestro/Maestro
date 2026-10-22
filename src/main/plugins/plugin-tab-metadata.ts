// Pure projection from a raw persisted session record to the closed
// `PluginTabMetadata` shape a plugin may see via `tabs.list`. Extracted out of
// the `pluginTabsList` closure in `src/main/index.ts` so it can be unit tested
// without importing the Electron entrypoint.

import type { PluginTabMetadata } from './plugin-host-handlers';

/**
 * Project one raw, untyped session record (as persisted in the sessions
 * store) into the `PluginTabMetadata` entries a plugin is allowed to see.
 *
 * A malformed tab entry (not an object, or missing a string `id`) is
 * skipped rather than throwing, since this runs over data a plugin's host
 * call can trigger reads of at any time.
 */
export function projectSessionTabMetadata(session: Record<string, unknown>): PluginTabMetadata[] {
	const out: PluginTabMetadata[] = [];
	if (typeof session.id !== 'string') return out;
	const sessionId = session.id;
	const projectPath =
		typeof session.cwd === 'string'
			? session.cwd
			: typeof session.projectRoot === 'string'
				? session.projectRoot
				: undefined;

	for (const tab of Array.isArray(session.aiTabs) ? session.aiTabs : []) {
		if (!tab || typeof tab !== 'object') continue;
		const rec = tab as Record<string, unknown>;
		if (typeof rec.id !== 'string') continue;
		// Mirror `isAiTabHidden` (src/renderer/utils/unifiedTabOrderUtils.ts):
		// a hidden consult tab is not reachable from the tab strip, so it must
		// not be reachable as a plugin card either.
		if (rec.hidden === true) continue;
		out.push({
			id: rec.id,
			sessionId,
			type: 'ai',
			...(typeof rec.name === 'string' ? { title: rec.name } : {}),
			...(typeof rec.state === 'string' ? { status: rec.state } : {}),
			...(typeof rec.createdAt === 'number' ? { createdAt: rec.createdAt } : {}),
			...(rec.agentSessionId === null || typeof rec.agentSessionId === 'string'
				? { agentSessionId: rec.agentSessionId as string | null }
				: {}),
			...(projectPath ? { projectPath } : {}),
		});
	}
	for (const tab of Array.isArray(session.terminalTabs) ? session.terminalTabs : []) {
		if (!tab || typeof tab !== 'object') continue;
		const rec = tab as Record<string, unknown>;
		if (typeof rec.id !== 'string') continue;
		out.push({
			id: rec.id,
			sessionId,
			type: 'terminal',
			...(typeof rec.name === 'string' ? { title: rec.name } : {}),
			...(typeof rec.state === 'string' ? { status: rec.state } : {}),
			...(typeof rec.createdAt === 'number' ? { createdAt: rec.createdAt } : {}),
			...(projectPath ? { projectPath } : {}),
		});
	}
	return out;
}
