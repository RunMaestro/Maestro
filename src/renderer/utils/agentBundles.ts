/**
 * Which agents the Left Bar and the command palette offer Export Agent for.
 */

import type { Session } from '../types';

/** Whether an agent can be exported: not a terminal, not the Pianola manager. */
export function canExportAgent(session: Pick<Session, 'toolType' | 'isPianola'>): boolean {
	return session.toolType !== 'terminal' && !session.isPianola;
}
