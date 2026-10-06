/**
 * Adding the agents a bundle import brings to the running app, and the
 * listener that answers main's request to do it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		isRepo: vi.fn(async (cwd: string) => cwd === '/repo'),
		getBranches: vi.fn(async () => ['main']),
		getTags: vi.fn(async () => ['v1']),
	},
}));

import { applyImportedAgents } from '../../../renderer/services/cueBundle';
import { useCueBundleAgentSync } from '../../../renderer/hooks/cue/useCueBundleAgentSync';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Session } from '../../../renderer/types';
import type { SessionInfo } from '../../../shared/types';

const existing = {
	id: 'e1',
	name: 'Old name',
	toolType: 'codex',
	cwd: '/old',
	aiTabs: [{ id: 'tab-1' }],
	state: 'busy',
} as unknown as Session;

beforeEach(() => {
	vi.clearAllMocks();
	useSessionStore.setState({ sessions: [existing] });
});

describe('applyImportedAgents', () => {
	it('adds new agents with their git state and updates only the bundle fields of existing ones', async () => {
		await applyImportedAgents({
			created: [{ id: 'n1', name: 'New', toolType: 'claude-code', cwd: '/repo' } as SessionInfo],
			updated: [
				{
					id: 'e1',
					name: 'Renamed',
					toolType: 'codex',
					cwd: '/new',
					customModel: 'gpt-5',
					aiTabs: [],
					state: 'idle',
				} as unknown as SessionInfo,
			],
		});

		const sessions = useSessionStore.getState().sessions;
		const updated = sessions.find((s) => s.id === 'e1')!;
		expect(updated).toMatchObject({ name: 'Renamed', cwd: '/new', customModel: 'gpt-5' });
		// Not import fields: the running agent keeps its own.
		expect(updated.aiTabs).toEqual([{ id: 'tab-1' }]);
		expect(updated.state).toBe('busy');

		expect(sessions.find((s) => s.id === 'n1')).toMatchObject({
			name: 'New',
			isGitRepo: true,
			gitBranches: ['main'],
			gitTags: ['v1'],
		});
		expect(window.maestro.sessions.setMany).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({ id: 'e1' }),
				expect.objectContaining({ id: 'n1' }),
			]),
			[]
		);
	});

	it("replaces an existing agent's required secret names with the bundle's", async () => {
		useSessionStore.setState({
			sessions: [{ ...existing, requiredSecrets: ['OLD_TOKEN'] } as Session],
		});
		await applyImportedAgents({
			created: [],
			updated: [
				{
					id: 'e1',
					name: 'Old name',
					toolType: 'codex',
					cwd: '/old',
					requiredSecrets: ['API_TOKEN', 'DB_PASSWORD'],
				} as SessionInfo,
			],
		});
		const updated = useSessionStore.getState().sessions.find((s) => s.id === 'e1')!;
		expect(updated.requiredSecrets).toEqual(['API_TOKEN', 'DB_PASSWORD']);
	});

	it("clears an existing agent's required secret names when the bundle declares none", async () => {
		useSessionStore.setState({
			sessions: [{ ...existing, requiredSecrets: ['OLD_TOKEN'] } as Session],
		});
		// The importer always sets the key, undefined when the agent declares no
		// secrets, and IPC's structured clone keeps an undefined-valued key.
		await applyImportedAgents({
			created: [],
			updated: [
				{
					id: 'e1',
					name: 'Old name',
					toolType: 'codex',
					cwd: '/old',
					requiredSecrets: undefined,
				} as SessionInfo,
			],
		});
		const updated = useSessionStore.getState().sessions.find((s) => s.id === 'e1')!;
		expect(updated.requiredSecrets).toBeUndefined();
	});

	it('creates a new agent with its required secret names', async () => {
		await applyImportedAgents({
			created: [
				{
					id: 'n3',
					name: 'Secretive',
					toolType: 'claude-code',
					cwd: '/repo',
					requiredSecrets: ['API_TOKEN'],
				} as SessionInfo,
			],
			updated: [],
		});
		const created = useSessionStore.getState().sessions.find((s) => s.id === 'n3')!;
		expect(created.requiredSecrets).toEqual(['API_TOKEN']);
	});

	it('does not add an agent twice', async () => {
		await applyImportedAgents({
			created: [{ id: 'e1', name: 'Dup', toolType: 'codex', cwd: '/x' } as SessionInfo],
			updated: [],
		});
		expect(useSessionStore.getState().sessions.filter((s) => s.id === 'e1')).toHaveLength(1);
	});
});

describe('useCueBundleAgentSync', () => {
	function subscribe() {
		const onApplyAgents = vi.mocked(window.maestro.cueBundle.onApplyAgents);
		renderHook(() => useCueBundleAgentSync());
		return onApplyAgents.mock.calls[0][0];
	}

	it('applies the change and confirms it', async () => {
		const handler = subscribe();
		await handler(
			{
				created: [{ id: 'n2', name: 'Two', toolType: 'codex', cwd: '/x' } as SessionInfo],
				updated: [],
			},
			'reply-1'
		);
		expect(useSessionStore.getState().sessions.some((s) => s.id === 'n2')).toBe(true);
		expect(window.maestro.cueBundle.sendApplyAgentsResponse).toHaveBeenCalledWith('reply-1', {
			ok: true,
		});
	});

	it('reports a failure so main can roll the files back', async () => {
		vi.mocked(window.maestro.sessions.setMany).mockRejectedValueOnce(new Error('disk full'));
		const handler = subscribe();
		await handler({ created: [], updated: [] }, 'reply-2');
		expect(window.maestro.cueBundle.sendApplyAgentsResponse).toHaveBeenCalledWith('reply-2', {
			ok: false,
			error: 'disk full',
		});
	});
});
