/**
 * useAutoModelChoice: the Auto model choice as every picker reads it for one
 * agent. The rule is `autoModelChoice()` in `shared/autoTurn.ts`; what is
 * checked here is the hook's own part: no agent is no choice, the settings the
 * renderer holds reach the rule, and the answer does not change identity when
 * a caller hands over a fresh but equal agent object.
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAutoModelChoice } from '../../../../renderer/hooks/agent/useAutoModelChoice';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import type { TierTargets } from '../../../../shared/modelTiers';
import { projectTabProvider } from '../../../../renderer/utils/providerTabSessions';
import type { RunOnTarget } from '../../../../shared/local-models/run-on';

describe('useAutoModelChoice', () => {
	beforeEach(() => {
		// The shipped defaults: no harness tier overrides, the model router off.
		useSettingsStore.setState({
			harnessTierDefaults: {},
			localModelAssignments: {},
			localModelEndpoints: [],
		});
	});

	it('offers nothing when there is no agent', () => {
		expect(renderHook(() => useAutoModelChoice(null)).result.current).toBeNull();
		expect(renderHook(() => useAutoModelChoice(undefined)).result.current).toBeNull();
		// A form's working copy before a provider is picked.
		expect(renderHook(() => useAutoModelChoice({})).result.current).toBeNull();
	});

	it('uses the selected harness defaults without borrowing the agent tier targets', () => {
		const agent = {
			toolType: 'claude-code' as const,
			tierTargets: { medium: { type: 'provider-model' as const, model: 'agent-only' } },
		};
		const { result, rerender } = renderHook(
			({ tabProvider }: { tabProvider: 'claude-code' | 'opencode' }) =>
				useAutoModelChoice(projectTabProvider(agent, { tabProvider, agentSessionId: null }).agent),
			{ initialProps: { tabProvider: 'opencode' } }
		);
		expect(result.current).toBeNull();
		act(() => {
			useSettingsStore.setState({
				harnessTierDefaults: {
					opencode: { medium: { type: 'provider-model', model: 'opencode-default' } },
				},
			});
		});
		expect(result.current?.support.model).toBe(true);
		rerender({ tabProvider: 'claude-code' });
		expect(result.current?.support).toEqual({ model: true, effort: true });
	});

	it('keeps agent tier targets for an explicit pin equal to the default provider', () => {
		const agent = {
			toolType: 'opencode' as const,
			tierTargets: { low: { type: 'provider-model' as const, model: 'agent-model' } },
		};
		const { result } = renderHook(() =>
			useAutoModelChoice(
				projectTabProvider(agent, { tabProvider: 'opencode', agentSessionId: null }).agent
			)
		);
		expect(result.current?.support.model).toBe(true);
	});

	it('reads the selected tab Run on instead of inheriting a foreign agent source', () => {
		const source: RunOnTarget = { type: 'source', endpointId: 'ollama', model: 'local-model' };
		const agent = { toolType: 'codex' as const, runOn: source };
		const { result, rerender } = renderHook(
			({ runOn }: { runOn?: RunOnTarget }) =>
				useAutoModelChoice(
					projectTabProvider(agent, { tabProvider: 'claude-code', agentSessionId: null, runOn })
						.agent
				),
			{ initialProps: {} }
		);
		expect(result.current?.support).toEqual({ model: true, effort: true });
		rerender({ runOn: source });
		expect(result.current?.support).toEqual({ model: false, effort: true });
	});

	it('offers Auto on both axes for Claude Code, and says the router is off by default', () => {
		const { result } = renderHook(() => useAutoModelChoice({ toolType: 'claude-code' }));

		expect(result.current).not.toBeNull();
		expect(result.current!.support).toEqual({ model: true, effort: true });
		expect(result.current!.routerOn).toBe(false);
		expect(result.current!.title).toContain('Auto: picks the model and the effort for each turn.');
		expect(result.current!.title).toContain('The model router is off');
	});

	it('offers nothing for an agent Auto would change nothing for', () => {
		// No effort ladder Maestro can name, and no tier mapped to a model.
		const { result } = renderHook(() => useAutoModelChoice({ toolType: 'opencode' }));

		expect(result.current).toBeNull();
	});

	it('offers Auto for that agent once one of its tiers is mapped', () => {
		const tierTargets: TierTargets = { medium: { type: 'provider-model', model: 'x' } };
		const { result } = renderHook(() => useAutoModelChoice({ toolType: 'opencode', tierTargets }));

		expect(result.current).not.toBeNull();
		expect(result.current!.support.model).toBe(true);
	});

	it('offers Auto for that agent when the harness default maps a tier', () => {
		useSettingsStore.setState({
			harnessTierDefaults: { opencode: { low: { type: 'provider-model', model: 'x' } } },
		});
		const { result } = renderHook(() => useAutoModelChoice({ toolType: 'opencode' }));

		expect(result.current?.support.model).toBe(true);
	});

	it('names the router once the model-routing task is assigned one', () => {
		useSettingsStore.setState({
			localModelAssignments: { 'model-routing': { type: 'system-one' } },
		});
		const { result } = renderHook(() => useAutoModelChoice({ toolType: 'claude-code' }));

		expect(result.current!.routerOn).toBe(true);
		expect(result.current!.title).toContain('Decided by System One.');
		expect(result.current!.title).not.toContain('The model router is off');
	});

	it('follows the settings store: assigning a router moves every picker at once', () => {
		const { result } = renderHook(() => useAutoModelChoice({ toolType: 'claude-code' }));
		expect(result.current!.routerOn).toBe(false);

		act(() => {
			useSettingsStore.setState({
				localModelAssignments: { 'model-routing': { type: 'system-one' } },
			});
		});

		expect(result.current!.routerOn).toBe(true);
	});

	it('is the same object across a rerender with a fresh but equal agent', () => {
		// A form passes its working copy, rebuilt on every render. The fields are
		// read one by one, so the nested values keep their identity and the choice
		// is not recomputed.
		const tierTargets: TierTargets = { medium: { type: 'provider-model', model: 'x' } };
		const { result, rerender } = renderHook(() =>
			useAutoModelChoice({ toolType: 'opencode', tierTargets })
		);
		const first = result.current;
		expect(first).not.toBeNull();

		rerender();

		expect(result.current).toBe(first);
	});

	it('recomputes when the agent changes provider', () => {
		const { result, rerender } = renderHook(
			({ toolType }: { toolType: 'claude-code' | 'opencode' }) => useAutoModelChoice({ toolType }),
			{ initialProps: { toolType: 'claude-code' } }
		);
		expect(result.current).not.toBeNull();

		rerender({ toolType: 'opencode' });

		expect(result.current).toBeNull();
	});
});
