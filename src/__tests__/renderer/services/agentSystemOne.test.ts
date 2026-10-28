/**
 * Tests for the agentSystemOne service - switching System One off for one
 * agent, and getting that to the main process, which is what answers a
 * `maestro-cli s1` request and builds the agent's system prompt.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setAgentSystemOneOptOut } from '../../../renderer/services/agentSystemOne';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Session } from '../../../renderer/types';
import { isSystemOneOptedOut } from '../../../shared/local-models/system-one-agent';

function seed(overrides: Partial<Session> = {}): Session {
	const session = {
		id: 'agent-1',
		name: 'Agent',
		toolType: 'claude-code',
		aiTabs: [],
		...overrides,
	} as unknown as Session;
	useSessionStore.setState({ sessions: [session] });
	return session;
}

const stored = (): Session => useSessionStore.getState().sessions[0];

beforeEach(() => {
	vi.mocked(window.maestro.sessions.setMany).mockReset();
	vi.mocked(window.maestro.sessions.setMany).mockResolvedValue(undefined as never);
});

describe('setAgentSystemOneOptOut', () => {
	it('stores the opt-out and flushes the agent to main', async () => {
		seed();

		expect(await setAgentSystemOneOptOut('agent-1', true)).toEqual({ ok: true, optOut: true });

		expect(stored().systemOneOptOut).toBe(true);
		// Main reads the switch from its own store; the debounced persistence would
		// leave a request sent straight after it answered.
		expect(window.maestro.sessions.setMany).toHaveBeenCalledWith(
			[expect.objectContaining({ id: 'agent-1', systemOneOptOut: true })],
			[]
		);
		// What is stored is what the main-process reader reads.
		expect(isSystemOneOptedOut(stored() as unknown as Record<string, unknown>)).toBe(true);
	});

	it.each([false, null])('removes the field on %j: on is its absence', async (value) => {
		seed({ systemOneOptOut: true });

		expect(await setAgentSystemOneOptOut('agent-1', value)).toEqual({ ok: true, optOut: false });

		expect(stored().systemOneOptOut).toBeUndefined();
		expect(window.maestro.sessions.setMany).toHaveBeenCalledTimes(1);
	});

	it('writes nothing when the switch already stands that way', async () => {
		seed();
		expect(await setAgentSystemOneOptOut('agent-1', false)).toEqual({ ok: true, optOut: false });

		seed({ systemOneOptOut: true });
		expect(await setAgentSystemOneOptOut('agent-1', true)).toEqual({ ok: true, optOut: true });

		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
	});

	it('refuses a value that is not a switch, and an agent that does not exist', async () => {
		seed();

		const bad = await setAgentSystemOneOptOut('agent-1', 'off');
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error).toContain('systemOneOptOut');
		expect(await setAgentSystemOneOptOut('nobody', true)).toEqual({
			ok: false,
			error: 'Agent not found',
		});

		expect(stored().systemOneOptOut).toBeUndefined();
		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
	});

	it('keeps the stored value when the flush fails: the debounced write follows', async () => {
		seed();
		vi.mocked(window.maestro.sessions.setMany).mockRejectedValue(new Error('disk full'));

		expect(await setAgentSystemOneOptOut('agent-1', true)).toEqual({ ok: true, optOut: true });
		expect(stored().systemOneOptOut).toBe(true);
	});
});
