import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentConfig } from '../../../../../types';
import type { AgentSshRemoteConfig } from '../../../../../../shared/types';
import { logger } from '../../../../../utils/logger';
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

	const sshRemoteConfigKey = JSON.stringify(sshRemoteConfig) ?? 'null';

	const detectAgentsWithContext = useCallback(async () => {
		const sshRemoteId = getSshRemoteIdForDetection(sshRemoteConfig);
		return window.maestro.agents.detect(sshRemoteId ?? undefined);
	}, [sshRemoteConfigKey]);
	const sshEnabled = Boolean(sshRemoteConfig?.enabled);

	const refreshAgentDetection = useCallback(async () => {
		const agents = await detectAgentsWithContext();
		const visibleAgents = getVisibleAgents(agents);
		setDetectedAgents(visibleAgents);
		setAvailableAgents(visibleAgents);
	}, [detectAgentsWithContext, setAvailableAgents]);

	useEffect(() => {
		let mounted = true;

		async function detectAgents() {
			setIsDetecting(true);
			setSshConnectionError(null);

			try {
				const agents = await detectAgentsWithContext();
				if (!mounted) return;

				const visibleAgents = getVisibleAgents(agents);

				if (hasSshConnectionFailure(visibleAgents, sshEnabled)) {
					const errorMessage = getConnectionErrors(visibleAgents)[0];
					setSshConnectionError(errorMessage);
					announce(`Unable to connect to remote host: ${errorMessage}`);
					setIsDetecting(false);
					return;
				}

				setDetectedAgents(visibleAgents);
				setAvailableAgents(visibleAgents);

				const availableCount = visibleAgents.filter((agent) => agent.available).length;
				const totalCount = visibleAgents.length;
				let autoSelectedClaude = false;

				if (!selectedAgentRef.current) {
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
						remote: sshEnabled,
						autoSelectedClaude,
					})
				);

				setIsDetecting(false);
			} catch (error) {
				logger.error('Failed to detect agents:', undefined, error);
				if (!mounted) return;

				if (sshEnabled) {
					setSshConnectionError(
						error instanceof Error ? error.message : 'Unknown connection error'
					);
				}
				announce('Failed to detect available agents. Please try again.');
				setIsDetecting(false);
			}
		}

		detectAgents();

		return () => {
			mounted = false;
		};
	}, [announce, detectAgentsWithContext, setAvailableAgents, setSelectedAgent, sshEnabled]);

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
