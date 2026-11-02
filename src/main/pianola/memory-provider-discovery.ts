import type { AgentDetector } from '../agents/detector';
import { getAgentDefinition } from '../../shared/maestro-lib/providers/definitions';
import type { getAgentConfigsStore } from '../stores';
import {
	MEMORY_CLI_PROVIDER_IDS,
	type MemoryCliProviderInfo,
	type MemoryConfig,
} from '../../shared/pianola/memory';

export async function discoverMemoryCliProviders(
	detector: AgentDetector,
	store: ReturnType<typeof getAgentConfigsStore>
): Promise<MemoryCliProviderInfo[]> {
	const configs = store.get('configs', {});
	const providers: MemoryCliProviderInfo[] = [];
	for (const id of MEMORY_CLI_PROVIDER_IDS) {
		const agent = await detector.getAgent(id);
		if (!agent?.available || !agent.path) continue;
		const configuredModel = configs[id]?.model;
		providers.push({
			id,
			name: getAgentDefinition(id)?.name ?? id,
			path: agent.path,
			model: typeof configuredModel === 'string' ? configuredModel.trim() : '',
		});
	}
	return providers;
}

export function resolveMemoryCliConfig<T extends Partial<MemoryConfig>>(
	config: T,
	providers: MemoryCliProviderInfo[]
): T {
	if (config.mode !== 'cli') return config;
	const provider = providers.find((candidate) => candidate.id === config.cliProvider);
	if (!provider) throw new Error('Selected memory CLI is not installed or configured');
	return {
		...config,
		cliPath: provider.path,
		model: config.model?.trim() || provider.model,
	};
}

export function memoryApiCredentialPresence(
	env: NodeJS.ProcessEnv = process.env
): Record<string, boolean> {
	return Object.fromEntries(
		['OPENAI_API_KEY', 'NAN_API_KEY', 'NAN_BUILDERS_API_KEY'].map((name) => [
			name,
			typeof env[name] === 'string' && env[name]!.trim().length > 0,
		])
	);
}
