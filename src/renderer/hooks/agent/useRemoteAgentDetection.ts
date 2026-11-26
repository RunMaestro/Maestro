/**
 * useRemoteAgentDetection.ts
 *
 * Detect an agent's binary on the SSH remote its turns run on, so the agent
 * config panel's Path field and Detect button read and act on the machine that
 * runs the agent, as they do for a local agent.
 *
 * The main process runs `command -v <binary>` over SSH (`agents:get` with a
 * remote id, the same probe the remote agent picker uses).
 *
 *   - `path`       the binary the remote resolves, or undefined (not found,
 *                  unreachable, still detecting, or no remote)
 *   - `detecting`  a detection is in flight
 *   - `redetect()` run the detection again; no-op without a remote
 */

import { useState, useEffect, useCallback } from 'react';
import { logger } from '../../utils/logger';

export interface RemoteAgentDetection {
	path: string | undefined;
	detecting: boolean;
	redetect: () => void;
}

/**
 * @param agentId     The provider id to detect.
 * @param sshRemoteId The SSH remote the agent runs on, or null/undefined to
 *                    skip (a local agent).
 */
export function useRemoteAgentDetection(
	agentId: string,
	sshRemoteId: string | null | undefined
): RemoteAgentDetection {
	const [path, setPath] = useState<string | undefined>(undefined);
	const [detecting, setDetecting] = useState(false);
	const [nonce, setNonce] = useState(0);

	const redetect = useCallback(() => {
		if (sshRemoteId) setNonce((n) => n + 1);
	}, [sshRemoteId]);

	// A new agent or remote starts unknown, so another machine's answer never
	// shows; a redetect keeps the current path on screen until the new one lands.
	useEffect(() => {
		setPath(undefined);
	}, [agentId, sshRemoteId]);

	useEffect(() => {
		if (!sshRemoteId) {
			setDetecting(false);
			return;
		}
		let stale = false;
		setDetecting(true);
		void window.maestro.agents
			.get(agentId, sshRemoteId)
			.then((agent) => {
				if (!stale) setPath(agent?.available ? agent.path || undefined : undefined);
			})
			.catch((error: unknown) => {
				logger.error('Failed to detect the agent on its remote', undefined, error);
				if (!stale) setPath(undefined);
			})
			.finally(() => {
				if (!stale) setDetecting(false);
			});
		return () => {
			stale = true;
		};
	}, [agentId, sshRemoteId, nonce]);

	return { path, detecting, redetect };
}
