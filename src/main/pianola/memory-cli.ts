import type { MemoryConfig } from '../../shared/pianola/memory';

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
	contentType: 'application/json' | 'application/jsonl';
}

export interface MemoryCliResult {
	content: string;
	inputTokens: number;
	outputTokens: number;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function number(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function memoryCliInvocation(
	config: MemoryConfig,
	input: MemoryCliInput
): MemoryCliInvocation {
	if (config.mode !== 'cli' || !config.cliPath) throw new Error('Memory CLI is not configured');
	const model = config.model.trim();
	if (config.cliProvider === 'claude-code') {
		return {
			command: config.cliPath,
			args: [
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
				'--system-prompt',
				input.system,
				...(model ? ['--model', model] : []),
			],
			input: input.user,
			contentType: 'application/json',
		};
	}
	if (config.cliProvider === 'omp') {
		return {
			command: config.cliPath,
			args: [
				'--print',
				'--mode=json',
				'--no-session',
				'--no-tools',
				'--no-extensions',
				'--no-skills',
				'--no-rules',
				'--no-context-files',
				'--system-prompt',
				`${input.system}\n\nReturn JSON matching this JSON Schema:\n${JSON.stringify(input.schema)}`,
				...(model ? [`--model=${model}`] : []),
			],
			input: input.user,
			contentType: 'application/jsonl',
		};
	}
	throw new Error('Unsupported memory CLI provider');
}

export function parseMemoryCliOutput(
	provider: MemoryConfig['cliProvider'],
	stdout: string,
	input: MemoryCliInput
): MemoryCliResult {
	if (provider === 'claude-code') {
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
	if (provider === 'omp') {
		let content: string | undefined;
		let usage: Record<string, unknown> = {};
		for (const line of stdout.split(/\r?\n/)) {
			if (!line.trim()) continue;
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
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
	throw new Error('Unsupported memory CLI provider');
}
