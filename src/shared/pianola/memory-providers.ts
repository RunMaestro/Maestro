import type { MemoryCliProviderInfo, MemoryConfig } from './memory';

export type MemoryProviderId = 'local' | 'claude-code' | 'omp' | 'openai' | 'nan' | 'openai-batch';

export interface MemoryProviderPreset {
	id: MemoryProviderId;
	label: string;
	description: string;
	mode: MemoryConfig['mode'];
	cliProvider?: MemoryConfig['cliProvider'];
	hostedProvider?: MemoryConfig['hostedProvider'];
	model: string;
	inputPrice: number;
	outputPrice: number;
	credentialEnv: readonly string[];
}

export const MEMORY_PROVIDER_PRESETS: readonly MemoryProviderPreset[] = [
	{
		id: 'local',
		label: 'On this device (Ollama)',
		description: 'Keep transcript processing on this device.',
		mode: 'local',
		model: 'qwen3:8b',
		inputPrice: 0,
		outputPrice: 0,
		credentialEnv: [],
	},
	{
		id: 'claude-code',
		label: 'Claude Code CLI',
		description: 'Use your existing Claude Code installation and account.',
		mode: 'cli',
		cliProvider: 'claude-code',
		model: '',
		inputPrice: 0,
		outputPrice: 0,
		credentialEnv: [],
	},
	{
		id: 'omp',
		label: 'Oh My Pi CLI',
		description: 'Use your existing Oh My Pi installation and configured account.',
		mode: 'cli',
		cliProvider: 'omp',
		model: '',
		inputPrice: 0,
		outputPrice: 0,
		credentialEnv: [],
	},
	{
		id: 'openai',
		label: 'OpenAI',
		description: 'Send selected transcript excerpts to OpenAI for processing.',
		mode: 'hosted',
		hostedProvider: 'openai',
		model: 'gpt-5.4-mini',
		inputPrice: 0.75,
		outputPrice: 4.5,
		credentialEnv: ['OPENAI_API_KEY'],
	},
	{
		id: 'nan',
		label: 'NaN',
		description: 'Send selected transcript excerpts to NaN for processing.',
		mode: 'hosted',
		hostedProvider: 'nan',
		model: 'qwen3.6',
		inputPrice: 0,
		outputPrice: 0,
		credentialEnv: ['NAN_API_KEY', 'NAN_BUILDERS_API_KEY'],
	},
	{
		id: 'openai-batch',
		label: 'OpenAI Batch',
		description:
			'Process historical sources through OpenAI Batch; completion can take up to 24 hours.',
		mode: 'batch',
		hostedProvider: 'openai',
		model: 'gpt-5.4-mini',
		inputPrice: 0.75,
		outputPrice: 4.5,
		credentialEnv: ['OPENAI_API_KEY'],
	},
];

export function memoryProviderPreset(id: MemoryProviderId): MemoryProviderPreset {
	const preset = MEMORY_PROVIDER_PRESETS.find((candidate) => candidate.id === id);
	if (!preset) throw new Error('Unknown memory provider: ' + id);
	return preset;
}

export function memoryProviderId(
	config: Pick<MemoryConfig, 'mode' | 'hostedProvider' | 'cliProvider'>
): MemoryProviderId {
	if (config.mode === 'local') return 'local';
	if (config.mode === 'cli') return config.cliProvider ?? 'claude-code';
	if (config.mode === 'batch') return 'openai-batch';
	return config.hostedProvider ?? 'openai';
}

export function withMemoryProvider(
	config: MemoryConfig,
	id: MemoryProviderId,
	cliProviders: MemoryCliProviderInfo[] = []
): MemoryConfig {
	const preset = memoryProviderPreset(id);
	const cli = cliProviders.find((provider) => provider.id === preset.cliProvider);
	const sameHostedProvider =
		config.mode !== 'local' &&
		config.mode !== 'cli' &&
		preset.hostedProvider !== undefined &&
		(config.hostedProvider ?? 'openai') === preset.hostedProvider;
	const sameCliProvider =
		config.mode === 'cli' &&
		preset.cliProvider !== undefined &&
		config.cliProvider === preset.cliProvider;
	return {
		...config,
		mode: preset.mode,
		cliProvider: preset.cliProvider ?? config.cliProvider,
		cliPath: preset.mode === 'cli' ? cli?.path : config.cliPath,
		hostedProvider: preset.hostedProvider ?? config.hostedProvider,
		model: cli?.model ?? preset.model,
		inputPrice: preset.inputPrice,
		outputPrice: preset.outputPrice,
		hostedConsent:
			preset.mode === 'local'
				? false
				: (sameHostedProvider || sameCliProvider) && config.hostedConsent,
	};
}
