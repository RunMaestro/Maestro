import type { MemoryCliProvider, MemoryConfig } from '../../shared/pianola/memory';
import { createOutputParser } from '../../shared/maestro-lib/parsers/parser-factory';
import { extractConcatenatedJsonObjects } from '../process-manager/handlers/StdoutHandler';

export interface MemoryCliInput {
	system: string;
	user: string;
	tokens: number;
	output: number;
	schema: Record<string, unknown>;
}

export interface MemoryCliInvocation {
	command: string;
	args: string[];
	input: string;
	contentType: 'application/json' | 'application/jsonl' | 'text/plain';
	env?: Record<string, string>;
	/** Prompt values that must remain intact when a Windows cmd shim is unavoidable. */
	promptArgs?: string[];
}

export interface MemoryCliResult {
	content: string;
	inputTokens: number;
	outputTokens: number;
}

type Builder = (config: MemoryConfig, input: MemoryCliInput) => MemoryCliInvocation;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function number(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function schemaInstructions(input: MemoryCliInput): string {
	return `${input.system}\n\nReturn JSON matching this JSON Schema:\n${JSON.stringify(input.schema)}`;
}

function combinedPrompt(input: MemoryCliInput): string {
	return `${schemaInstructions(input)}\n\n${input.user}`;
}

function modelArgs(config: MemoryConfig, flag: string): string[] {
	const model = config.model.trim();
	return model ? [flag, model] : [];
}

/** Build one invocation with fixed safety arguments separated from prompt delivery. */
function invocation(
	config: MemoryConfig,
	args: string[],
	input: string,
	contentType: MemoryCliInvocation['contentType'] = 'application/jsonl',
	env?: Record<string, string>
): MemoryCliInvocation {
	if (!config.cliPath) throw new Error('Memory CLI is not configured');
	return { command: config.cliPath, args, input, contentType, ...(env ? { env } : {}) };
}

const BUILDERS: Record<MemoryCliProvider, Builder> = {
	'claude-code': (config, input) =>
		invocation(
			config,
			[
				'--print',
				'--output-format',
				'json',
				'--json-schema',
				JSON.stringify(input.schema),
				'--tools',
				'',
				'--permission-prompts',
				'none',
				'--no-session-persistence',
				'--safe-mode',
				...modelArgs(config, '--model'),
			],
			`${input.system}\n\n${input.user}`,
			'application/json',
			{ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }
		),
	codex: (config, input) =>
		invocation(
			config,
			[
				'exec',
				'--json',
				'--sandbox',
				'read-only',
				'--skip-git-repo-check',
				'--ephemeral',
				'--ignore-rules',
				'-c',
				'mcp_servers={}',
				...modelArgs(config, '-m'),
			],
			combinedPrompt(input)
		),
	antigravity: (config, input) => {
		const prompt = combinedPrompt(input);
		return {
			...invocation(
				config,
				[
					'--output-format',
					'stream-json',
					'--sandbox',
					...modelArgs(config, '--model'),
					'-p',
					prompt,
				],
				''
			),
			promptArgs: [prompt],
		};
	},
	'qwen3-coder': (config, input) =>
		invocation(
			config,
			['--output-format', 'stream-json', '--approval-mode', 'plan', ...modelArgs(config, '-m')],
			combinedPrompt(input)
		),
	hermes: (config, input) =>
		invocation(
			config,
			[
				'chat',
				'--query-file',
				'-',
				'--ignore-rules',
				'--toolsets',
				'',
				'-Q',
				...modelArgs(config, '-m'),
			],
			combinedPrompt(input),
			'text/plain'
		),
	pi: (config, input) =>
		invocation(
			config,
			['-p', '--mode=json', '--no-tools', ...modelArgs(config, '--model')],
			combinedPrompt(input)
		),
	omp: (config, input) => {
		const prompt = combinedPrompt(input);
		return {
			...invocation(
				config,
				[
					'--print',
					'--mode=json',
					'--no-session',
					'--no-tools',
					'--no-extensions',
					'--no-skills',
					'--no-rules',
					'--no-context-files',
					...(config.model.trim() ? [`--model=${config.model.trim()}`] : []),
					'--',
					prompt,
				],
				''
			),
			promptArgs: [prompt],
		};
	},
	opencode: (config, input) =>
		invocation(
			config,
			['run', '--format', 'json', '--agent', 'plan', ...modelArgs(config, '--model')],
			combinedPrompt(input),
			'application/jsonl',
			{
				OPENCODE_CONFIG_CONTENT: '{"permission":{"question":"deny"},"tools":{"question":false}}',
			}
		),
	'factory-droid': (config, input) =>
		invocation(
			config,
			['exec', '-o', 'stream-json', ...modelArgs(config, '-m')],
			combinedPrompt(input)
		),
	'copilot-cli': (config, input) => {
		const prompt = combinedPrompt(input);
		return {
			...invocation(
				config,
				[
					'--output-format',
					'json',
					'--deny-tool=write,shell,memory,github',
					'--deny-tool=read,url',
					'--no-ask-user',
					...modelArgs(config, '--model'),
					'-p',
					prompt,
				],
				''
			),
			promptArgs: [prompt],
		};
	},
	grok: (config, input) => {
		const prompt = combinedPrompt(input);
		return {
			...invocation(
				config,
				[
					'--output-format',
					'streaming-json',
					'--permission-mode',
					'plan',
					'--deny',
					'Bash(*)',
					...modelArgs(config, '-m'),
					'-p',
					prompt,
				],
				''
			),
			promptArgs: [prompt],
		};
	},
};

/** Select a registered provider adapter and build its no-write extraction command. */
export function memoryCliInvocation(
	config: MemoryConfig,
	input: MemoryCliInput
): MemoryCliInvocation {
	if (config.mode !== 'cli' || !config.cliProvider) throw new Error('Memory CLI is not configured');
	return BUILDERS[config.cliProvider](config, input);
}

/** Read Claude's structured envelope and include cache tokens in total input usage. */
function parseClaude(stdout: string, input: MemoryCliInput): MemoryCliResult {
	const envelope: unknown = JSON.parse(stdout);
	if (!record(envelope) || envelope.is_error === true)
		throw new Error('Claude Code CLI extraction failed');
	const content =
		envelope.structured_output !== undefined
			? JSON.stringify(envelope.structured_output)
			: envelope.result;
	if (typeof content !== 'string') throw new Error('Claude Code CLI returned no extraction');
	const usage = record(envelope.usage) ? envelope.usage : {};
	return {
		content,
		inputTokens:
			number(usage.input_tokens, 0) +
				number(usage.cache_creation_input_tokens, 0) +
				number(usage.cache_read_input_tokens, 0) || input.tokens,
		outputTokens: number(usage.output_tokens, input.output),
	};
}

/** Extract the final assistant message and usage from OMP's JSONL event stream. */
function parseOmp(stdout: string, input: MemoryCliInput): MemoryCliResult {
	let content: string | undefined;
	let usage: Record<string, unknown> = {};
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const event: unknown = JSON.parse(line);
		if (!record(event) || event.type !== 'message_end' || !record(event.message)) continue;
		const message = event.message;
		if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
		const text = message.content
			.map((part) => (record(part) && typeof part.text === 'string' ? part.text : ''))
			.join('');
		if (!text.trim()) continue;
		content = text;
		usage = record(message.usage) ? message.usage : {};
	}
	if (!content) throw new Error('Oh My Pi CLI returned no extraction');
	return {
		content,
		inputTokens:
			number(usage.input, 0) + number(usage.cacheRead, 0) + number(usage.cacheWrite, 0) ||
			input.tokens,
		outputTokens: number(usage.output, input.output),
	};
}

/** Normalize final or streamed text and usage through Maestro's provider parser registry. */
function parseWithSharedParser(
	provider: MemoryCliProvider,
	stdout: string,
	input: MemoryCliInput
): MemoryCliResult {
	const parser = createOutputParser(provider);
	if (!parser) throw new Error('Unsupported memory CLI provider');
	const lines =
		provider === 'copilot-cli'
			? extractConcatenatedJsonObjects(stdout).messages
			: stdout.split(/\r?\n/).filter((line) => line.trim());
	let content: string | undefined;
	let streamed = '';
	let lastUsage = { inputTokens: 0, outputTokens: 0 };
	const stepUsage = new Map<string, { inputTokens: number; outputTokens: number }>();
	for (const line of lines) {
		const event = parser.parseJsonLine(line);
		if (!event) continue;
		if (event.type === 'error') throw new Error(provider + ' CLI extraction failed');
		if (event.type === 'text' && !event.isReasoning) streamed += event.text ?? '';
		if (event.type === 'result' && event.text?.trim()) content = event.text;
		if (!event.usage) continue;
		const usage = {
			inputTokens:
				event.usage.inputTokens +
				(provider === 'codex' ? 0 : (event.usage.cacheReadTokens ?? 0)) +
				(event.usage.cacheCreationTokens ?? 0),
			outputTokens: event.usage.outputTokens,
		};
		if (event.usageEventId) stepUsage.set(event.usageEventId, usage);
		else lastUsage = usage;
	}
	if (!content && streamed.trim()) content = streamed;
	if (!content) throw new Error(provider + ' CLI returned no extraction');
	const usage = stepUsage.size ? [...stepUsage.values()] : [lastUsage];
	return {
		content,
		inputTokens: usage.reduce((total, item) => total + item.inputTokens, 0) || input.tokens,
		outputTokens: usage.reduce((total, item) => total + item.outputTokens, 0) || input.output,
	};
}

/** Parse a completed provider response into extraction JSON and bounded token usage. */
export function parseMemoryCliOutput(
	provider: MemoryConfig['cliProvider'],
	stdout: string,
	input: MemoryCliInput
): MemoryCliResult {
	if (provider === 'claude-code') return parseClaude(stdout, input);
	if (provider === 'omp') return parseOmp(stdout, input);
	if (provider === 'hermes') {
		const content = stdout.trim();
		if (!content) throw new Error('Hermes CLI returned no extraction');
		return { content, inputTokens: input.tokens, outputTokens: input.output };
	}
	if (!provider) throw new Error('Memory CLI is not configured');
	return parseWithSharedParser(provider, stdout, input);
}
