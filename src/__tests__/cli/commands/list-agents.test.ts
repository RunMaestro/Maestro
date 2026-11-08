/**
 * @file list-agents.test.ts
 * @description Tests for the list-agents CLI command
 *
 * Tests all functionality of the list-agents command including:
 * - Human-readable output formatting
 * - JSON output mode
 * - Group filtering
 * - Empty agents handling
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionInfo, Group } from '../../../shared/types';

// Mock the storage service
vi.mock('../../../cli/services/storage', () => {
	const readSessions = vi.fn();
	return {
		readSessions,
		// The live list is the stored list here: no fixture holds a dormant agent.
		readLiveSessions: (...args: unknown[]) => readSessions(...args),
		readGroups: vi.fn(),
		getSessionsByGroup: vi.fn(),
		resolveGroupId: vi.fn((id: string) => id),
	};
});

// Mock the formatter
vi.mock('../../../cli/output/formatter', () => ({
	formatAgents: vi.fn((agents, groupName) => {
		if (agents.length === 0) {
			return groupName ? `No agents in group "${groupName}"` : 'No agents found';
		}
		const header = groupName ? `Agents in "${groupName}":\n` : 'Agents:\n';
		return header + agents.map((a: any) => `${a.name} (${a.toolType})`).join('\n');
	}),
	formatError: vi.fn((msg) => `Error: ${msg}`),
}));

// Federation: the peer resolver and the Encore gate are stood in for, so no SSH is dialed.
vi.mock('../../../cli/services/peer-resolver', () => {
	class PeerResolveError extends Error {
		constructor(
			readonly code: string,
			message: string,
			readonly exitCode: number,
			readonly peer?: string
		) {
			super(message);
		}
	}
	return {
		PeerResolveError,
		connectPeer: vi.fn(),
		listFederationPeers: vi.fn(() => []),
		listHostAgents: vi.fn(),
	};
});

vi.mock('../../../cli/utils/encore-gate', () => ({
	requireEncore: vi.fn(),
}));

import { listAgents } from '../../../cli/commands/list-agents';
import {
	PeerResolveError,
	connectPeer,
	listFederationPeers,
	listHostAgents,
} from '../../../cli/services/peer-resolver';
import { requireEncore } from '../../../cli/utils/encore-gate';
import {
	readSessions,
	readGroups,
	getSessionsByGroup,
	resolveGroupId,
} from '../../../cli/services/storage';
import { formatAgents, formatError } from '../../../cli/output/formatter';

describe('list-agents command', () => {
	let consoleSpy: ReturnType<typeof vi.spyOn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
	let processExitSpy: ReturnType<typeof vi.spyOn>;

	const mockSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
		id: 'sess-1',
		name: 'Test Agent',
		toolType: 'claude-code',
		cwd: '/path/to/project',
		groupId: undefined,
		autoRunFolderPath: undefined,
		...overrides,
	});

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi
			.spyOn(process, 'exit')
			.mockImplementation((code?: string | number | null | undefined) => {
				throw new Error(`process.exit(${code})`);
			});
	});

	afterEach(() => {
		consoleSpy.mockRestore();
		consoleErrorSpy.mockRestore();
		processExitSpy.mockRestore();
	});

	describe('human-readable output', () => {
		it('should display agents in human-readable format', () => {
			const mockSessions: SessionInfo[] = [
				mockSession({ id: 'a1', name: 'Agent One', toolType: 'claude-code' }),
				mockSession({ id: 'a2', name: 'Agent Two', toolType: 'factory-droid' }),
			];
			vi.mocked(readSessions).mockReturnValue(mockSessions);

			listAgents({});

			expect(readSessions).toHaveBeenCalled();
			expect(formatAgents).toHaveBeenCalledWith(
				expect.arrayContaining([
					expect.objectContaining({ id: 'a1', name: 'Agent One' }),
					expect.objectContaining({ id: 'a2', name: 'Agent Two' }),
				]),
				undefined
			);
			expect(consoleSpy).toHaveBeenCalled();
		});

		it('should handle empty agents list', () => {
			vi.mocked(readSessions).mockReturnValue([]);

			listAgents({});

			expect(formatAgents).toHaveBeenCalledWith([], undefined);
			expect(consoleSpy).toHaveBeenCalledWith('No agents found');
		});

		it('should display a single agent', () => {
			const mockSessions: SessionInfo[] = [mockSession({ id: 'solo', name: 'Solo Agent' })];
			vi.mocked(readSessions).mockReturnValue(mockSessions);

			listAgents({});

			expect(formatAgents).toHaveBeenCalledWith(
				[expect.objectContaining({ id: 'solo', name: 'Solo Agent' })],
				undefined
			);
		});

		it('should include all agent properties', () => {
			const mockSessions: SessionInfo[] = [
				mockSession({
					id: 'full',
					name: 'Full Agent',
					toolType: 'terminal',
					cwd: '/home/user/project',
					groupId: 'group-1',
					autoRunFolderPath: '/home/user/playbooks',
				}),
			];
			vi.mocked(readSessions).mockReturnValue(mockSessions);

			listAgents({});

			expect(formatAgents).toHaveBeenCalledWith(
				[
					expect.objectContaining({
						id: 'full',
						name: 'Full Agent',
						toolType: 'terminal',
						cwd: '/home/user/project',
						groupId: 'group-1',
						autoRunFolderPath: '/home/user/playbooks',
					}),
				],
				undefined
			);
		});
	});

	describe('lifted agents (human-readable)', () => {
		it('passes the peer:agentId pointer to the formatter for a lifted agent only', () => {
			vi.mocked(readSessions).mockReturnValue([
				mockSession({
					id: 'lifted',
					liftedTo: { peer: 'build-box', agentId: 'host-1', at: 1 },
				}),
				mockSession({ id: 'local' }),
			]);

			listAgents({});

			const rows = vi.mocked(formatAgents).mock.calls[0][0];
			expect(rows[0].liftedTo).toBe('build-box:host-1');
			expect(rows[1]).not.toHaveProperty('liftedTo');
		});
	});

	describe('JSON output', () => {
		it('should output JSON when json option is true', () => {
			const mockSessions: SessionInfo[] = [
				mockSession({
					id: 'json-agent',
					name: 'JSON Agent',
					toolType: 'claude-code',
					cwd: '/test',
				}),
			];
			vi.mocked(readSessions).mockReturnValue(mockSessions);

			listAgents({ json: true });

			expect(formatAgents).not.toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalledTimes(1);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed).toHaveLength(1);
			expect(parsed[0]).toEqual(
				expect.objectContaining({
					id: 'json-agent',
					name: 'JSON Agent',
					toolType: 'claude-code',
					cwd: '/test',
				})
			);
		});

		it('should expose the worktree directory as worktreeBasePath, null when unset', () => {
			// An agent reads this to put a worktree where the desktop will see it,
			// rather than inventing a path the app never registers.
			vi.mocked(readSessions).mockReturnValue([
				mockSession({
					id: 'with-wt',
					worktreeConfig: { basePath: '/home/user/Project-WorkTrees', watchEnabled: true },
				}),
				mockSession({ id: 'without-wt', worktreeConfig: undefined }),
			]);

			listAgents({ json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed[0].worktreeBasePath).toBe('/home/user/Project-WorkTrees');
			expect(parsed[1].worktreeBasePath).toBeNull();
		});

		it('should expose a lifted agent as liftedTo, null when it was not lifted or malformed', () => {
			// Federation: a lifted agent keeps its local record and points at where it runs now.
			vi.mocked(readSessions).mockReturnValue([
				mockSession({
					id: 'lifted',
					liftedTo: { peer: 'build-box', agentId: 'host-1', at: 1700000000000 },
				}),
				mockSession({ id: 'local' }),
				mockSession({
					id: 'broken',
					liftedTo: { peer: '', agentId: 'host-2', at: 1 } as SessionInfo['liftedTo'],
				}),
			]);

			listAgents({ json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed[0].liftedTo).toEqual({
				peer: 'build-box',
				agentId: 'host-1',
				at: 1700000000000,
			});
			expect(parsed[1].liftedTo).toBeNull();
			expect(parsed[2].liftedTo).toBeNull();
		});

		it('should output empty JSON array for no agents', () => {
			vi.mocked(readSessions).mockReturnValue([]);

			listAgents({ json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed).toEqual([]);
		});

		it('should output multiple agents as JSON array', () => {
			const mockSessions: SessionInfo[] = [
				mockSession({ id: 'a1', name: 'Agent 1' }),
				mockSession({ id: 'a2', name: 'Agent 2' }),
				mockSession({ id: 'a3', name: 'Agent 3' }),
			];
			vi.mocked(readSessions).mockReturnValue(mockSessions);

			listAgents({ json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed).toHaveLength(3);
			expect(parsed[0].id).toBe('a1');
			expect(parsed[1].id).toBe('a2');
			expect(parsed[2].id).toBe('a3');
		});

		it('should include all properties in JSON output', () => {
			const mockSessions: SessionInfo[] = [
				mockSession({
					id: 'complete',
					name: 'Complete Agent',
					toolType: 'gemini-cli',
					cwd: '/project',
					groupId: 'dev-group',
					autoRunFolderPath: '/project/autorun',
				}),
			];
			vi.mocked(readSessions).mockReturnValue(mockSessions);

			listAgents({ json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed[0]).toHaveProperty('id', 'complete');
			expect(parsed[0]).toHaveProperty('name', 'Complete Agent');
			expect(parsed[0]).toHaveProperty('toolType', 'gemini-cli');
			expect(parsed[0]).toHaveProperty('cwd', '/project');
			expect(parsed[0]).toHaveProperty('groupId', 'dev-group');
			expect(parsed[0]).toHaveProperty('autoRunFolderPath', '/project/autorun');
		});
	});

	describe('group filtering', () => {
		it('should filter agents by group', () => {
			const mockGroups: Group[] = [
				{ id: 'group-frontend', name: 'Frontend', emoji: '🎨', collapsed: false },
			];
			const mockGroupSessions: SessionInfo[] = [
				mockSession({ id: 'fe1', name: 'React App', groupId: 'group-frontend' }),
				mockSession({ id: 'fe2', name: 'Vue App', groupId: 'group-frontend' }),
			];

			vi.mocked(resolveGroupId).mockReturnValue('group-frontend');
			vi.mocked(getSessionsByGroup).mockReturnValue(mockGroupSessions);
			vi.mocked(readGroups).mockReturnValue(mockGroups);

			listAgents({ group: 'group-frontend' });

			expect(resolveGroupId).toHaveBeenCalledWith('group-frontend');
			expect(getSessionsByGroup).toHaveBeenCalledWith('group-frontend');
			expect(readGroups).toHaveBeenCalled();
			expect(formatAgents).toHaveBeenCalledWith(
				expect.arrayContaining([
					expect.objectContaining({ id: 'fe1' }),
					expect.objectContaining({ id: 'fe2' }),
				]),
				'Frontend'
			);
		});

		it('should resolve partial group ID', () => {
			vi.mocked(resolveGroupId).mockReturnValue('group-full-id');
			vi.mocked(getSessionsByGroup).mockReturnValue([]);
			vi.mocked(readGroups).mockReturnValue([
				{ id: 'group-full-id', name: 'Full Group', emoji: '📁', collapsed: false },
			]);

			listAgents({ group: 'group' });

			expect(resolveGroupId).toHaveBeenCalledWith('group');
			expect(getSessionsByGroup).toHaveBeenCalledWith('group-full-id');
		});

		it('should handle empty group', () => {
			vi.mocked(resolveGroupId).mockReturnValue('empty-group');
			vi.mocked(getSessionsByGroup).mockReturnValue([]);
			vi.mocked(readGroups).mockReturnValue([
				{ id: 'empty-group', name: 'Empty Group', emoji: '📭', collapsed: false },
			]);

			listAgents({ group: 'empty-group' });

			expect(formatAgents).toHaveBeenCalledWith([], 'Empty Group');
			expect(consoleSpy).toHaveBeenCalledWith('No agents in group "Empty Group"');
		});

		it('should filter by group in JSON mode', () => {
			const mockGroupSessions: SessionInfo[] = [
				mockSession({ id: 'g1', name: 'Group Agent', groupId: 'test-group' }),
			];

			vi.mocked(resolveGroupId).mockReturnValue('test-group');
			vi.mocked(getSessionsByGroup).mockReturnValue(mockGroupSessions);
			vi.mocked(readGroups).mockReturnValue([
				{ id: 'test-group', name: 'Test Group', emoji: '🧪', collapsed: false },
			]);

			listAgents({ group: 'test', json: true });

			expect(getSessionsByGroup).toHaveBeenCalledWith('test-group');
			expect(formatAgents).not.toHaveBeenCalled();

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);
			expect(parsed).toHaveLength(1);
			expect(parsed[0].id).toBe('g1');
		});

		it('should handle group not found', () => {
			vi.mocked(readGroups).mockReturnValue([
				{ id: 'other-group', name: 'Other', emoji: '📁', collapsed: false },
			]);
			vi.mocked(getSessionsByGroup).mockReturnValue([]);
			// Return undefined when group is not found
			vi.mocked(readGroups).mockReturnValue([]);

			listAgents({ group: 'unknown' });

			expect(formatAgents).toHaveBeenCalledWith([], undefined);
		});
	});

	describe('error handling', () => {
		it('should handle storage read errors in human-readable mode', () => {
			const error = new Error('Storage read failed');
			vi.mocked(readSessions).mockImplementation(() => {
				throw error;
			});

			expect(() => listAgents({})).toThrow('process.exit(1)');

			expect(consoleErrorSpy).toHaveBeenCalled();
			expect(formatError).toHaveBeenCalledWith('Failed to list agents: Storage read failed');
		});

		it('should handle storage read errors in JSON mode', () => {
			const error = new Error('JSON storage error');
			vi.mocked(readSessions).mockImplementation(() => {
				throw error;
			});

			expect(() => listAgents({ json: true })).toThrow('process.exit(1)');

			const errorOutput = consoleErrorSpy.mock.calls[0][0];
			const parsed = JSON.parse(errorOutput);
			expect(parsed.error).toBe('JSON storage error');
		});

		it('should handle group resolution errors', () => {
			vi.mocked(resolveGroupId).mockImplementation(() => {
				throw new Error('Ambiguous group ID');
			});

			expect(() => listAgents({ group: 'amb' })).toThrow('process.exit(1)');

			expect(formatError).toHaveBeenCalledWith('Failed to list agents: Ambiguous group ID');
		});

		it('should handle non-Error objects thrown', () => {
			vi.mocked(readSessions).mockImplementation(() => {
				throw 'String error';
			});

			expect(() => listAgents({})).toThrow('process.exit(1)');

			expect(formatError).toHaveBeenCalledWith('Failed to list agents: Unknown error');
		});

		it('should exit with code 1 on error', () => {
			vi.mocked(readSessions).mockImplementation(() => {
				throw new Error('Exit test');
			});

			expect(() => listAgents({})).toThrow('process.exit(1)');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('edge cases', () => {
		it('should handle agents with undefined optional fields', () => {
			const mockSessions: SessionInfo[] = [
				mockSession({
					id: 'minimal',
					name: 'Minimal',
					groupId: undefined,
					autoRunFolderPath: undefined,
				}),
			];
			vi.mocked(readSessions).mockReturnValue(mockSessions);

			listAgents({ json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed[0].groupId).toBeUndefined();
			expect(parsed[0].autoRunFolderPath).toBeUndefined();
		});

		it('should handle special characters in paths', () => {
			const mockSessions: SessionInfo[] = [
				mockSession({
					id: 'special',
					name: 'Special',
					cwd: '/Users/dev/My Projects/Test "App"',
					autoRunFolderPath: "/path with 'quotes'",
				}),
			];
			vi.mocked(readSessions).mockReturnValue(mockSessions);

			listAgents({ json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed[0].cwd).toBe('/Users/dev/My Projects/Test "App"');
			expect(parsed[0].autoRunFolderPath).toBe("/path with 'quotes'");
		});

		it('should handle all tool types', () => {
			const toolTypes = ['claude-code', 'factory-droid', 'terminal', 'gemini-cli', 'qwen3-coder'];
			const mockSessions: SessionInfo[] = toolTypes.map((toolType, i) =>
				mockSession({ id: `agent-${i}`, name: `Agent ${i}`, toolType: toolType as any })
			);
			vi.mocked(readSessions).mockReturnValue(mockSessions);

			listAgents({ json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed).toHaveLength(5);
			toolTypes.forEach((type, i) => {
				expect(parsed[i].toolType).toBe(type);
			});
		});

		it('should preserve agent order from storage', () => {
			const mockSessions: SessionInfo[] = [
				mockSession({ id: 'z-last', name: 'Z Last' }),
				mockSession({ id: 'a-first', name: 'A First' }),
				mockSession({ id: 'm-middle', name: 'M Middle' }),
			];
			vi.mocked(readSessions).mockReturnValue(mockSessions);

			listAgents({ json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed[0].id).toBe('z-last');
			expect(parsed[1].id).toBe('a-first');
			expect(parsed[2].id).toBe('m-middle');
		});
	});

	describe('Federation peers', () => {
		const hostAgent = (id: string, name: string) => ({
			id,
			name,
			toolType: 'codex',
			cwd: `/srv/${id}`,
			worktreeConfig: { basePath: '/srv/wt' },
		});

		/** A connection whose `release()` is observable. */
		const connection = (peer: string) => ({
			peer,
			release: vi.fn(async () => {}),
		});

		it('lists one peer with --peer, tags each JSON row, and releases the connection', async () => {
			const conn = connection('build-box');
			vi.mocked(connectPeer).mockResolvedValue(conn as never);
			vi.mocked(listHostAgents).mockResolvedValue([hostAgent('h1', 'Remote One')] as never);

			await listAgents({ peer: 'build-box', json: true });

			expect(requireEncore).toHaveBeenCalledWith('federation', true);
			expect(connectPeer).toHaveBeenCalledWith('build-box');
			expect(conn.release).toHaveBeenCalledTimes(1);
			expect(readSessions).not.toHaveBeenCalled();
			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed).toEqual([
				{
					id: 'h1',
					name: 'Remote One',
					toolType: 'codex',
					cwd: '/srv/h1',
					worktreeBasePath: '/srv/wt',
					bookmarked: false,
					sessionSshRemoteConfig: null,
					liftedTo: null,
					peer: 'build-box',
				},
			]);
		});

		it('shows the peer name on human-readable rows and in the title', async () => {
			vi.mocked(connectPeer).mockResolvedValue(connection('build-box') as never);
			vi.mocked(listHostAgents).mockResolvedValue([hostAgent('h1', 'Remote One')] as never);

			await listAgents({ peer: 'build-box' });

			expect(formatAgents).toHaveBeenCalledWith(
				[expect.objectContaining({ id: 'h1', peer: 'build-box' })],
				undefined,
				{ peer: 'build-box' }
			);
		});

		it('exits with the resolver exit code and its message when the peer is down', async () => {
			vi.mocked(connectPeer).mockRejectedValue(
				new PeerResolveError(
					'host-down',
					'No Maestro host is running on peer "build-box". Start it with: maestro-cli remote-host start build-box',
					3,
					'build-box'
				)
			);

			await expect(listAgents({ peer: 'build-box', json: true })).rejects.toThrow(
				'process.exit(3)'
			);
			const reported = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
			expect(reported).toEqual({
				error: expect.stringContaining('maestro-cli remote-host start build-box'),
				peer: 'build-box',
				code: 'host-down',
			});
			expect(consoleSpy).not.toHaveBeenCalled();
		});

		it('releases the connection when the host refuses the agent list', async () => {
			const conn = connection('build-box');
			vi.mocked(connectPeer).mockResolvedValue(conn as never);
			vi.mocked(listHostAgents).mockRejectedValue(new Error('socket closed'));

			await expect(listAgents({ peer: 'build-box' })).rejects.toThrow('process.exit(1)');
			expect(conn.release).toHaveBeenCalledTimes(1);
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining('Could not list the agents on peer "build-box": socket closed')
			);
		});

		it('--all-peers lists local agents first, then each peer one after another', async () => {
			vi.mocked(readSessions).mockReturnValue([mockSession({ id: 'local-1', name: 'Local' })]);
			vi.mocked(listFederationPeers).mockReturnValue([
				{ peer: 'alpha', remote: {} },
				{ peer: 'beta', remote: {} },
			] as never);
			let inFlight = 0;
			let maxInFlight = 0;
			vi.mocked(connectPeer).mockImplementation(async (peer: string) => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 5));
				return {
					peer,
					release: vi.fn(async () => {
						inFlight--;
					}),
				} as never;
			});
			vi.mocked(listHostAgents).mockImplementation(async (conn: { peer: string }) => [
				hostAgent(`${conn.peer}-1`, `${conn.peer} agent`) as never,
			]);

			await listAgents({ allPeers: true, json: true });

			expect(maxInFlight).toBe(1);
			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed.map((row: { id: string; peer: string | null }) => [row.id, row.peer])).toEqual([
				['local-1', null],
				['alpha-1', 'alpha'],
				['beta-1', 'beta'],
			]);
		});

		it('--all-peers keeps listing past an unreachable peer, then reports it and exits non-zero', async () => {
			vi.mocked(readSessions).mockReturnValue([]);
			vi.mocked(listFederationPeers).mockReturnValue([
				{ peer: 'down', remote: {} },
				{ peer: 'up', remote: {} },
			] as never);
			vi.mocked(connectPeer).mockImplementation(async (peer: string) => {
				if (peer === 'down') {
					throw new PeerResolveError(
						'host-down',
						'No Maestro host is running on peer "down".',
						3,
						'down'
					);
				}
				return connection(peer) as never;
			});
			vi.mocked(listHostAgents).mockResolvedValue([hostAgent('u1', 'Up agent')] as never);

			await expect(listAgents({ allPeers: true })).rejects.toThrow('process.exit(3)');
			expect(formatAgents).toHaveBeenCalledWith(
				[expect.objectContaining({ id: 'u1', peer: 'up' })],
				undefined,
				{ peer: undefined }
			);
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining('No Maestro host is running on peer "down".')
			);
		});

		it('refuses --peer together with --all-peers, or with --group', async () => {
			await expect(listAgents({ peer: 'a', allPeers: true })).rejects.toThrow('process.exit(2)');
			await expect(listAgents({ peer: 'a', group: 'g1' })).rejects.toThrow('process.exit(2)');
			expect(connectPeer).not.toHaveBeenCalled();
		});

		it('refuses the peer flags while Federation is off', async () => {
			vi.mocked(requireEncore).mockImplementationOnce(() => {
				throw new Error('process.exit(1)');
			});

			await expect(listAgents({ peer: 'build-box' })).rejects.toThrow('process.exit(1)');
			expect(connectPeer).not.toHaveBeenCalled();
		});

		it('leaves a plain listing local: no Encore read and no peer field', () => {
			vi.mocked(readSessions).mockReturnValue([mockSession({ id: 'a1' })]);

			listAgents({ json: true });

			expect(requireEncore).not.toHaveBeenCalled();
			expect(listFederationPeers).not.toHaveBeenCalled();
			expect(JSON.parse(consoleSpy.mock.calls[0][0])[0]).not.toHaveProperty('peer');
		});
	});
});
