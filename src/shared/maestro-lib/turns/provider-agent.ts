/**
 * A provider as a launch needs it: its definition, whether it is installed here, and where.
 *
 * The desktop's `AgentDetector.getAgent` answers this from a cached detection pass. A host with no
 * detector (the headless runtime) answers it from the same sources a chat turn reads, through
 * `locateProviderBinary`, so a group chat or consult turn finds the binary a chat turn would.
 */

import type { MaestroPaths } from '../paths/resolve';
import { getAgentCapabilities } from '../providers/capabilities';
import { getAgentDefinition, type AgentConfig } from '../providers/definitions';
import { readAgentConfigsStore } from '../store/read-stores';
import { locateProviderBinary, type BinaryProbe } from './provider-binary';

export interface ProviderAgentSources {
	paths: Pick<MaestroPaths, 'agentConfigsFile'>;
	probe?: BinaryProbe;
}

/**
 * The launch description of `providerId`, or null for a provider this build does not know.
 * `available` is false (and `path` absent) when the binary is not on this machine, which is a
 * statement for the caller to word, not an error here.
 */
export async function resolveProviderAgent(
	providerId: string,
	sources: ProviderAgentSources
): Promise<AgentConfig | null> {
	const definition = getAgentDefinition(providerId);
	if (!definition) return null;

	const configs = readAgentConfigsStore(sources.paths.agentConfigsFile);
	const providerConfig =
		configs.status === 'ok'
			? (configs.data.configs?.[providerId] as { customPath?: unknown })
			: undefined;
	const customPath =
		typeof providerConfig?.customPath === 'string' ? providerConfig.customPath : undefined;

	const command = await locateProviderBinary(definition, {
		providerCustomPath: customPath,
		sshEnabled: false,
		probe: sources.probe,
	});
	return {
		...definition,
		available: command !== undefined,
		...(command ? { path: command } : {}),
		capabilities: getAgentCapabilities(providerId),
	};
}
