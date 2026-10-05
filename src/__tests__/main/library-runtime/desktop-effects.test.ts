import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createDesktopEffects } from '../../../main/library-runtime/desktop-effects';
import type { LibraryRuntimeEventMessage } from '../../../shared/libraryRuntime';

const agent = (extra: Record<string, unknown> = {}) =>
	({
		id: 'a1',
		name: 'Alpha',
		toolType: 'claude-code',
		cwd: '/p',
		createdAt: 10,
		...extra,
	}) as any;

function setup(initial = [{ id: 'a1', name: 'Alpha' }]) {
	const deps = {
		initialAgents: initial,
		recordSessionCreated: vi.fn(),
		recordSessionClosed: vi.fn(),
		syncProviderSessionName: vi.fn(),
		now: () => 99,
	};
	return { deps, on: createDesktopEffects(deps) };
}

const msg = (
	event: LibraryRuntimeEventMessage['event'],
	extra: Partial<LibraryRuntimeEventMessage> = {}
): LibraryRuntimeEventMessage => ({ event, ...extra });

describe('the desktop side effects', () => {
	it('records an agent created by a command', () => {
		const { deps, on } = setup([]);
		on(
			msg(
				{
					type: 'agent.added',
					agent: agent({ sessionSshRemoteConfig: { enabled: true }, parentSessionId: 'p' }),
				},
				{ origin: { commandId: 'c' } }
			)
		);
		expect(deps.recordSessionCreated).toHaveBeenCalledWith({
			sessionId: 'a1',
			agentType: 'claude-code',
			projectPath: '/p',
			createdAt: 10,
			isRemote: true,
			isWorktree: true,
		});
	});

	it('records an agent created by a remote client, which carries no origin at all', () => {
		const { deps, on } = setup([]);
		on(msg({ type: 'agent.added', agent: agent() }));
		expect(deps.recordSessionCreated).toHaveBeenCalledTimes(1);
	});

	it('ignores what a fold caused: the site that folded does its own bookkeeping', () => {
		const { deps, on } = setup([]);
		on(msg({ type: 'agent.added', agent: agent() }, { fromFold: true }));
		on(msg({ type: 'agent.removed', agentId: 'a1' }, { fromFold: true }));
		expect(deps.recordSessionCreated).not.toHaveBeenCalled();
		expect(deps.recordSessionClosed).not.toHaveBeenCalled();
	});

	it('records a removal with the clock', () => {
		const { deps, on } = setup();
		on(msg({ type: 'agent.removed', agentId: 'a1' }));
		expect(deps.recordSessionClosed).toHaveBeenCalledWith('a1', 99);
	});

	it('syncs the provider session name only when the name changed', () => {
		const { deps, on } = setup();
		on(msg({ type: 'agent.updated', agent: agent() }));
		expect(deps.syncProviderSessionName).not.toHaveBeenCalled();
		on(msg({ type: 'agent.updated', agent: agent({ name: 'Renamed' }) }));
		expect(deps.syncProviderSessionName).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'Renamed' }),
			'Renamed'
		);
		on(msg({ type: 'agent.updated', agent: agent({ name: 'Renamed' }) }));
		expect(deps.syncProviderSessionName).toHaveBeenCalledTimes(1);
	});

	it('keeps names current through a fold, so a later rename is measured against the truth', () => {
		const { deps, on } = setup();
		on(msg({ type: 'agent.updated', agent: agent({ name: 'Folded' }) }, { fromFold: true }));
		expect(deps.syncProviderSessionName).not.toHaveBeenCalled();
		on(msg({ type: 'agent.updated', agent: agent({ name: 'Folded' }) }));
		expect(deps.syncProviderSessionName).not.toHaveBeenCalled();
	});

	it('never lets an effect that throws or rejects reach the runtime', async () => {
		const { deps, on } = setup([]);
		deps.recordSessionCreated.mockImplementation(() => {
			throw new Error('boom');
		});
		deps.recordSessionClosed.mockRejectedValue(new Error('later'));
		expect(() => on(msg({ type: 'agent.added', agent: agent() }))).not.toThrow();
		expect(() => on(msg({ type: 'agent.removed', agentId: 'a1' }))).not.toThrow();
		await Promise.resolve();
	});
});
