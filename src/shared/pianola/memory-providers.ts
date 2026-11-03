import {
	MEMORY_CLI_PROVIDER_IDS,
	type MemoryCliProvider,
	type MemoryCliProviderInfo,
	type MemoryConfig,
} from './memory';

export type MemoryProviderId = 'local' | 'openai' | 'nan' | 'openai-batch' | MemoryCliProvider;

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

const cliPreset = (id: MemoryCliProvider, label: string): MemoryProviderPreset => ({
	id,
	label: `${label} CLI`,
	description: `Use your existing ${label} installation and account.`,
	mode: 'cli',
	cliProvider: id,
	model: '',
	inputPrice: 0,
	outputPrice: 0,
	credentialEnv: [],
});

const CLI_LABELS: Record<MemoryCliProvider, string> = {
	'claude-code': 'Claude Code',
	codex: 'Codex',
	antigravity: 'Antigravity',
	'qwen3-coder': 'Qwen3 Coder',
	hermes: 'Hermes',
	pi: 'Pi',
	omp: 'Oh My Pi',
	opencode: 'OpenCode',
	'factory-droid': 'Factory Droid',
	'copilot-cli': 'Copilot',
	grok: 'Grok',
};

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
	...MEMORY_CLI_PROVIDER_IDS.map((id) => cliPreset(id, CLI_LABELS[id])),
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

/** Find a local, CLI, or API preset or reject an unsupported provider id. */
export function memoryProviderPreset(id: MemoryProviderId): MemoryProviderPreset {
	const preset = MEMORY_PROVIDER_PRESETS.find((candidate) => candidate.id === id);
	if (!preset) throw new Error('Unknown memory provider: ' + id);
	return preset;
}

/** Derive the picker id from saved local, CLI, hosted, or batch configuration. */
export function memoryProviderId(
	config: Pick<MemoryConfig, 'mode' | 'hostedProvider' | 'cliProvider'>
): MemoryProviderId {
	if (config.mode === 'local') return 'local';
	if (config.mode === 'cli') return config.cliProvider ?? 'claude-code';
	if (config.mode === 'batch') return 'openai-batch';
	return config.hostedProvider ?? 'openai';
}

/** Apply detected provider defaults while preserving unrelated settings and valid consent. */
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
