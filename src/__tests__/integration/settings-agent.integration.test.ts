import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storageMocks = vi.hoisted(() => ({
	readAgentConfigs: vi.fn(),
	readAgentConfig: vi.fn(),
	readAgentConfigValue: vi.fn(),
	writeAgentConfigValue: vi.fn(),
	deleteAgentConfigValue: vi.fn(),
}));

const formatterMocks = vi.hoisted(() => ({
	formatSettingsList: vi.fn((entries: Array<{ key: string }>, options: { verbose?: boolean }) => {
		return `settings-list:${entries.map((entry) => entry.key).join(',')}:verbose=${Boolean(options.verbose)}`;
	}),
	formatSettingDetail: vi.fn((entry: { key: string }) => `setting-detail:${entry.key}`),
	formatError: vi.fn((message: string) => `ERROR:${message}`),
	formatSuccess: vi.fn((message: string) => `SUCCESS:${message}`),
	formatWarning: vi.fn((message: string) => `WARNING:${message}`),
}));

const jsonlMocks = vi.hoisted(() => ({
	emitJsonl: vi.fn(),
}));

vi.mock('../../cli/services/storage', () => storageMocks);
vi.mock('../../cli/output/formatter', () => formatterMocks);
vi.mock('../../cli/output/jsonl', () => jsonlMocks);

import {
	settingsAgentGet,
	settingsAgentList,
	settingsAgentReset,
	settingsAgentSet,
} from '../../cli/commands/settings-agent';

describe('settings-agent CLI command integration', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	let exitSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
			throw new Error(`process.exit ${code}`);
		}) as never);

		storageMocks.readAgentConfigs.mockReturnValue({});
		storageMocks.readAgentConfig.mockReturnValue({});
		storageMocks.readAgentConfigValue.mockReturnValue(undefined);
		storageMocks.writeAgentConfigValue.mockReturnValue(true);
		storageMocks.deleteAgentConfigValue.mockReturnValue(true);
	});

	afterEach(() => {
		logSpy.mockRestore();
		errorSpy.mockRestore();
		exitSpy.mockRestore();
	});

	function expectExit(fn: () => void) {
		expect(fn).toThrow('process.exit 1');
		expect(exitSpy).toHaveBeenCalledWith(1);
	}

	it('lists empty, specific, and all agent configuration views in text and JSON modes', () => {
		settingsAgentList('codex', {});
		expect(logSpy).toHaveBeenLastCalledWith('WARNING:No configuration found for agent "codex".');

		settingsAgentList('codex', { json: true });
		expect(logSpy).toHaveBeenLastCalledWith('{}');

		storageMocks.readAgentConfig.mockReturnValueOnce({
			customPath: '/opt/codex',
			customEnvVars: { DEBUG: '1' },
			experimental: true,
		});
		settingsAgentList('codex', { verbose: true });
		expect(formatterMocks.formatSettingsList).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({
					key: 'customPath',
					type: 'string',
					category: 'Agent: codex',
					description: expect.stringContaining('Custom path'),
				}),
				expect.objectContaining({
					key: 'experimental',
					type: 'boolean',
					description: undefined,
				}),
			]),
			{ verbose: true }
		);
		expect(logSpy).toHaveBeenLastCalledWith(
			'settings-list:customPath,customEnvVars,experimental:verbose=true'
		);

		storageMocks.readAgentConfig.mockReturnValueOnce({ model: 'gpt-5.3-codex' });
		settingsAgentList('codex', { json: true, verbose: true });
		expect(jsonlMocks.emitJsonl).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'setting',
				agentId: 'codex',
				key: 'model',
				valueType: 'string',
				description: expect.stringContaining('Model override'),
			})
		);

		settingsAgentList(undefined, {});
		expect(logSpy).toHaveBeenLastCalledWith('WARNING:No agent configurations found.');

		settingsAgentList(undefined, { json: true });
		expect(logSpy).toHaveBeenLastCalledWith('{}');

		storageMocks.readAgentConfigs.mockReturnValueOnce({
			opencode: { contextWindow: 128000 },
			claude: { customArgs: '--fast' },
		});
		settingsAgentList(undefined, { verbose: true });
		expect(logSpy).toHaveBeenLastCalledWith(
			'settings-list:claude.customArgs,opencode.contextWindow:verbose=true'
		);

		storageMocks.readAgentConfigs.mockReturnValueOnce({
			codex: { reasoningEffort: 'high' },
		});
		settingsAgentList(undefined, { json: true, verbose: true });
		expect(jsonlMocks.emitJsonl).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'setting',
				key: 'codex.reasoningEffort',
				value: 'high',
				description: expect.stringContaining('Reasoning effort'),
			})
		);
	});

	it('gets agent config values in JSON, verbose, object, primitive, and undefined modes', () => {
		storageMocks.readAgentConfigValue.mockReturnValueOnce('gpt-5.3-codex');
		settingsAgentGet('codex', 'model', { json: true, verbose: true });
		expect(jsonlMocks.emitJsonl).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'setting',
				agentId: 'codex',
				key: 'model',
				valueType: 'string',
				description: expect.stringContaining('Model override'),
			})
		);

		storageMocks.readAgentConfigValue.mockReturnValueOnce('/opt/codex');
		settingsAgentGet('codex', 'customPath', { verbose: true });
		expect(logSpy).toHaveBeenLastCalledWith('setting-detail:customPath');

		storageMocks.readAgentConfigValue.mockReturnValueOnce({ DEBUG: '1' });
		settingsAgentGet('codex', 'customEnvVars', {});
		expect(logSpy).toHaveBeenLastCalledWith(JSON.stringify({ DEBUG: '1' }, null, 2));

		storageMocks.readAgentConfigValue.mockReturnValueOnce(42);
		settingsAgentGet('codex', 'unknownNumber', {});
		expect(logSpy).toHaveBeenLastCalledWith('42');

		storageMocks.readAgentConfigValue.mockReturnValueOnce(undefined);
		settingsAgentGet('codex', 'missing', {});
		expect(logSpy).toHaveBeenLastCalledWith('');
	});

	it('sets parsed values and raw JSON values in text and JSON modes', () => {
		const cases: Array<[string, unknown]> = [
			['true', true],
			['false', false],
			['null', null],
			['42', 42],
			['08', '08'],
			['', ''],
			['["a","b"]', ['a', 'b']],
			['{"x":1}', { x: 1 }],
			['{broken', '{broken'],
		];

		for (const [input, expected] of cases) {
			settingsAgentSet('codex', 'customArgs', input, {});
			expect(storageMocks.writeAgentConfigValue).toHaveBeenLastCalledWith(
				'codex',
				'customArgs',
				expected
			);
		}

		storageMocks.readAgentConfigValue.mockReturnValueOnce('old-model');
		settingsAgentSet('codex', 'model', 'ignored', { json: true, raw: '{"provider":"openai"}' });
		expect(storageMocks.writeAgentConfigValue).toHaveBeenLastCalledWith('codex', 'model', {
			provider: 'openai',
		});
		expect(jsonlMocks.emitJsonl).toHaveBeenCalledWith({
			type: 'setting_set',
			agentId: 'codex',
			key: 'model',
			oldValue: 'old-model',
			newValue: { provider: 'openai' },
		});
		expect(logSpy).toHaveBeenCalledWith('SUCCESS:codex.customArgs = "{broken"');
	});

	it('resets existing config keys in text and JSON modes', () => {
		storageMocks.readAgentConfigValue.mockReturnValueOnce('/opt/codex');
		storageMocks.deleteAgentConfigValue.mockReturnValueOnce(true);
		settingsAgentReset('codex', 'customPath', {});
		expect(logSpy).toHaveBeenLastCalledWith('SUCCESS:codex.customPath removed');

		storageMocks.readAgentConfigValue.mockReturnValueOnce('gpt-5.3-codex');
		storageMocks.deleteAgentConfigValue.mockReturnValueOnce(true);
		settingsAgentReset('codex', 'model', { json: true });
		expect(jsonlMocks.emitJsonl).toHaveBeenCalledWith({
			type: 'setting_reset',
			agentId: 'codex',
			key: 'model',
			oldValue: 'gpt-5.3-codex',
			defaultValue: undefined,
		});
	});

	it('formats list, get, set, and reset failures before exiting', () => {
		storageMocks.readAgentConfigs.mockImplementationOnce(() => {
			throw new Error('cannot read configs');
		});
		expectExit(() => settingsAgentList(undefined, {}));
		expect(errorSpy).toHaveBeenLastCalledWith(
			'ERROR:Failed to list agent configs: cannot read configs'
		);

		storageMocks.readAgentConfigs.mockImplementationOnce(() => {
			throw 'bad disk';
		});
		expectExit(() => settingsAgentList(undefined, { json: true }));
		expect(errorSpy).toHaveBeenLastCalledWith(JSON.stringify({ error: 'Unknown error' }));

		storageMocks.readAgentConfigValue.mockImplementationOnce(() => {
			throw new Error('missing value');
		});
		expectExit(() => settingsAgentGet('codex', 'model', {}));
		expect(errorSpy).toHaveBeenLastCalledWith('ERROR:missing value');

		storageMocks.readAgentConfigValue.mockImplementationOnce(() => {
			throw new Error('missing json value');
		});
		expectExit(() => settingsAgentGet('codex', 'model', { json: true }));
		expect(errorSpy).toHaveBeenLastCalledWith(JSON.stringify({ error: 'missing json value' }));

		expectExit(() => settingsAgentSet('codex', 'model', 'ignored', { raw: '{broken' }));
		expect(errorSpy).toHaveBeenLastCalledWith(
			expect.stringContaining('ERROR:Failed to set "codex.model": Invalid JSON in --raw:')
		);

		storageMocks.writeAgentConfigValue.mockImplementationOnce(() => {
			throw new Error('write failed');
		});
		expectExit(() => settingsAgentSet('codex', 'model', 'gpt-5', { json: true }));
		expect(errorSpy).toHaveBeenLastCalledWith(JSON.stringify({ error: 'write failed' }));

		storageMocks.deleteAgentConfigValue.mockReturnValueOnce(false);
		expectExit(() => settingsAgentReset('codex', 'missing', {}));
		expect(errorSpy).toHaveBeenLastCalledWith(
			'ERROR:Failed to reset "codex.missing": Key "missing" not found in agent "codex" config.'
		);

		storageMocks.deleteAgentConfigValue.mockImplementationOnce(() => {
			throw 'delete failed';
		});
		expectExit(() => settingsAgentReset('codex', 'model', { json: true }));
		expect(errorSpy).toHaveBeenLastCalledWith(JSON.stringify({ error: 'Unknown error' }));
	});
});
