import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../cli/services/storage', () => ({
	readAgentConfigs: vi.fn(),
	readAgentConfig: vi.fn(),
	readAgentConfigValue: vi.fn(),
	writeAgentConfigValue: vi.fn(),
	deleteAgentConfigValue: vi.fn(),
}));

vi.mock('../../../cli/output/formatter', () => ({
	formatSettingsList: vi.fn((entries, options) => ({
		kind: 'settings-list',
		entries,
		options,
	})),
	formatSettingDetail: vi.fn((display) => ({
		kind: 'setting-detail',
		display,
	})),
	formatError: vi.fn((message) => `error:${message}`),
	formatSuccess: vi.fn((message) => `success:${message}`),
	formatWarning: vi.fn((message) => `warning:${message}`),
}));

vi.mock('../../../cli/output/jsonl', () => ({
	emitJsonl: vi.fn(),
}));

import {
	settingsAgentGet,
	settingsAgentList,
	settingsAgentReset,
	settingsAgentSet,
} from '../../../cli/commands/settings-agent';
import {
	deleteAgentConfigValue,
	readAgentConfig,
	readAgentConfigs,
	readAgentConfigValue,
	writeAgentConfigValue,
} from '../../../cli/services/storage';
import {
	formatError,
	formatSettingDetail,
	formatSettingsList,
	formatSuccess,
	formatWarning,
} from '../../../cli/output/formatter';
import { emitJsonl } from '../../../cli/output/jsonl';

describe('settings-agent command', () => {
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
	let processExitSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi
			.spyOn(process, 'exit')
			.mockImplementation((code?: string | number | null | undefined) => {
				throw new Error(`process.exit(${code})`);
			});
	});

	afterEach(() => {
		consoleLogSpy.mockRestore();
		consoleErrorSpy.mockRestore();
		processExitSpy.mockRestore();
	});

	it('lists a specific agent config in human and JSONL modes', () => {
		vi.mocked(readAgentConfig).mockReturnValue({
			customPath: '/usr/local/bin/claude',
			customFlag: true,
		});

		settingsAgentList('claude-code', { verbose: true });

		expect(formatSettingsList).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					key: 'customPath',
					value: '/usr/local/bin/claude',
					type: 'string',
					category: 'Agent: claude-code',
					description: expect.stringContaining('Custom path'),
				}),
				expect.objectContaining({
					key: 'customFlag',
					value: true,
					type: 'boolean',
					category: 'Agent: claude-code',
					description: undefined,
				}),
			],
			{ verbose: true }
		);
		expect(consoleLogSpy).toHaveBeenCalledWith(expect.objectContaining({ kind: 'settings-list' }));

		settingsAgentList('claude-code', { json: true, verbose: true });

		expect(emitJsonl).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'setting',
				agentId: 'claude-code',
				key: 'customPath',
				valueType: 'string',
				description: expect.stringContaining('Custom path'),
			})
		);
		expect(emitJsonl).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'setting',
				agentId: 'claude-code',
				key: 'customFlag',
				valueType: 'boolean',
			})
		);
	});

	it('handles empty agent configs for specific and global listings', () => {
		vi.mocked(readAgentConfig).mockReturnValue({});
		vi.mocked(readAgentConfigs).mockReturnValue({});

		settingsAgentList('missing-agent', {});
		settingsAgentList('missing-agent', { json: true });
		settingsAgentList(undefined, {});
		settingsAgentList(undefined, { json: true });

		expect(formatWarning).toHaveBeenCalledWith('No configuration found for agent "missing-agent".');
		expect(formatWarning).toHaveBeenCalledWith('No agent configurations found.');
		expect(consoleLogSpy).toHaveBeenCalledWith(
			'warning:No configuration found for agent "missing-agent".'
		);
		expect(consoleLogSpy).toHaveBeenCalledWith('warning:No agent configurations found.');
		expect(consoleLogSpy).toHaveBeenCalledWith(JSON.stringify({}));
	});

	it('lists all agent configs sorted by agent id', () => {
		vi.mocked(readAgentConfigs).mockReturnValue({
			zulu: { model: 'gpt-5.4', customEnvVars: { NODE_ENV: 'test' } },
			alpha: { contextWindow: 128000 },
		});

		settingsAgentList(undefined, { verbose: true });

		expect(formatSettingsList).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					key: 'alpha.contextWindow',
					value: 128000,
					type: 'number',
					category: 'Agent: alpha',
				}),
				expect.objectContaining({
					key: 'zulu.model',
					value: 'gpt-5.4',
					type: 'string',
					category: 'Agent: zulu',
				}),
				expect.objectContaining({
					key: 'zulu.customEnvVars',
					value: { NODE_ENV: 'test' },
					type: 'object',
					category: 'Agent: zulu',
				}),
			],
			{ verbose: true }
		);

		settingsAgentList(undefined, { json: true, verbose: true });
		expect(emitJsonl).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'setting',
				key: 'alpha.contextWindow',
				valueType: 'number',
				category: 'Agent: alpha',
			})
		);
	});

	it('gets values in JSONL, verbose human, object, primitive, and undefined modes', () => {
		vi.mocked(readAgentConfigValue).mockReturnValueOnce('gpt-5.4');
		settingsAgentGet('codex', 'model', { json: true, verbose: true });
		expect(emitJsonl).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'setting',
				agentId: 'codex',
				key: 'model',
				value: 'gpt-5.4',
				valueType: 'string',
				description: expect.stringContaining('Model override'),
			})
		);

		vi.mocked(readAgentConfigValue).mockReturnValueOnce(128000);
		settingsAgentGet('codex', 'contextWindow', { verbose: true });
		expect(formatSettingDetail).toHaveBeenCalledWith(
			expect.objectContaining({
				key: 'contextWindow',
				type: 'number',
				description: expect.stringContaining('Maximum context window'),
			})
		);

		vi.mocked(readAgentConfigValue).mockReturnValueOnce({ NODE_ENV: 'test' });
		settingsAgentGet('codex', 'customEnvVars', {});
		expect(consoleLogSpy).toHaveBeenCalledWith(JSON.stringify({ NODE_ENV: 'test' }, null, 2));

		vi.mocked(readAgentConfigValue).mockReturnValueOnce(undefined);
		settingsAgentGet('codex', 'unknown', {});
		expect(consoleLogSpy).toHaveBeenCalledWith('');

		vi.mocked(readAgentConfigValue).mockReturnValueOnce(false);
		settingsAgentGet('codex', 'enabled', {});
		expect(consoleLogSpy).toHaveBeenCalledWith('false');
	});

	it('sets parsed values, raw JSON values, and emits human or JSONL output', () => {
		const cases: Array<[string, unknown]> = [
			['true', true],
			['false', false],
			['null', null],
			['42', 42],
			['007', '007'],
			['[1,2]', [1, 2]],
			['{"a":1}', { a: 1 }],
			['{bad json', '{bad json'],
			['plain', 'plain'],
		];
		vi.mocked(readAgentConfigValue).mockReturnValue('old-value');

		for (const [input, expected] of cases) {
			settingsAgentSet('codex', 'model', input, {});
			expect(writeAgentConfigValue).toHaveBeenLastCalledWith('codex', 'model', expected);
			expect(consoleLogSpy).toHaveBeenLastCalledWith(
				`success:codex.model = ${JSON.stringify(expected)}`
			);
		}

		settingsAgentSet('codex', 'customEnvVars', '', {
			raw: '{"FOO":"bar"}',
			json: true,
		});

		expect(writeAgentConfigValue).toHaveBeenLastCalledWith('codex', 'customEnvVars', {
			FOO: 'bar',
		});
		expect(emitJsonl).toHaveBeenCalledWith({
			type: 'setting_set',
			agentId: 'codex',
			key: 'customEnvVars',
			oldValue: 'old-value',
			newValue: { FOO: 'bar' },
		});
	});

	it('resets existing values and reports missing keys as failures', () => {
		vi.mocked(readAgentConfigValue)
			.mockReturnValueOnce('old-model')
			.mockReturnValueOnce('old-path')
			.mockReturnValueOnce(undefined);
		vi.mocked(deleteAgentConfigValue)
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(false);

		settingsAgentReset('codex', 'model', { json: true });
		expect(emitJsonl).toHaveBeenCalledWith({
			type: 'setting_reset',
			agentId: 'codex',
			key: 'model',
			oldValue: 'old-model',
			defaultValue: undefined,
		});

		settingsAgentReset('codex', 'customPath', {});
		expect(consoleLogSpy).toHaveBeenCalledWith('success:codex.customPath removed');

		expect(() => settingsAgentReset('codex', 'missing', {})).toThrow('process.exit(1)');
		expect(formatError).toHaveBeenCalledWith(
			'Failed to reset "codex.missing": Key "missing" not found in agent "codex" config.'
		);
	});

	it('reports storage and parsing failures through the expected output mode', () => {
		vi.mocked(readAgentConfigs).mockImplementationOnce(() => {
			throw new Error('list failed');
		});
		expect(() => settingsAgentList(undefined, {})).toThrow('process.exit(1)');
		expect(formatError).toHaveBeenCalledWith('Failed to list agent configs: list failed');

		vi.mocked(readAgentConfigValue).mockImplementationOnce(() => {
			throw 'get failed';
		});
		expect(() => settingsAgentGet('codex', 'model', { json: true })).toThrow('process.exit(1)');
		expect(consoleErrorSpy).toHaveBeenCalledWith(JSON.stringify({ error: 'Unknown error' }));

		vi.mocked(readAgentConfigValue).mockReturnValueOnce(undefined);
		expect(() =>
			settingsAgentSet('codex', 'customEnvVars', '', { raw: '{bad', json: true })
		).toThrow('process.exit(1)');
		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid JSON in --raw'));

		vi.mocked(readAgentConfigValue).mockImplementationOnce(() => {
			throw new Error('set failed');
		});
		expect(() => settingsAgentSet('codex', 'model', 'gpt-5.4', {})).toThrow('process.exit(1)');
		expect(formatError).toHaveBeenCalledWith('Failed to set "codex.model": set failed');
	});

	it('covers JSON error, unknown metadata, and alternate failure branches', () => {
		vi.mocked(readAgentConfig).mockReturnValue({ customPath: '/bin/claude' });
		settingsAgentList('codex', { json: true });
		expect(emitJsonl).toHaveBeenCalledWith(
			expect.not.objectContaining({ description: expect.any(String) })
		);

		vi.mocked(readAgentConfigs).mockReturnValue({ codex: { unknownKey: 'value' } });
		settingsAgentList(undefined, { json: true });
		expect(emitJsonl).toHaveBeenCalledWith(
			expect.objectContaining({
				key: 'codex.unknownKey',
				valueType: 'string',
			})
		);

		vi.mocked(readAgentConfigs).mockImplementationOnce(() => {
			throw 'list failed';
		});
		expect(() => settingsAgentList(undefined, { json: true })).toThrow('process.exit(1)');
		expect(consoleErrorSpy).toHaveBeenCalledWith(JSON.stringify({ error: 'Unknown error' }));

		vi.mocked(readAgentConfigValue).mockReturnValueOnce(123);
		settingsAgentGet('codex', 'unknownKey', { json: true, verbose: true });
		expect(emitJsonl).toHaveBeenCalledWith(
			expect.objectContaining({
				key: 'unknownKey',
				valueType: 'number',
			})
		);

		vi.mocked(readAgentConfigValue).mockImplementationOnce(() => {
			throw new Error('get failed');
		});
		expect(() => settingsAgentGet('codex', 'model', {})).toThrow('process.exit(1)');
		expect(formatError).toHaveBeenCalledWith('get failed');

		const parseSpy = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
			throw 'bad raw';
		});
		vi.mocked(readAgentConfigValue).mockReturnValueOnce(undefined);
		expect(() => settingsAgentSet('codex', 'customEnvVars', '', { raw: '{bad' })).toThrow(
			'process.exit(1)'
		);
		parseSpy.mockRestore();
		expect(formatError).toHaveBeenCalledWith(
			'Failed to set "codex.customEnvVars": Invalid JSON in --raw: bad raw'
		);

		vi.mocked(readAgentConfigValue).mockReturnValueOnce(undefined);
		vi.mocked(writeAgentConfigValue).mockImplementationOnce(() => {
			throw 'set failed';
		});
		expect(() => settingsAgentSet('codex', 'model', 'gpt-5.4', { json: true })).toThrow(
			'process.exit(1)'
		);
		expect(consoleErrorSpy).toHaveBeenCalledWith(JSON.stringify({ error: 'Unknown error' }));

		vi.mocked(readAgentConfigValue).mockReturnValueOnce(undefined).mockReturnValueOnce(undefined);
		vi.mocked(deleteAgentConfigValue)
			.mockReturnValueOnce(false)
			.mockImplementationOnce(() => {
				throw 'reset failed';
			});
		expect(() => settingsAgentReset('codex', 'missing', { json: true })).toThrow('process.exit(1)');
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			JSON.stringify({
				error: 'Key "missing" not found in agent "codex" config.',
			})
		);
		expect(() => settingsAgentReset('codex', 'missing', {})).toThrow('process.exit(1)');
		expect(formatError).toHaveBeenCalledWith('Failed to reset "codex.missing": Unknown error');
	});
});
