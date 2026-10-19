/**
 * useTabWindowInfo - this tab window's own registry record (Tab Windows, D3).
 *
 * Main holds the truth of which tabs a tab window shows and which one is
 * active. The tab window reads its record with `tabWindows:getState()` and
 * re-reads it on every `tab-window-changed` broadcast, through the same
 * registry watcher the owner-side mirror uses.
 *
 * The tab window deliberately does NOT sync `tabWindowStore`: that store feeds
 * the OWNER's hiding filters (D4), and every tab in this window is popped out,
 * so filling it here would hide this window's whole strip.
 */

import { useEffect, useState } from 'react';
import type { TabWindowInfo } from '../../../shared/tabWindowTypes';
import { watchTabWindowRegistry } from '../../stores/tabWindowStore';

export interface TabWindowInfoState {
	/** The record, or null before the first read and when main has none. */
	info: TabWindowInfo | null;
	/** True once the first read answered. */
	loaded: boolean;
}

export function useTabWindowInfo(): TabWindowInfoState {
	const [state, setState] = useState<TabWindowInfoState>({ info: null, loaded: false });

	useEffect(
		() =>
			watchTabWindowRegistry(
				(api) => api.getState(),
				(info) => setState({ info: info ?? null, loaded: true }),
				'tabWindows.getState'
			),
		[]
	);

	return state;
}
