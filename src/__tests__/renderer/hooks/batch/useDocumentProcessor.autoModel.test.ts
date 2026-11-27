/**
 * Auto Run on an agent set to the Auto model: each dispatch is routed, on the
 * text of the tasks it will work, and a `MAESTRO:MODEL` marker always wins on
 * the axes it sets. No decision is not a failed task: the agent's default runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDocumentProcessor } from '../../../../renderer/hooks/batch/useDocumentProcessor';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import type { Session } from '../../../../renderer/types';
import {
	MODEL_ROUTING_UNATTENDED_TIMEOUT_MS,
	type RouteTurnResult,
} from '../../../../shared/local-models/model-routing-task';
import { createMockSession } from '../../../helpers/mockSession';

const routeTurn = vi.fn();

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
		localModels: { ...window.maestro?.localModels, routeTurn },
	} as typeof window.maestro;
}

const routed = (
	tier: 'low' | 'medium' | 'high',
	effort: 'low' | 'medium' | 'high'
): RouteTurnResult => ({
	tier,
	effort,
	engine: { id: 'embedding-router', label: 'Embedding router', calibrated: false },
	latencyMs: 18,
});

describe('useDocumentProcessor - an agent on the Auto model', () => {
	const onSpawnAgent = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		onSpawnAgent.mockResolvedValue({ success: true, response: 'Did the thing.' });
		routeTurn.mockResolvedValue(routed('low', 'low'));
		useSettingsStore.setState({ harnessTierDefaults: {} });
	});

	const runTask = async (
		content: string,
		options: {
			session?: Partial<Session>;
			taskSelectionMode?: 'task' | 'document';
			runOverrides?: Record<string, unknown>;
		} = {}
	) => {
		mockAutorunIpc(content);
		const session = createMockSession({
			id: 'agent-1',
			cwd: '/test/project',
			toolType: 'claude-code',
			customModel: 'auto',
			customEffort: 'high',
			...options.session,
		});
		const { result } = renderHook(() => useDocumentProcessor());
		return result.current.processTask(
			{
				folderPath: '/test/project/.maestro/playbooks',
				session,
				loopIteration: 1,
				effectiveCwd: session.cwd,
				customPrompt: 'Read the playbook rules. {{TASK_SELECTION_BLOCK}}',
				...(options.taskSelectionMode ? { taskSelectionMode: options.taskSelectionMode } : {}),
				...(options.runOverrides ? { runOverrides: options.runOverrides } : {}),
			},
			'phase-1',
			0,
			1,
			content,
			{ onSpawnAgent }
		);
	};

	const spawned = () => onSpawnAgent.mock.calls[0][3];

	it('routes the task and launches on the tier and effort the router chose', async () => {
		await runTask('- [ ] Rename formatDate to formatDay\n- [ ] Design the migration\n');

		expect(routeTurn).toHaveBeenCalledTimes(1);
		expect(spawned()).toEqual({
			modelOverride: 'haiku',
			effortOverride: 'low',
			runOnOverride: undefined,
			// What the router answered, for the task's stats row (`routed_tier`).
			autoStamp: {
				status: 'routed',
				route: { tier: 'low', effort: 'low', engine: 'Embedding router', calibrated: false },
			},
		});
	});

	it('routes the text of the next task, not the playbook prompt, and waits like a turn nobody types at', async () => {
		await runTask(
			'- [x] Survey\n- [ ] Rename formatDate to formatDay\n  - three callers\n- [ ] Design the migration\n'
		);

		expect(routeTurn).toHaveBeenCalledWith({
			prompt: 'Rename formatDate to formatDay\n  - three callers',
			agentId: 'agent-1',
			timeoutMs: MODEL_ROUTING_UNATTENDED_TIMEOUT_MS,
		});
	});

	it('routes every task the dispatch covers in document mode', async () => {
		await runTask('- [ ] Rename formatDate\n- [ ] Design the migration\n', {
			taskSelectionMode: 'document',
		});

		expect(routeTurn.mock.calls[0][0].prompt).toBe('Rename formatDate\n\nDesign the migration');
	});

	it('a marker that sets the tier wins it, and the router still decides the effort', async () => {
		routeTurn.mockResolvedValue(routed('low', 'medium'));
		await runTask('- [ ] Design the migration <!-- MAESTRO:MODEL tier="high" -->\n');

		expect(routeTurn).toHaveBeenCalledTimes(1);
		expect(spawned()).toMatchObject({ modelOverride: 'opus', effortOverride: 'high' });
	});

	it('a marker that sets both axes is not routed at all', async () => {
		await runTask('<!-- MAESTRO:MODEL tier="high" effort="low" -->\n- [ ] Design the migration\n');

		expect(routeTurn).not.toHaveBeenCalled();
		expect(spawned()).toMatchObject({ modelOverride: 'opus', effortOverride: 'low' });
	});

	it('routes when the run ignores the document markers', async () => {
		await runTask('<!-- MAESTRO:MODEL tier="high" effort="high" -->\n- [ ] Rename formatDate\n', {
			runOverrides: { ignoreModelHints: true },
		});

		expect(routeTurn).toHaveBeenCalledTimes(1);
		expect(spawned()).toMatchObject({ modelOverride: 'haiku', effortOverride: 'low' });
	});

	it('with the router off the task runs on the agent default, and is not failed', async () => {
		routeTurn.mockResolvedValue({ skipped: 'off', detail: 'Model routing is off.', latencyMs: 0 });

		const result = await runTask('- [ ] Rename formatDate\n');

		expect(result.success).toBe(true);
		expect(spawned()).toEqual({
			modelOverride: undefined,
			effortOverride: 'high',
			runOnOverride: undefined,
			// Still an Auto turn: the stamp says no router decided, so no tier is recorded.
			autoStamp: {
				status: 'router-off',
				route: { skipped: 'off', detail: 'Model routing is off.' },
			},
		});
	});

	it('a router that cannot be asked costs the decision, never the task', async () => {
		routeTurn.mockRejectedValue(new Error('bridge down'));

		const result = await runTask('- [ ] Rename formatDate\n');

		expect(result.success).toBe(true);
		expect(spawned().modelOverride).toBeUndefined();
	});

	it('launches a tier the agent maps to a source on that source', async () => {
		const local = { type: 'source' as const, endpointId: 'maestro-server', model: 'qwen3.5-4b' };
		await runTask('- [ ] Rename formatDate\n', { session: { tierTargets: { low: local } } });

		expect(spawned()).toMatchObject({ modelOverride: 'qwen3.5-4b', runOnOverride: local });
	});

	it('fails the task by name when the routed tier names a target that cannot be used', async () => {
		const result = await runTask('- [ ] Rename formatDate\n', {
			session: {
				toolType: 'factory-droid',
				tierTargets: { low: { type: 'source', endpointId: 'ep-x', model: 'qwen3' } },
			},
		});

		expect(onSpawnAgent).not.toHaveBeenCalled();
		expect(result.success).toBe(false);
	});

	it('a run that picks a named model is not routed, whatever the agent is set to', async () => {
		await runTask('- [ ] Rename formatDate\n', { runOverrides: { modelOverride: 'sonnet' } });

		expect(routeTurn).not.toHaveBeenCalled();
		expect(spawned().modelOverride).toBe('sonnet');
	});

	it('an agent on a named model is never routed', async () => {
		await runTask('- [ ] Rename formatDate\n', { session: { customModel: 'opus' } });

		expect(routeTurn).not.toHaveBeenCalled();
		expect(spawned().modelOverride).toBe('opus');
		// Not an Auto turn, so there is no stamp and its stats row names no tier.
		expect(spawned()).not.toHaveProperty('autoStamp');
	});

	it('a run that picks Auto routes an agent on a named model', async () => {
		await runTask('- [ ] Rename formatDate\n', {
			session: { customModel: 'opus' },
			runOverrides: { modelOverride: 'auto' },
		});

		expect(routeTurn).toHaveBeenCalledTimes(1);
		expect(spawned().modelOverride).toBe('haiku');
	});
});
