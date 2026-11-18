/**
 * @file settings-agent.test.ts
 * @description Tests for `maestro-cli settings agent list|get|set|reset`.
 *
 * A provider type (`codex`, `claude-code`) reads maestro-agent-configs.json.
 * The ID of one Left Bar agent reads that agent's own record, where
 * `update-agent` writes (regression: `get <agent-id> codexTransport` returned
 * nothing after `update-agent --codex-transport app-server`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionInfo } from '../../../shared/types';

vi.mock('../../../cli/services/storage', () => ({
	readAgentConfigs: vi.fn(),
	readAgentConfig: vi.fn(),
	readAgentConfigValue: vi.fn(),
	writeAgentConfigValue: vi.fn(),
	deleteAgentConfigValue: vi.fn(),
	getSessionById: vi.fn(),
}));

import {
	settingsAgentGet,
	settingsAgentList,
	settingsAgentSet,
	settingsAgentReset,
} from '../../../cli/commands/settings-agent';
import {
	readAgentConfigs,
	readAgentConfigValue,
	writeAgentConfigValue,
	deleteAgentConfigValue,
	getSessionById,
} from '../../../cli/services/storage';

const codexAgent: SessionInfo = {
	id: 'a1b2c3d4-0000-4000-8000-000000000001',
	name: 'Codex Worker',
	toolType: 'codex',
	cwd: '/repo',
	projectRoot: '/repo',
	codexTransport: 'app-server',
};

function jsonLines(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
	return spy.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])));
}

describe('settings agent', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
			throw new Error(`process.exit(${code})`);
		});
		vi.mocked(readAgentConfigs).mockReturnValue({ codex: { model: 'gpt-5.3-codex' } });
		vi.mocked(getSessionById).mockImplementation((id: string) =>
			codexAgent.id.startsWith(id) ? codexAgent : undefined
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('get', () => {
		it('reads codexTransport from the agent record for an agent ID', () => {
			settingsAgentGet(codexAgent.id, 'codexTransport', { json: true });

			const [line] = jsonLines(logSpy);
			expect(line).toMatchObject({
				type: 'setting',
				scope: 'agent',
				agentId: codexAgent.id,
				key: 'codexTransport',
				value: 'app-server',
				valueType: 'string',
			});
			expect(readAgentConfigValue).not.toHaveBeenCalled();
		});

		it('resolves a unique agent ID prefix', () => {
			settingsAgentGet('a1b2c3d4', 'codexTransport', {});
			expect(logSpy).toHaveBeenCalledWith('app-server');
		});

		it('rejects a key the agent record does not have', () => {
			expect(() => settingsAgentGet(codexAgent.id, 'bogus', { json: true })).toThrow(
				'process.exit(1)'
			);
			const { error } = JSON.parse(String(errorSpy.mock.calls[0][0]));
			expect(error).toContain('Unknown setting "bogus"');
		});

		it('keeps a provider type on the provider config store', () => {
			vi.mocked(readAgentConfigValue).mockReturnValue('gpt-5.3-codex');

			settingsAgentGet('codex', 'model', { json: true });

			expect(readAgentConfigValue).toHaveBeenCalledWith('codex', 'model');
			expect(getSessionById).not.toHaveBeenCalled();
			expect(jsonLines(logSpy)[0]).toMatchObject({
				scope: 'provider',
				agentId: 'codex',
				value: 'gpt-5.3-codex',
			});
		});
	});

	describe('list', () => {
		it("lists the agent's own settings for an agent ID", () => {
			settingsAgentList(codexAgent.id, { json: true });

			const lines = jsonLines(logSpy);
			const transport = lines.find((l) => l.key === 'codexTransport');
			expect(transport).toMatchObject({
				scope: 'agent',
				agentId: codexAgent.id,
				value: 'app-server',
			});
			expect(lines.find((l) => l.key === 'tokenSource')?.value).toBeNull();
		});
	});

	describe('set / reset', () => {
		it('refuses to write provider config under an agent ID', () => {
			expect(() =>
				settingsAgentSet(codexAgent.id, 'codexTransport', 'app-server', { json: true })
			).toThrow('process.exit(1)');
			expect(writeAgentConfigValue).not.toHaveBeenCalled();
			expect(String(errorSpy.mock.calls[0][0])).toContain('update-agent');
		});

		it('refuses to reset provider config under an agent ID', () => {
			expect(() => settingsAgentReset(codexAgent.id, 'codexTransport', { json: true })).toThrow(
				'process.exit(1)'
			);
			expect(deleteAgentConfigValue).not.toHaveBeenCalled();
		});

		it('still writes provider config for a provider type', () => {
			settingsAgentSet('codex', 'contextWindow', '128000', { json: true });
			expect(writeAgentConfigValue).toHaveBeenCalledWith('codex', 'contextWindow', 128000);
		});
	});
});

// `settings agent` for Grok. The provider ID `grok` names the
// provider defaults store; a Grok Left Bar agent reads its own record with the
// Claude-only and Codex-only fields null; a provider write lands in the
// provider store, and a write under a Grok agent ID is refused.
describe('settings agent Grok', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	const grokAgent: SessionInfo = {
		id: 'b2c3d4e5-0000-4000-8000-000000000002',
		name: 'Grok Worker',
		toolType: 'grok',
		cwd: '/repo',
		projectRoot: '/repo',
		customModel: 'grok-code-fast-1',
	};

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
			throw new Error(`process.exit(${code})`);
		});
		vi.mocked(readAgentConfigs).mockReturnValue({ grok: { model: 'grok-4' } });
		vi.mocked(getSessionById).mockImplementation((id: string) =>
			grokAgent.id.startsWith(id) ? grokAgent : undefined
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('reads the grok provider default from the provider store, not an agent record', () => {
		vi.mocked(readAgentConfigValue).mockReturnValue('grok-4');
		settingsAgentGet('grok', 'model', { json: true });
		expect(readAgentConfigValue).toHaveBeenCalledWith('grok', 'model');
		expect(getSessionById).not.toHaveBeenCalled();
		expect(jsonLines(logSpy)[0]).toMatchObject({
			type: 'setting',
			scope: 'provider',
			agentId: 'grok',
			key: 'model',
			value: 'grok-4',
		});
	});

	it("lists a Grok agent's own model with Claude and Codex fields null", () => {
		settingsAgentList(grokAgent.id, { json: true });
		const lines = jsonLines(logSpy);
		const value = (key: string) => lines.find((l) => l.key === key)?.value;
		expect(lines.every((l) => l.scope === 'agent' && l.agentId === grokAgent.id)).toBe(true);
		expect(value('customModel')).toBe('grok-code-fast-1');
		expect(value('tokenSource')).toBeNull();
		expect(value('codexTransport')).toBeNull();
	});

	it('writes the grok model default to the provider store', () => {
		vi.mocked(readAgentConfigValue).mockReturnValue('grok-4');
		settingsAgentSet('grok', 'model', 'grok-code-fast-1', { json: true });
		expect(writeAgentConfigValue).toHaveBeenCalledWith('grok', 'model', 'grok-code-fast-1');
		expect(jsonLines(logSpy)[0]).toMatchObject({
			type: 'setting_set',
			agentId: 'grok',
			key: 'model',
			oldValue: 'grok-4',
			newValue: 'grok-code-fast-1',
		});
	});

	it('refuses a provider write under a Grok agent ID before any write', () => {
		expect(() => settingsAgentSet(grokAgent.id, 'model', 'grok-4', { json: true })).toThrow(
			'process.exit(1)'
		);
		expect(writeAgentConfigValue).not.toHaveBeenCalled();
		expect(JSON.parse(String(errorSpy.mock.calls[0][0])).error).toContain(
			`update-agent ${grokAgent.id}`
		);
	});
});
