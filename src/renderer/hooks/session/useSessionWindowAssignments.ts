import { useEffect, useMemo, useState } from 'react';
import type { Session } from '../../types';
import type { WindowInfo } from '../../../shared/types/window';
import { orderWindowsForDisplay } from '../../utils/windowOrdering';

export interface SessionWindowAssignment {
	windowId: string;
	windowNumber: number;
}

function windowAssignmentsEqual(
	a: Map<string, SessionWindowAssignment>,
	b: Map<string, SessionWindowAssignment>
): boolean {
	if (a.size !== b.size) {
		return false;
	}
	for (const [sessionId, assignment] of a) {
		const other = b.get(sessionId);
		if (!other || other.windowId !== assignment.windowId || other.windowNumber !== assignment.windowNumber) {
			return false;
		}
	}
	return true;
}

/**
 * Tracks which window currently owns each session.
 * Returns a Map keyed by session ID with window metadata (ID + display number).
 */
export function useSessionWindowAssignments(
	sessions: Session[],
	windowSessionIds: string[]
): Map<string, SessionWindowAssignment> {
	const [assignments, setAssignments] = useState<Map<string, SessionWindowAssignment>>(new Map());
	const sessionIdSignature = useMemo(() => sessions.map((session) => session.id).join('|'), [sessions]);
	const windowSessionSignature = useMemo(() => windowSessionIds.join('|'), [windowSessionIds]);

	useEffect(() => {
		let disposed = false;

		const loadAssignments = async () => {
			try {
				const windowInfos = await window.maestro.windows.list();
				if (disposed) {
					return;
				}
				const ordered = orderWindowsForDisplay(windowInfos);
				const nextAssignments = new Map<string, SessionWindowAssignment>();
				ordered.forEach((info, index) => {
					info.sessionIds.forEach((sessionId) => {
						nextAssignments.set(sessionId, {
							windowId: info.id,
							windowNumber: index + 1,
						});
					});
				});
				setAssignments((prev) => (windowAssignmentsEqual(prev, nextAssignments) ? prev : nextAssignments));
			} catch (error) {
				console.error('[useSessionWindowAssignments] Failed to load window assignments', error);
			}
		};

		loadAssignments();
		return () => {
			disposed = true;
		};
	}, [sessionIdSignature, windowSessionSignature]);

	return assignments;
}
