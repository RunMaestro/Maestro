import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AgentConfig } from '../../../../../types';
import type { AgentSshRemoteConfig } from '../../../../../../shared/types';
import { logger } from '../../../../../utils/logger';
import { captureException } from '../../../../../utils/sentry';
import {
	buildDetectionAnnouncement,
	getConnectionErrors,
	getVisibleAgents,
	hasSshConnectionFailure,
} from '../utils/agentAvailability';
import { getSshRemoteIdForDetection } from '../utils/sshConfig';

interface UseAgentDetectionArgs {
	sshRemoteConfig: AgentSshRemoteConfig | undefined;
	selectedAgent: string | null;
	setAvailableAgents: (agents: AgentConfig[]) => void;
	setSelectedAgent: (agentId: string) => void;
}

export function useAgentDetection({
	sshRemoteConfig,
	selectedAgent,
	setAvailableAgents,
	setSelectedAgent,
}: UseAgentDetectionArgs) {
	const [isDetecting, setIsDetecting] = useState(true);
	const [detectedAgents, setDetectedAgents] = useState<AgentConfig[]>([]);
	const [sshConnectionError, setSshConnectionError] = useState<string | null>(null);
	const [announcement, setAnnouncement] = useState('');
	const [announcementKey, setAnnouncementKey] = useState(0);

	const selectedAgentRef = useRef(selectedAgent);
	selectedAgentRef.current = selectedAgent;

	const announce = useCallback((message: string) => {
		setAnnouncement(message);
		setAnnouncementKey((previous) => previous + 1);
	}, []);

	const sshEnabled = Boolean(sshRemoteConfig?.enabled);
	const sshRemoteId = getSshRemoteIdForDetection(sshRemoteConfig);
	const host = useMemo(() => ({ sshEnabled, sshRemoteId }), [sshEnabled, sshRemoteId]);
	const currentHost = useRef<typeof host | undefined>(host);
	currentHost.current = host;
	const detectionRequestRef = useRef(0);

	const detectAgentsWithContext = useCallback(
		async (initial: boolean) => {
			// A saved-path callback may resume after its host has been replaced.
			// It must not supersede the new host's request, even before the IPC call.
			if (currentHost.current !== host) return;
			const requestId = ++detectionRequestRef.current;
			const isCurrentRequest = () =>
				currentHost.current === host && detectionRequestRef.current === requestId;
			if (initial) {
				setIsDetecting(true);
				setDetectedAgents([]);
			}
			// Keep manual refresh controls mounted, but block Continue until the
			// current binary selection has been checked again.
			setAvailableAgents([]);
			setSshConnectionError(null);

			try {
				if (host.sshEnabled && !host.sshRemoteId) {
					throw new Error('Select an SSH remote before detecting agents.');
				}
				const agents = await window.maestro.agents.detect(host.sshRemoteId);
				if (!isCurrentRequest()) return;

				const visibleAgents = getVisibleAgents(agents);

				if (hasSshConnectionFailure(visibleAgents, host.sshEnabled)) {
					const errorMessage = getConnectionErrors(visibleAgents)[0];
					setDetectedAgents([]);
					setAvailableAgents([]);
					setSshConnectionError(errorMessage);
					announce(`Unable to connect to remote host: ${errorMessage}`);
					return;
				}

				setDetectedAgents(visibleAgents);
				setAvailableAgents(visibleAgents);

				const availableCount = visibleAgents.filter((agent) => agent.available).length;
				const totalCount = visibleAgents.length;
				let autoSelectedClaude = false;

				if (initial && !selectedAgentRef.current) {
					const claudeCode = visibleAgents.find(
						(agent) => agent.id === 'claude-code' && agent.available
					);
					if (claudeCode) {
						setSelectedAgent('claude-code');
						autoSelectedClaude = true;
					}
				}

				announce(
					buildDetectionAnnouncement({
						availableCount,
						totalCount,
						remote: host.sshEnabled,
						autoSelectedClaude,
					})
				);
			} catch (error) {
				if (!isCurrentRequest()) return;
				logger.error('Failed to detect agents:', undefined, error);
				captureException(error, {
					extra: { operation: 'agentSelection:detectAgents', remoteMode: host.sshEnabled },
				});
				setDetectedAgents([]);
				setAvailableAgents([]);

				if (host.sshEnabled) {
					setSshConnectionError(
						error instanceof Error ? error.message : 'Unknown connection error'
					);
				}
				announce('Failed to detect available agents. Please try again.');
			} finally {
				if (isCurrentRequest()) setIsDetecting(false);
			}
		},
		[announce, host, setAvailableAgents, setSelectedAgent]
	);

	const refreshAgentDetection = useCallback(
		() => detectAgentsWithContext(false),
		[detectAgentsWithContext]
	);

	useLayoutEffect(() => {
		currentHost.current = host;
		void detectAgentsWithContext(true);

		return () => {
			currentHost.current = undefined;
			detectionRequestRef.current++;
		};
	}, [detectAgentsWithContext, host]);

	return {
		isDetecting,
		detectedAgents,
		sshConnectionError,
		announcement,
		announcementKey,
		announce,
		refreshAgentDetection,
	};
}
