// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { MemoryModels } from '../../../main/pianola/memory-models';
import { memoryCliInvocation, parseMemoryCliOutput } from '../../../main/pianola/memory-cli';
import { resolveMemoryCliConfig } from '../../../main/pianola/memory-provider-discovery';
import { withMemoryProvider } from '../../../shared/pianola/memory-providers';
import type {
	MemoryCliProvider,
	MemoryConfig,
	MemoryCliProviderInfo,
} from '../../../shared/pianola/memory';
import { MEMORY_CLI_PROVIDER_IDS } from '../../../shared/pianola/memory';
import type { MemoryTransportScope } from '../../../main/pianola/memory-transport';
import { needsWindowsShell } from '../../../shared/maestro-lib/launch/exec-file';

const cliProviders: MemoryCliProviderInfo[] = [
	{ id: 'claude-code', name: 'Claude Code', path: 'C:\\tools\\claude.exe', model: 'sonnet' },
	{ id: 'omp', name: 'Oh My Pi', path: 'C:\\tools\\omp.exe', model: '' },
];
const config: MemoryConfig = {
	enabled: true,
	userId: 'owner',
	roots: [],
	exclusions: [],
	mode: 'cli',
	cliProvider: 'claude-code',
	cliPath: 'C:\\tools\\claude.exe',
	hostedProvider: 'openai',
	endpoint: 'http://127.0.0.1:11434',
	model: '',
	hostedConsent: true,
	inputPrice: 0,
	outputPrice: 0,
	tokenBudget: 100000,
	dollarBudget: 0,
	ongoing: false,
};
const input = {
	system: 'Extract evidence as JSON.',
	user: 'Synthetic untrusted transcript',
	tokens: 100,
	output: 50,
	schema: {
		type: 'object',
		properties: { memories: { type: 'array' } },
		required: ['memories'],
	},
};

it.each(['claude-code', 'omp'] as const)(
	'runs %s without tools and parses its structured response',
	async (provider) => {
		const models = new MemoryModels('unused-cli-test-cache');
		const cli = vi.fn().mockResolvedValue(
			provider === 'claude-code'
				? JSON.stringify({
						type: 'result',
						is_error: false,
						structured_output: { memories: [] },
						usage: {
							input_tokens: 10,
							cache_creation_input_tokens: 20,
							cache_read_input_tokens: 30,
							output_tokens: 4,
						},
					})
				: [
						JSON.stringify({ type: 'agent_start' }),
						JSON.stringify({
							type: 'message_end',
							message: {
								role: 'assistant',
								content: [{ type: 'text', text: '{"memories":[]}' }],
								usage: { input: 40, cacheRead: 10, cacheWrite: 5, output: 4 },
							},
						}),
					].join('\n')
		);
		const current = { ...config, cliProvider: provider };
		const result = await models.extract(current, input, 'job', vi.fn(), undefined, {
			cli,
		} as unknown as MemoryTransportScope);
		expect(result).toMatchObject({
			pending: false,
			records: [],
			inputTokens: provider === 'claude-code' ? 60 : 55,
			outputTokens: 4,
		});
		const [invocation, timeout, operation] = cli.mock.calls[0];
		expect(invocation.command).toBe(current.cliPath);
		expect(invocation.input).toContain(input.user);
		expect(timeout).toBe(600000);
		expect(operation).toBe('cli-extract');
		expect(invocation.args).toContain(provider === 'claude-code' ? '--tools' : '--no-tools');
		expect(invocation.args).not.toContain('--dangerously-skip-permissions');
	}
);

it('uses the detected executable and configured model instead of renderer-supplied paths', () => {
	const resolved = resolveMemoryCliConfig(
		{ ...config, cliPath: 'C:\\untrusted\\fake.exe', model: '' },
		cliProviders
	);
	expect(resolved.cliPath).toBe('C:\\tools\\claude.exe');
	expect(resolved.model).toBe('sonnet');
	expect(() => resolveMemoryCliConfig(config, [])).toThrow('not installed');
});

it('auto-fills CLI defaults and requires consent for a newly selected account', () => {
	const next = withMemoryProvider(
		{ ...config, mode: 'hosted', hostedProvider: 'openai', model: 'gpt-5.4-mini' },
		'claude-code',
		cliProviders
	);
	expect(next).toMatchObject({
		mode: 'cli',
		cliProvider: 'claude-code',
		cliPath: 'C:\\tools\\claude.exe',
		model: 'sonnet',
		hostedConsent: false,
	});
});

it.each(MEMORY_CLI_PROVIDER_IDS)(
	'builds a non-destructive %s extraction invocation',
	(provider) => {
		const result = memoryCliInvocation(
			{ ...config, cliProvider: provider, model: 'test-model' },
			input
		);
		expect(result.command).toBe(config.cliPath);
		expect(result.args.join(' ')).toContain('test-model');
		expect(result.args.join(' ')).not.toMatch(
			/dangerously|skip-permissions-unsafe|--allow-all(?:\s|$)|--yolo(?:\s|$)/
		);
	}
);

const OUTPUT_FIXTURES: Partial<Record<MemoryCliProvider, string>> = {
	codex: JSON.stringify({
		type: 'item.completed',
		item: { type: 'agent_message', text: '{"memories":[]}' },
	}),
	antigravity: JSON.stringify({
		event: 'result',
		result: { response: '{"memories":[]}', usage: { input_tokens: 10, output_tokens: 4 } },
	}),
	'qwen3-coder': JSON.stringify({
		type: 'result',
		is_error: false,
		result: '{"memories":[]}',
		usage: { input_tokens: 10, output_tokens: 4 },
	}),
	hermes: '{"memories":[]}',
	pi: JSON.stringify({
		type: 'agent_end',
		messages: [
			{
				role: 'assistant',
				content: [{ type: 'text', text: '{"memories":[]}' }],
				usage: { input: 10, output: 4 },
			},
		],
	}),
	opencode: [
		JSON.stringify({ type: 'text', part: { type: 'text', text: '{"memories":[]}' } }),
		JSON.stringify({
			type: 'step_finish',
			part: { id: 'step-1', tokens: { input: 10, output: 4 } },
		}),
	].join('\n'),
	'factory-droid': JSON.stringify({
		type: 'completion',
		finalText: '{"memories":[]}',
		usage: { input_tokens: 10, output_tokens: 4 },
	}),
	'copilot-cli': JSON.stringify({
		type: 'assistant.message',
		data: { content: '{"memories":[]}', outputTokens: 4 },
	}),
	grok: [
		JSON.stringify({ type: 'text', data: '{"memories":[]}' }),
		JSON.stringify({ type: 'end', stop_reason: 'end_turn' }),
	].join('\n'),
};

it.each(Object.entries(OUTPUT_FIXTURES))('parses %s extraction output', (provider, output) => {
	const result = parseMemoryCliOutput(provider as MemoryCliProvider, output, input);
	expect(result.content).toBe('{"memories":[]}');
	expect(result.inputTokens).toBeGreaterThan(0);
	expect(result.outputTokens).toBeGreaterThan(0);
});

it('recognizes quoted Windows command shims', () => {
	expect(needsWindowsShell('"C:\\Program Files\\Codex\\codex.cmd"')).toBe(true);
	expect(needsWindowsShell('"C:\\Program Files\\Claude\\claude.exe"')).toBe(false);
});
