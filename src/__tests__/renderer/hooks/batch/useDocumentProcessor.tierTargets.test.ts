/**
 * Auto Run resolves a task's tier to a TARGET: the agent's own tier targets,
 * then the harness defaults, then the built-in table. What matters here is that
 * the desktop engine hands those layers to the resolution, and that a target
 * that cannot be used fails the task instead of launching on another model.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDocumentProcessor } from '../../../../renderer/hooks/batch/useDocumentProcessor';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import type { Session } from '../../../../renderer/types';
import { createMockSession } from '../../../helpers/mockSession';

const docWithTier = (tier: string) => `<!-- MAESTRO:MODEL tier="${tier}" -->\n- [ ] Do the thing\n`;

function mockAutorunIpc(content: string): void {
	window.maestro = {
		...window.maestro,
		autorun: {
			...window.maestro?.autorun,
			readDoc: vi.fn().mockResolvedValue({ success: true, content }),
			writeDoc: vi.fn().mockResolvedValue({ success: true }),
		},
		agentSessions: {
			...window.maestro?.agentSessions,
			registerSessionOrigin: vi.fn().mockResolvedValue(undefined),
		},
	} as typeof window.maestro;
}

describe('useDocumentProcessor - tier targets', () => {
	const onSpawnAgent = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		onSpawnAgent.mockResolvedValue({ success: true, response: 'Did the thing.' });
		useSettingsStore.setState({ harnessTierDefaults: {} });
	});

	const runTask = async (tier: string, overrides: Partial<Session> = {}) => {
		const content = docWithTier(tier);
		mockAutorunIpc(content);
		const session = createMockSession({
			cwd: '/test/project',
			toolType: 'claude-code',
			customModel: 'sonnet',
			...overrides,
		});
		const { result } = renderHook(() => useDocumentProcessor());
		return result.current.processTask(
			{
				folderPath: '/test/project/.maestro/playbooks',
				session,
				loopIteration: 1,
				effectiveCwd: session.cwd,
				customPrompt: 'Work the document.',
			},
			'phase-1',
			0,
			1,
			content,
			{ onSpawnAgent }
		);
	};

	const spawnedModel = () => onSpawnAgent.mock.calls[0][3]?.modelOverride;

	it('uses the built-in table when no layer sets the tier', async () => {
		await runTask('high');
		expect(spawnedModel()).toBe('opus');
	});

	it('reads the harness default from Settings at dispatch', async () => {
		useSettingsStore.setState({
			harnessTierDefaults: {
				'claude-code': { high: { type: 'provider-model', model: 'opus[1m]' } },
			},
		});
		await runTask('high');
		expect(spawnedModel()).toBe('opus[1m]');
	});

	it("lets the agent's own tier target win over the harness default", async () => {
		useSettingsStore.setState({
			harnessTierDefaults: {
				'claude-code': { high: { type: 'provider-model', model: 'opus[1m]' } },
			},
		});
		await runTask('high', { tierTargets: { high: { type: 'provider-model', model: 'opus' } } });
		expect(spawnedModel()).toBe('opus');
	});

	const spawnedRunOn = () => onSpawnAgent.mock.calls[0][3]?.runOnOverride;

	it('sends the place with the model when the tier names a source', async () => {
		const local = { type: 'source' as const, endpointId: 'maestro-server', model: 'qwen3.5-4b' };
		await runTask('low', { tierTargets: { low: local } });
		expect(spawnedModel()).toBe('qwen3.5-4b');
		expect(spawnedRunOn()).toEqual(local);
	});

	it("sends a source agent's task to the provider when a layer the user wrote names it", async () => {
		await runTask('high', {
			runOn: { type: 'source', endpointId: 'ep-ollama', model: 'qwen3:latest' },
			tierTargets: { high: { type: 'provider-model', model: 'opus' } },
		});
		expect(spawnedModel()).toBe('opus');
		expect(spawnedRunOn()).toEqual({ type: 'provider' });
	});

	it("names no place for a tier only the built-in table maps: the agent's own target stands", async () => {
		await runTask('high');
		expect(spawnedModel()).toBe('opus');
		expect(spawnedRunOn()).toBeUndefined();
	});

	it('fails the task by name, without a spawn, when the tier target cannot be used', async () => {
		const result = await runTask('low', { tierTargets: { low: { type: 'source' } as never } });
		expect(onSpawnAgent).not.toHaveBeenCalled();
		expect(result.success).toBe(false);
		expect(result.fullSynopsis).toContain('This agent\'s "low" tier target cannot be used');
	});
});
