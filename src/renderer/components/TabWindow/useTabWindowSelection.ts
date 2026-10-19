/**
 * useTabWindowSelection - which tab a tab window shows, and how it switches.
 *
 * Main holds the truth (D3): selecting a tab calls `tabWindows:focus`, which
 * records it as the window's `activeTabRef` (`setTabWindowActiveTab`) and
 * broadcasts `tab-window-changed`; the window then re-reads its record.
 *
 * That round trip is asynchronous, and tab shortcuts must not be: two quick
 * `Cmd+Shift+]` presses have to move two tabs, not compute both from the tab
 * the record named before either landed. So a selection shows at once and
 * stays shown until the record catches up:
 *
 * - The pending tab is dropped when a re-read names it (main confirmed it).
 * - A re-read that names another tab does not drop it while the call is in
 *   flight (that re-read predates it). Once the call succeeded, the next
 *   re-read wins, whatever it names, so a later change from elsewhere (a CLI
 *   `focus-agent --tab`) is never masked.
 * - A refused or failed call drops it at once: the record never moved.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { isSameTabRef, type SingleTabType } from '../../../shared/unifiedTabRef';
import type { TabWindowTabRef } from '../../../shared/tabWindowTypes';
import { runTabWindowCall } from './runTabWindowCall';

interface PendingSelection {
	ref: TabWindowTabRef;
	/** Which selection this is, so an older call settling cannot touch a newer one. */
	seq: number;
	/** True once main answered the focus call with success. */
	settled: boolean;
}

export interface TabWindowSelection {
	/** The tab to show: the pending selection, else the record's active tab. */
	activeTabRef: TabWindowTabRef | null;
	/** Show a tab of this window. */
	selectTab: (type: SingleTabType, id: string) => void;
}

export function useTabWindowSelection(
	agentId: string,
	confirmedRef: TabWindowTabRef | null
): TabWindowSelection {
	const [pending, setPending] = useState<PendingSelection | null>(null);
	const seqRef = useRef(0);

	// Every re-read of the record yields a new ref object, so this runs once
	// per re-read.
	useEffect(() => {
		setPending((current) => {
			if (!current) return current;
			const confirmed = !!confirmedRef && isSameTabRef(current.ref, confirmedRef);
			return confirmed || current.settled ? null : current;
		});
	}, [confirmedRef]);

	const selectTab = useCallback(
		(type: SingleTabType, id: string) => {
			const ref: TabWindowTabRef = { type, id };
			const seq = ++seqRef.current;
			setPending({ ref, seq, settled: false });
			void runTabWindowCall(
				'focus',
				() => window.maestro.tabWindows.focus(agentId, ref),
				(result) => (result.focused ? null : result.error)
			).then((ok) => {
				setPending((current) => {
					if (current?.seq !== seq) return current;
					return ok ? { ...current, settled: true } : null;
				});
			});
		},
		[agentId]
	);

	return { activeTabRef: pending?.ref ?? confirmedRef, selectTab };
}
