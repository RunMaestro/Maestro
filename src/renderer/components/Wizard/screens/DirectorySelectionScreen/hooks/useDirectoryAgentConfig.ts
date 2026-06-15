import { useEffect, useState } from 'react';
import type { AgentConfig, ToolType } from '../../../../../types';
import { logger } from '../../../../../utils/logger';
import { captureException } from '../../../../../utils/sentry';

export function useDirectoryAgentConfig(selectedAgent: ToolType | null): AgentConfig | null {
	const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);

	useEffect(() => {
		let mounted = true;

		async function fetchAgentConfig() {
			if (!selectedAgent) {
				setAgentConfig(null);
				return;
			}

			try {
				const config = await window.maestro.agents.get(selectedAgent);
				if (mounted) {
					setAgentConfig(config || null);
				}
			} catch (error) {
				if (mounted) {
					setAgentConfig(null);
				}
				logger.error('Failed to fetch agent config:', undefined, error);
				captureException(error, {
					extra: {
						context: 'useDirectoryAgentConfig.fetchAgentConfig',
						selectedAgent,
					},
				});
			}
		}

		fetchAgentConfig();
		return () => {
			mounted = false;
		};
	}, [selectedAgent]);

	return agentConfig;
}
