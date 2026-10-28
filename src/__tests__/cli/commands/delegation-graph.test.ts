/**
 * @file delegation-graph.test.ts
 * @description Tests for `maestro-cli delegation graph`: the Delegation Graph
 * read from the stored agents, as an adjacency listing and as the raw model.
 * The graph rules themselves are tested in `shared/delegationGraph.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import type { Group, PeerAccess, SessionInfo } from '../../../shared/types';

vi.mock('../../../cli/services/storage', () => ({
	resolveGroupId: vi.fn((id: string) => id),
	readGroups: vi.fn(() => [] as Group[]),
	readSessions: vi.fn(() => [] as SessionInfo[]),
}));

import { delegationGraph } from '../../../cli/commands/delegation-graph';
import { readGroups, readSessions, resolveGroupId } from '../../../cli/services/storage';

const R: PeerAccess = { read: true, write: false };
const RW: PeerAccess = { read: true, write: true };

function agent(id: string, name: string, extra: Partial<SessionInfo> = {}): SessionInfo {
	return { id, name, toolType: 'claude-code', cwd: '/tmp', ...extra } as SessionInfo;
}

function group(id: string, name: string, emoji = ''): Group {
	return { id, name, emoji, collapsed: false } as Group;
}

/** A manager who delegates down, an employee who only consults up, and a loner. */
function fleet(): SessionInfo[] {
	return [
		agent('m', 'Manager', {
			groupId: 'g1',
			peerAgents: [{ sessionId: 'e', ...RW, description: 'Owns the backend' }],
		}),
		agent('e', 'Employee', { groupId: 'g1', peerAgents: [{ sessionId: 'm', ...R }] }),
		agent('l', 'Loner', { groupId: 'g1' }),
		agent('x', 'Xavier', { groupId: 'g2', peerAgents: [{ sessionId: 'm', ...R }] }),
		agent('y', 'Yara', { groupId: 'g2' }),
	];
}

describe('delegation graph command', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	const printed = () => logSpy.mock.calls.map((call) => String(call[0])).join('\n');
	const json = () => JSON.parse(String(logSpy.mock.calls[0][0]));

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(resolveGroupId).mockImplementation((id: string) => id);
		vi.mocked(readGroups).mockReturnValue([group('g1', 'Backend', '🛠'), group('g2', 'Docs')]);
		vi.mocked(readSessions).mockReturnValue(fleet());
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	describe('every agent', () => {
		it('lists each agent with the edges that leave it and the agents that reach it', () => {
			delegationGraph({});

			const out = printed();
			expect(out).toContain('DELEGATION GRAPH');
			expect(out).toContain('All agents');
			expect(out).toContain('5 agents, 3 edges, 1 mutual pair, 2 with no peers');
			expect(out).toContain(
				'-> Employee (e)  Consult + Delegate [explicit] (mutual) - Owns the backend'
			);
			expect(out).toContain('-> Manager (m)  Consult only [explicit] (mutual)');
			expect(out).toContain('reached by: Employee, Xavier');
			expect(out).toContain('no peers in either direction');
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('does not look a group up when no group is asked for', () => {
			delegationGraph({});

			expect(resolveGroupId).not.toHaveBeenCalled();
		});

		it('prints the raw model under --json, with the scope and the counts', () => {
			delegationGraph({ json: true });

			const out = json();
			expect(out).toMatchObject({
				success: true,
				scope: { kind: 'all' },
				group: null,
				stats: { agents: 5, edges: 3, mutual: 1, isolated: 2, spill: 0, placed: 0 },
			});
			expect(out.nodes.map((node: { name: string }) => node.name)).toEqual([
				'Employee',
				'Loner',
				'Manager',
				'Xavier',
				'Yara',
			]);
			expect(out.edges).toEqual([
				{ id: 'e->m', sourceId: 'e', targetId: 'm', read: true, write: false, source: 'explicit' },
				{
					id: 'm->e',
					sourceId: 'm',
					targetId: 'e',
					read: true,
					write: true,
					description: 'Owns the backend',
					source: 'explicit',
				},
				{ id: 'x->m', sourceId: 'x', targetId: 'm', read: true, write: false, source: 'explicit' },
			]);
		});

		it('says so when there is no agent', () => {
			vi.mocked(readSessions).mockReturnValue([]);

			delegationGraph({});

			expect(printed()).toContain('No agents found.');
		});

		it('draws the edge a group grant derives, and names the grant', () => {
			vi.mocked(readSessions).mockReturnValue([
				agent('a', 'Alice', { groupId: 'g1', groupPeerAccess: R }),
				agent('b', 'Bob', { groupId: 'g1' }),
			]);

			delegationGraph({});

			expect(printed()).toContain('-> Bob (b)  Consult only [group]');
		});

		it('draws no edge for a row with neither bit, the exclusion', () => {
			vi.mocked(readSessions).mockReturnValue([
				agent('a', 'Alice', {
					groupId: 'g1',
					groupPeerAccess: R,
					peerAgents: [{ sessionId: 'b', read: false, write: false }],
				}),
				agent('b', 'Bob', { groupId: 'g1' }),
			]);

			delegationGraph({ json: true });

			expect(json().edges).toEqual([]);
		});
	});

	describe('one group', () => {
		it('lists the group, and marks an agent outside it that an edge joins to it', () => {
			delegationGraph({ group: 'g1' });

			const out = printed();
			expect(out).toContain('🛠 Backend (g1)');
			expect(out).toContain(
				'4 agents, 3 edges, 1 mutual pair, 1 with no peers, 1 outside this scope'
			);
			expect(out).toContain('Xavier (x) [outside the group]');
			expect(out).toContain('reached by nobody in this group');
			// Yara is outside the group and no edge joins her to it.
			expect(out).not.toContain('Yara');
		});

		it('resolves the group the way `open delegation-graph --group` does', () => {
			vi.mocked(resolveGroupId).mockReturnValue('g1');

			delegationGraph({ group: 'g', json: true });

			expect(resolveGroupId).toHaveBeenCalledWith('g');
			expect(json()).toMatchObject({
				scope: { kind: 'group', groupId: 'g1' },
				group: { id: 'g1', name: 'Backend', emoji: '🛠' },
				stats: { agents: 4, spill: 1 },
			});
		});

		it('marks the outside agent `spill` in the model', () => {
			delegationGraph({ group: 'g1', json: true });

			const nodes: { sessionId: string; scope: string }[] = json().nodes;
			expect(nodes.find((node) => node.sessionId === 'x')?.scope).toBe('spill');
			expect(nodes.find((node) => node.sessionId === 'm')?.scope).toBe('in-scope');
		});

		it('leaves the emoji out of the report for a group that has none', () => {
			delegationGraph({ group: 'g2', json: true });

			expect(json().group).toEqual({ id: 'g2', name: 'Docs' });
		});

		it('says so for a group with no agent', () => {
			vi.mocked(readGroups).mockReturnValue([group('g9', 'Empty')]);

			delegationGraph({ group: 'g9' });

			expect(printed()).toContain('No agents in this group.');
		});

		it('refuses a group id that names nothing, and builds no graph', () => {
			vi.mocked(resolveGroupId).mockImplementation(() => {
				throw new Error('Group not found: nope');
			});

			delegationGraph({ group: 'nope' });

			expect(errorSpy.mock.calls[0][0]).toContain('Group not found: nope');
			expect(exitSpy).toHaveBeenCalledWith(1);
			expect(readSessions).not.toHaveBeenCalled();
		});

		it("refuses an ambiguous prefix with the resolver's own message, as JSON under --json", () => {
			vi.mocked(resolveGroupId).mockImplementation(() => {
				throw new Error("Ambiguous group ID 'g'. Matches:\n  g1  Backend\n  g2  Docs");
			});

			delegationGraph({ group: 'g', json: true });

			expect(json()).toMatchObject({ success: false });
			expect(json().error).toContain('Ambiguous group ID');
			expect(exitSpy).toHaveBeenCalledWith(1);
		});

		it('refuses an id the resolver accepted and the group store does not hold', () => {
			vi.mocked(resolveGroupId).mockReturnValue('gone');

			delegationGraph({ group: 'gone' });

			expect(errorSpy.mock.calls[0][0]).toContain('Group not found: gone');
			expect(exitSpy).toHaveBeenCalledWith(1);
		});
	});

	// The verb is a read. It has no path to a write.
	it('reads the stores and writes nothing', () => {
		const before = JSON.stringify(fleet());
		const sessions = fleet();
		vi.mocked(readSessions).mockReturnValue(sessions);

		delegationGraph({});

		expect(JSON.stringify(sessions)).toBe(before);
	});
});
