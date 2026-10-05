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

const tab = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	agentSessionId: `${id}-session`,
	name: null,
	starred: false,
	...extra,
});

function setup(initial: Array<Record<string, unknown>> = [{ id: 'a1', name: 'Alpha' }]) {
	const deps = {
		initialAgents: initial as any,
		recordSessionCreated: vi.fn(),
		recordSessionClosed: vi.fn(),
		syncProviderSessionName: vi.fn(),
		syncTabName: vi.fn(),
		syncTabStarred: vi.fn(),
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
		await expect(on(msg({ type: 'agent.added', agent: agent() }))).resolves.toBeUndefined();
		await expect(on(msg({ type: 'agent.removed', agentId: 'a1' }))).resolves.toBeUndefined();
	});

	describe('tab renames and stars (Phase 9, task 4)', () => {
		const seeded = () =>
			setup([{ id: 'a1', name: 'Alpha', aiTabs: [tab('t1'), tab('t2', { name: 'Old' })] }]);
		const withTabs = (tabs: unknown[]) => agent({ aiTabs: tabs });

		it('syncs a tab name a command changed, with the tab as the runtime has it', async () => {
			const { deps, on } = seeded();
			await on(
				msg(
					{
						type: 'agent.updated',
						agent: withTabs([tab('t1', { name: 'Fresh' }), tab('t2', { name: 'Old' })]),
					},
					{ origin: { commandId: 'c' } }
				)
			);
			expect(deps.syncTabName).toHaveBeenCalledTimes(1);
			expect(deps.syncTabName).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'a1' }),
				expect.objectContaining({ id: 't1', name: 'Fresh' }),
				'Fresh'
			);
			expect(deps.syncTabStarred).not.toHaveBeenCalled();
		});

		it('syncs a cleared name as the empty string', async () => {
			const { deps, on } = seeded();
			await on(
				msg({ type: 'agent.updated', agent: withTabs([tab('t1'), tab('t2', { name: null })]) })
			);
			expect(deps.syncTabName).toHaveBeenCalledWith(expect.anything(), expect.anything(), '');
		});

		it('syncs a star in either direction', async () => {
			const { deps, on } = seeded();
			await on(
				msg({
					type: 'agent.updated',
					agent: withTabs([tab('t1', { starred: true }), tab('t2', { name: 'Old' })]),
				})
			);
			expect(deps.syncTabStarred).toHaveBeenLastCalledWith(
				expect.anything(),
				expect.objectContaining({ id: 't1' }),
				true
			);
			await on(
				msg({
					type: 'agent.updated',
					agent: withTabs([tab('t1', { starred: false }), tab('t2', { name: 'Old' })]),
				})
			);
			expect(deps.syncTabStarred).toHaveBeenLastCalledWith(
				expect.anything(),
				expect.objectContaining({ id: 't1' }),
				false
			);
			expect(deps.syncTabName).not.toHaveBeenCalled();
		});

		it('does nothing for an event that changed neither, and for a tab it has not seen before', async () => {
			const { deps, on } = seeded();
			await on(
				msg({ type: 'agent.updated', agent: withTabs([tab('t1'), tab('t2', { name: 'Old' })]) })
			);
			await on(
				msg({
					type: 'agent.updated',
					agent: withTabs([
						tab('t1'),
						tab('t2', { name: 'Old' }),
						tab('t3', { name: 'New', starred: true }),
					]),
				})
			);
			expect(deps.syncTabName).not.toHaveBeenCalled();
			expect(deps.syncTabStarred).not.toHaveBeenCalled();
		});

		it('keeps its marks current through a fold, without acting on it', async () => {
			const { deps, on } = seeded();
			await on(
				msg(
					{
						type: 'agent.updated',
						agent: withTabs([tab('t1', { name: 'Folded' }), tab('t2', { name: 'Old' })]),
					},
					{ fromFold: true }
				)
			);
			expect(deps.syncTabName).not.toHaveBeenCalled();
			// The same name again is no change: the fold already moved the mark.
			await on(
				msg({
					type: 'agent.updated',
					agent: withTabs([tab('t1', { name: 'Folded' }), tab('t2', { name: 'Old' })]),
				})
			);
			expect(deps.syncTabName).not.toHaveBeenCalled();
		});

		it('forgets a removed agent, so one created again under the id starts fresh', async () => {
			const { deps, on } = seeded();
			await on(msg({ type: 'agent.removed', agentId: 'a1' }));
			await on(msg({ type: 'agent.added', agent: withTabs([tab('t1', { name: 'Back' })]) }));
			expect(deps.syncTabName).not.toHaveBeenCalled();
		});

		it('returns a promise that settles once every effect it started has, and survives one that fails', async () => {
			const { deps, on } = seeded();
			let release!: () => void;
			deps.syncTabName.mockReturnValue(new Promise<void>((resolve) => (release = resolve)));
			deps.syncTabStarred.mockRejectedValue(new Error('disk'));
			let settled = false;
			const done = Promise.resolve(
				on(
					msg({
						type: 'agent.updated',
						agent: withTabs([tab('t1', { name: 'N', starred: true }), tab('t2', { name: 'Old' })]),
					})
				)
			).then(() => {
				settled = true;
			});
			await Promise.resolve();
			expect(settled).toBe(false);
			release();
			await done;
			expect(settled).toBe(true);
		});
	});
});
