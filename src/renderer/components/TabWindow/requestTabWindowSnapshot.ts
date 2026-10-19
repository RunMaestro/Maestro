/**
 * Ask the owner window for a fresh snapshot of this tab window's agent (Tab
 * Windows, D2), through the `requestSnapshot` intent. The owner's patch
 * publisher answers with a snapshot.
 *
 * A tab window asks on load: a new or reloaded window holds nothing of its
 * agent, and the snapshot the owner sent when the window attached can arrive
 * before this page listens. It asks again whenever a delta does not apply.
 *
 * Returns false when it could not ask: the record holds no tab to address the
 * intent with, or there is no tab windows API.
 */

import type { TabWindowInfo } from '../../../shared/tabWindowTypes';

export function requestTabWindowSnapshot(info: TabWindowInfo): boolean {
	const api = window.maestro?.tabWindows;
	const tabRef = info.activeTabRef ?? info.tabRefs[0];
	if (!api || !tabRef) return false;
	api.sendIntent({ kind: 'requestSnapshot', agentId: info.agentId, tabRef });
	return true;
}
