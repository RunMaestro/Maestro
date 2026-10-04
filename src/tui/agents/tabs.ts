/**
 * AI tab management (CH-1) as pure functions over the client: new, close, and
 * which tab to land on afterwards. Rename rides the prompt overlay in
 * `manage.ts`. Switching a tab is TUI-local (`activeTabByAgent`) and never
 * reaches the host, so the desktop's own active tab is not touched (CO-4).
 *
 * Closing moves the tab to the host's closed-tab history; nothing here deletes
 * a transcript. The host keeps it in memory for the desktop's lifetime, the
 * provider keeps its session files, and History keeps the summaries (gap G13).
 */

import {
	getTabDisplayName,
	type AITabRecord,
	type AgentRecord,
	type ClientResult,
	type MaestroClient,
} from '../../shared/maestro-lib';

/** The tab to show once `closedId` is gone: its left neighbor, else the one to its right. */
export function tabAfterClose(
	tabs: readonly AITabRecord[],
	closedId: string
): AITabRecord | undefined {
	const index = tabs.findIndex((tab) => tab.id === closedId);
	if (index < 0) return undefined;
	return tabs[index - 1] ?? tabs[index + 1];
}

/** Opens a new tab. The host does not switch to it, so the desktop's view stays where it was. */
export async function submitNewTab(
	client: MaestroClient,
	agent: AgentRecord
): Promise<ClientResult<{ tabId: string; notice: string }>> {
	const result = await client.tabs.create(agent.id);
	return result.ok
		? {
				ok: true,
				value: { tabId: result.value.tabId, notice: `Opened a new tab in ${agent.name}.` },
			}
		: result;
}

/** Closes a tab into the host's closed-tab history and says where its transcript stays. */
export async function submitCloseTab(
	client: MaestroClient,
	agent: AgentRecord,
	tab: AITabRecord
): Promise<ClientResult<string>> {
	const result = await client.tabs.close(agent.id, tab.id);
	return result.ok
		? {
				ok: true,
				value: `Closed ${getTabDisplayName(tab)}. Its transcript is kept in closed-tab history, the provider's session files, and History.`,
			}
		: result;
}
