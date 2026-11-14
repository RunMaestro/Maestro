/**
 * useSystemOneAgentAccess - whether one agent's System One request would be
 * answered right now, by which engine, and what the agent has spent today.
 *
 * Read on mount, whenever main says the System One settings changed, and
 * whenever `refresh()` is called (the Models tab calls it after its own switch
 * is stored, which is an agent setting and raises no settings event). The read
 * sends nothing to an engine.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { SystemOneAgentAccess } from '../../../shared/local-models/system-one-agent';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';

export interface SystemOneAgentAccessState {
	/** Null until the first read answers. */
	access: SystemOneAgentAccess | null;
	/** Why the last read failed, or null. */
	error: string | null;
	refresh: () => Promise<void>;
}

export function useSystemOneAgentAccess(agentId: string): SystemOneAgentAccessState {
	const [access, setAccess] = useState<SystemOneAgentAccess | null>(null);
	const [error, setError] = useState<string | null>(null);
	const mountedRef = useRef(true);
	// Only the newest read may answer: a slow read must not overwrite a newer one.
	const latestRef = useRef(0);

	const refresh = useCallback(async () => {
		const request = ++latestRef.current;
		try {
			const next = await window.maestro.localModels.systemOne.agentAccess(agentId);
			if (!mountedRef.current || request !== latestRef.current) return;
			setAccess(next);
			setError(null);
		} catch (err) {
			if (!mountedRef.current || request !== latestRef.current) return;
			setError(ipcErrorMessage(err));
		}
	}, [agentId]);

	useEffect(() => {
		mountedRef.current = true;
		void refresh();
		const offChanged = window.maestro.localModels.systemOne.onChanged(() => void refresh());
		return () => {
			mountedRef.current = false;
			offChanged();
		};
	}, [refresh]);

	return { access, error, refresh };
}
