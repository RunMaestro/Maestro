import { describe, expect, it } from 'vitest';
import {
	buildNativeAcpBaseArgs,
	isHarnessControlMode,
	resolveHarnessControlMode,
	supportsAcpNativeControl,
} from '../../../../shared/maestro-lib/providers/native-control';
import { AGENT_DEFINITIONS } from '../../../../shared/maestro-lib/providers/definitions';
import { resolveHarnessControlSpawnMode } from '../../../../main/ipc/handlers/process/resolve-harness-control-mode';

describe('native control selection', () => {
	it('defaults to current and only opts supported ACP providers into native', () => {
		expect(resolveHarnessControlMode({ toolType: 'qwen3-coder' })).toBe('current');
		expect(
			resolveHarnessControlMode({ toolType: 'qwen3-coder', harnessControlMode: 'native' })
		).toBe('native');
		expect(resolveHarnessControlMode({ toolType: 'codex', harnessControlMode: 'native' })).toBe(
			'current'
		);
		expect(supportsAcpNativeControl('grok')).toBe(true);
		expect(supportsAcpNativeControl('factory-droid')).toBe(true);
		expect(isHarnessControlMode('native')).toBe(true);
		expect(isHarnessControlMode('app-server')).toBe(false);
	});

	it('builds provider-specific native launches without headless prompt flags', () => {
		for (const [id, expected] of [
			['grok', ['agent', 'stdio']],
			['qwen3-coder', ['--acp']],
			['factory-droid', ['exec', '--output-format', 'acp']],
		] as const) {
			const agent = AGENT_DEFINITIONS.find((definition) => definition.id === id);
			expect(agent).toBeDefined();
			expect(buildNativeAcpBaseArgs(agent!, 'standard')).toEqual(expected);
		}
	});

	it('uses the persisted per-agent mode over stale inline data', () => {
		const sessionsStore = {
			get: () => [{ id: 'agent-a', harnessControlMode: 'native' }],
		};
		expect(
			resolveHarnessControlSpawnMode(
				{ toolType: 'qwen3-coder', harnessControlMode: 'current' },
				'agent-a',
				sessionsStore as never
			)
		).toBe('native');
		expect(
			resolveHarnessControlSpawnMode(
				{ toolType: 'qwen3-coder', harnessControlMode: 'native' },
				'missing',
				sessionsStore as never
			)
		).toBe('native');
	});

	it('treats persisted current as authoritative over stale inline native', () => {
		const sessionsStore = { get: () => [{ id: 'agent-a' }] };
		expect(
			resolveHarnessControlSpawnMode(
				{ toolType: 'qwen3-coder', harnessControlMode: 'native' },
				'agent-a',
				sessionsStore as never
			)
		).toBe('current');
	});

	it('resolves native for decorated Auto Run process IDs', () => {
		const sessionsStore = { get: () => [{ id: 'agent-a', harnessControlMode: 'native' }] };
		expect(
			resolveHarnessControlSpawnMode(
				{ toolType: 'qwen3-coder' },
				'agent-a',
				sessionsStore as never,
				'agent-a-batch-123'
			)
		).toBe('native');
	});
});
