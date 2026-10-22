/**
 * The Auto Run panel's model pills name where a tier launches for the panel's
 * agent. The hook reads the same layers a launch reads, so what matters here is
 * that each layer reaches the label and that an edit to one is picked up.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTierPillLabel } from '../../../../renderer/hooks/batch/useTierPillLabel';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import type { Session } from '../../../../renderer/types';
import { createMockSession } from '../../../helpers/mockSession';

const OLLAMA = {
	id: 'ep-ollama',
	name: 'Ollama',
	kind: 'ollama' as const,
	baseUrl: 'http://127.0.0.1:11434',
	enabled: true,
};
const ON_OLLAMA = { type: 'source' as const, endpointId: OLLAMA.id, model: 'qwen3:latest' };

function storeAgent(overrides: Partial<Session> = {}): void {
	useSessionStore.setState({
		sessions: [
			createMockSession({
				id: 'agent-1',
				toolType: 'claude-code',
				customModel: 'sonnet',
				...overrides,
			}),
		],
	});
}

describe('useTierPillLabel', () => {
	beforeEach(() => {
		useSettingsStore.setState({ harnessTierDefaults: {}, localModelEndpoints: [OLLAMA] });
		storeAgent();
	});

	it('names the built-in model for an agent that sets nothing', () => {
		const { result } = renderHook(() => useTierPillLabel('agent-1'));
		expect(result.current('high')).toBe('high · opus');
	});

	it("names the agent's own tier target, with the source's saved name", () => {
		storeAgent({ tierTargets: { low: ON_OLLAMA } });
		const { result } = renderHook(() => useTierPillLabel('agent-1'));
		expect(result.current('low')).toBe('low · qwen3:latest · Ollama');
	});

	it('follows the harness default, and an edit to it', () => {
		const { result } = renderHook(() => useTierPillLabel('agent-1'));
		act(() => {
			useSettingsStore.setState({
				harnessTierDefaults: {
					'claude-code': { high: { type: 'provider-model', model: 'opus[1m]' } },
				},
			});
		});
		expect(result.current('high')).toBe('high · opus[1m]');
	});

	it('names nothing for a tier the built-in table maps on an agent that runs on a source', () => {
		storeAgent({ runOn: ON_OLLAMA });
		const { result } = renderHook(() => useTierPillLabel('agent-1'));
		expect(result.current('high')).toBeUndefined();
	});

	it('names nothing for an agent that is gone', () => {
		const { result } = renderHook(() => useTierPillLabel('no-such-agent'));
		expect(result.current('high')).toBeUndefined();
	});

	it('keeps one function while nothing it reads changes', () => {
		const { result, rerender } = renderHook(() => useTierPillLabel('agent-1'));
		const first = result.current;
		// An unrelated edit to the agent must not rebuild the markdown plugins.
		act(() => {
			useSessionStore.setState({
				sessions: useSessionStore.getState().sessions.map((s) => ({ ...s, name: 'renamed' })),
			});
		});
		rerender();
		expect(result.current).toBe(first);
	});
});
