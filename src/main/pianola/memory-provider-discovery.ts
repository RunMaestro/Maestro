import type { AgentDetector } from '../agents/detector';
import type { getAgentConfigsStore } from '../stores';
import type {
	MemoryCliProvider,
	MemoryCliProviderInfo,
	MemoryConfig,
} from '../../shared/pianola/memory';

const CLI_PROVIDERS: readonly { id: MemoryCliProvider; name: string }[] = [
	{ id: 'claude-code', name: 'Claude Code' },
	{ id: 'omp', name: 'Oh My Pi' },
];

export async function discoverMemoryCliProviders(
	detector: AgentDetector,
	store: ReturnType<typeof getAgentConfigsStore>
): Promise<MemoryCliProviderInfo[]> {
	const configs = store.get('configs', {});
	const providers: MemoryCliProviderInfo[] = [];
	for (const candidate of CLI_PROVIDERS) {
		const agent = await detector.getAgent(candidate.id);
		if (!agent?.available || !agent.path) continue;
		const configuredModel = configs[candidate.id]?.model;
		providers.push({
			id: candidate.id,
			name: candidate.name,
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
