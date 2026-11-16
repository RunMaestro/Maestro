import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useComposerModelChoices } from '../../../../../renderer/components/InputArea/hooks/useComposerModelChoices';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import { projectTabProvider } from '../../../../../renderer/utils/providerTabSessions';
import type { RunOnTarget } from '../../../../../shared/local-models/run-on';
import { createInputAreaSession } from '../_fixtures';

const OLLAMA = {
	id: 'ollama',
	name: 'Ollama',
	kind: 'ollama' as const,
	baseUrl: 'http://127.0.0.1:11434',
	enabled: true,
};

describe('useComposerModelChoices', () => {
	beforeEach(() => {
		// The shipped defaults: no harness tier overrides, the model router off.
		useSettingsStore.setState({
			harnessTierDefaults: {},
			localModelAssignments: {},
			localModelEndpoints: [OLLAMA],
		});
	});

	describe('the Auto model choice', () => {
		it('offers Auto after (default) for a Claude Code agent, with its tooltip', () => {
			const { result } = renderHook(() =>
				useComposerModelChoices(createInputAreaSession(), ['', 'opus', 'sonnet'], 'opus')
			);

			expect(result.current.modelOptions).toEqual(['', 'auto', 'opus', 'sonnet']);
			expect(result.current.autoModelTitle).toContain(
				'Auto: picks the model and the effort for each turn.'
			);
			expect(result.current.autoModelTitle).toContain('The model router is off');
		});

		it('offers no Auto for an agent it would change nothing for', () => {
			// OpenCode has no effort ladder Maestro can name, and none of this
			// agent's tiers is mapped to a model.
			const { result } = renderHook(() =>
				useComposerModelChoices(createInputAreaSession({ toolType: 'opencode' }), ['opus'], 'opus')
			);

			expect(result.current.modelOptions).toEqual(['opus']);
			expect(result.current.autoModelTitle).toBeUndefined();
		});

		it('offers Auto for that agent once one of its tiers is mapped', () => {
			const agent = createInputAreaSession({
				toolType: 'opencode',
				tierTargets: { medium: { type: 'provider-model', model: 'opus' } },
			});
			const { result } = renderHook(() => useComposerModelChoices(agent, ['opus'], 'opus'));

			expect(result.current.modelOptions).toContain('auto');
		});

		it('names the router while one is assigned', () => {
			useSettingsStore.setState({
				localModelAssignments: { 'model-routing': { type: 'system-one' } },
			});
			const { result } = renderHook(() =>
				useComposerModelChoices(createInputAreaSession(), ['', 'opus'], 'auto')
			);

			expect(result.current.autoModelTitle).toContain('Decided by System One.');
		});
	});

	describe('the model source label', () => {
		it("shows the agent's model source in place of the model", () => {
			const agent = createInputAreaSession({
				runOn: { type: 'source', endpointId: 'ollama', model: 'deepseek-v4.1-flash:cloud' },
			});
			const { result } = renderHook(() => useComposerModelChoices(agent, ['opus[1m]'], 'opus[1m]'));

			expect(result.current.runOn).toBe('deepseek-v4.1-flash:cloud · Ollama');
		});

		it.each([
			[{ type: 'provider' }, undefined],
			[{ type: 'source', endpointId: 'ollama', model: 'tab-model' }, 'tab-model · Ollama'],
		] satisfies [RunOnTarget, string | undefined][])(
			'honors the tab Run on override %j',
			(runOn, expected) => {
				const session = createInputAreaSession({
					runOn: { type: 'source', endpointId: 'ollama', model: 'agent-model' },
				});
				session.aiTabs[0].runOn = runOn;
				const { agent } = projectTabProvider(session, session.aiTabs[0]);
				const { result } = renderHook(() =>
					useComposerModelChoices(agent, ['opus[1m]'], 'opus[1m]')
				);

				expect(result.current.runOn).toBe(expected);
			}
		);

		it('leaves the pill to Auto, which may choose another target', () => {
			const agent = createInputAreaSession({
				runOn: { type: 'source', endpointId: 'ollama', model: 'agent-model' },
			});
			const { result } = renderHook(() => useComposerModelChoices(agent, ['opus[1m]'], 'auto'));

			expect(result.current.runOn).toBeUndefined();
		});
	});
});
