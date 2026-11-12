/**
 * Tests for creating the agent a New Agent draft describes from outside App's hook tree: the
 * registered creator is the only create path, and the created agent is handed back only once the
 * session store holds it. The wait ends on the store change that adds the agent (never on a timer),
 * and a bound stops a creator that never stores its agent from holding the caller forever.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NewAgentDraft } from '../../../renderer/components/NewInstanceModal/types';
import {
	createAgentFromDraft,
	NEW_AGENT_STORE_TIMEOUT_MS,
	registerNewAgentCreator,
} from '../../../renderer/services/newAgentCreation';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Session } from '../../../renderer/types';
import { createMockSession, resetStores } from '../../helpers';

const draft: NewAgentDraft = {
	agentId: 'claude-code',
	workingDir: '/work/research',
	name: 'Market Research',
};

function addAgent(session: Session): void {
	useSessionStore.setState((state) => ({ sessions: [...state.sessions, session] }));
}

/**
 * Count the session-store listeners held right now. A pass-through spy: the real subscription
 * still fires, and each unsubscribe is counted once.
 */
function trackStoreListeners(): { held: () => number } {
	const realSubscribe = useSessionStore.subscribe;
	let held = 0;
	vi.spyOn(useSessionStore, 'subscribe').mockImplementation((listener) => {
		const off = realSubscribe(listener);
		held += 1;
		let released = false;
		return () => {
			if (!released) {
				released = true;
				held -= 1;
			}
			off();
		};
	});
	return { held: () => held };
}

beforeEach(() => {
	resetStores(useSessionStore);
	useSessionStore.setState({ sessions: [createMockSession({ id: 'existing', name: 'Existing' })] });
});

afterEach(() => {
	registerNewAgentCreator(null);
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('createAgentFromDraft', () => {
	it('creates through the registered creator and resolves the stored agent', async () => {
		const created = createMockSession({ id: 'new-agent', name: 'Market Research' });
		const creator = vi.fn(async () => {
			addAgent(created);
			return created.id;
		});
		registerNewAgentCreator(creator);

		const session = await createAgentFromDraft(draft);

		expect(creator).toHaveBeenCalledTimes(1);
		expect(creator).toHaveBeenCalledWith(draft);
		expect(session).toBe(useSessionStore.getState().sessions.find((s) => s.id === 'new-agent'));
	});

	it('holds no store listener when the agent is already stored', async () => {
		const listeners = trackStoreListeners();
		registerNewAgentCreator(async () => {
			addAgent(createMockSession({ id: 'new-agent' }));
			return 'new-agent';
		});

		await createAgentFromDraft(draft);

		expect(useSessionStore.subscribe).not.toHaveBeenCalled();
		expect(listeners.held()).toBe(0);
	});

	it('resolves null and waits for nothing when the creator created no agent', async () => {
		const listeners = trackStoreListeners();
		registerNewAgentCreator(async () => null);

		await expect(createAgentFromDraft(draft)).resolves.toBeNull();

		expect(useSessionStore.subscribe).not.toHaveBeenCalled();
		expect(listeners.held()).toBe(0);
		expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(['existing']);
	});

	it('waits for the store change that adds the agent, however long that takes', async () => {
		vi.useFakeTimers();
		const listeners = trackStoreListeners();
		registerNewAgentCreator(async () => 'late-agent');
		let settled: Session | null | undefined;
		const pending = createAgentFromDraft(draft).then((session) => {
			settled = session;
		});

		// Time alone settles nothing.
		await vi.advanceTimersByTimeAsync(NEW_AGENT_STORE_TIMEOUT_MS - 1);
		expect(settled).toBeUndefined();
		expect(listeners.held()).toBe(1);

		// Another agent arriving is not this one.
		addAgent(createMockSession({ id: 'someone-else' }));
		await Promise.resolve();
		expect(settled).toBeUndefined();

		addAgent(createMockSession({ id: 'late-agent', name: 'Market Research' }));
		await pending;

		expect(settled?.id).toBe('late-agent');
		expect(listeners.held()).toBe(0);
	});

	it('rejects when the agent never reaches the store, and lets go of the store', async () => {
		vi.useFakeTimers();
		const listeners = trackStoreListeners();
		registerNewAgentCreator(async () => 'ghost-agent');
		const pending = createAgentFromDraft(draft);
		const outcome = expect(pending).rejects.toThrow(
			`Agent ghost-agent was created but did not reach the agent list in ${NEW_AGENT_STORE_TIMEOUT_MS} ms`
		);

		await vi.advanceTimersByTimeAsync(NEW_AGENT_STORE_TIMEOUT_MS - 1);
		expect(listeners.held()).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		await outcome;

		expect(listeners.held()).toBe(0);
	});

	it('rejects when no creator is registered', async () => {
		await expect(createAgentFromDraft(draft)).rejects.toThrow(
			'No agent creator is registered: App has not wired createNewSession yet'
		);
		expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(['existing']);
	});

	it('stops creating once the creator is unregistered', async () => {
		const creator = vi.fn(async () => null);
		registerNewAgentCreator(creator);
		registerNewAgentCreator(null);

		await expect(createAgentFromDraft(draft)).rejects.toThrow('No agent creator is registered');
		expect(creator).not.toHaveBeenCalled();
	});

	it('lets a creator fault reach the caller', async () => {
		registerNewAgentCreator(async () => {
			throw new Error('creator broke');
		});

		await expect(createAgentFromDraft(draft)).rejects.toThrow('creator broke');
	});
});
