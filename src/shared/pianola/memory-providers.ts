import type { MemoryConfig } from './memory';

export type MemoryProviderId = 'local' | 'openai' | 'nan' | 'openai-batch';

export interface MemoryProviderPreset {
	id: MemoryProviderId;
	label: string;
	description: string;
	mode: MemoryConfig['mode'];
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
	config: Pick<MemoryConfig, 'mode' | 'hostedProvider'>
): MemoryProviderId {
	if (config.mode === 'local') return 'local';
	if (config.mode === 'batch') return 'openai-batch';
	return config.hostedProvider ?? 'openai';
}

export function withMemoryProvider(config: MemoryConfig, id: MemoryProviderId): MemoryConfig {
	const preset = memoryProviderPreset(id);
	const sameHostedProvider =
		config.mode !== 'local' &&
		preset.hostedProvider !== undefined &&
		(config.hostedProvider ?? 'openai') === preset.hostedProvider;
	return {
		...config,
		mode: preset.mode,
		hostedProvider: preset.hostedProvider ?? config.hostedProvider,
		model: preset.model,
		inputPrice: preset.inputPrice,
		outputPrice: preset.outputPrice,
		hostedConsent: preset.mode === 'local' ? false : sameHostedProvider && config.hostedConsent,
	};
}
