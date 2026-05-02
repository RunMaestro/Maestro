import { act, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RolesPanel } from '../../../../renderer/components/RightPanel/RolesPanel/RolesPanel';
import { useDispatchClaimsStore } from '../../../../renderer/stores/dispatchClaimsStore';
import { mockTheme } from '../../../helpers/mockTheme';
import { createMockSession } from '../../../helpers/mockSession';

const projectA = '/projects/a';
const projectB = '/projects/b';

const sessions = [
	createMockSession({
		id: 'agent-a',
		name: 'Agent A',
		projectRoot: projectA,
		cwd: projectA,
		fullPath: projectA,
	}),
	createMockSession({
		id: 'agent-b',
		name: 'Agent B',
		projectRoot: projectB,
		cwd: projectB,
		fullPath: projectB,
	}),
];

function installMaestroMocks() {
	const maestro = window.maestro as unknown as Record<string, unknown>;
	maestro.projectRoles = {
		get: vi.fn(async (projectPath: string) => ({
			success: true,
			data: {
				runner: {
					agentId: projectPath === projectA ? 'agent-a' : 'agent-b',
					enabled: true,
				},
			},
		})),
		set: vi.fn(async () => ({ success: true })),
	};
	maestro.pmResolveGithubProject = {
		resolve: vi.fn(async (input: { projectPath: string }) => ({
			success: true,
			data: {
				owner: 'HumpfTech',
				repo: input.projectPath === projectA ? 'ProjectA' : 'ProjectB',
				projectNumber: input.projectPath === projectA ? 1 : 2,
				projectId: input.projectPath === projectA ? 'PVT_A' : 'PVT_B',
				projectTitle: input.projectPath === projectA ? 'Project A' : 'Project B',
				discoveredAt: '2026-05-02T00:00:00.000Z',
			},
			fromCache: true,
		})),
	};
	maestro.agentDispatch = {
		getBoard: vi.fn(async () => ({ success: true, data: { items: [], total: 0 } })),
		onClaimStarted: vi.fn(() => () => {}),
		onClaimEnded: vi.fn(() => () => {}),
	};
	maestro.shell = {
		...((maestro.shell as Record<string, unknown> | undefined) ?? {}),
		openExternal: vi.fn(),
	};
}

describe('RolesPanel claim scoping', () => {
	beforeEach(() => {
		useDispatchClaimsStore.getState().resetForTests();
		installMaestroMocks();
	});

	it('shows a project A claim only in the project A panel', async () => {
		render(
			<div>
				<section aria-label="Project A panel">
					<RolesPanel
						theme={mockTheme}
						projectPath={projectA}
						sessions={sessions}
						activeRemoteId={null}
					/>
				</section>
				<section aria-label="Project B panel">
					<RolesPanel
						theme={mockTheme}
						projectPath={projectB}
						sessions={sessions}
						activeRemoteId={null}
					/>
				</section>
			</div>
		);

		await waitFor(() => {
			expect(screen.getByLabelText('Project A panel')).toHaveTextContent('Agent A');
			expect(screen.getByLabelText('Project B panel')).toHaveTextContent('Agent B');
		});

		act(() => {
			useDispatchClaimsStore.getState().claimStarted({
				projectPath: projectA,
				role: 'runner',
				agentId: 'agent-a',
				sessionId: 'agent-a',
				issueNumber: 254,
				issueTitle: 'Scoped claim',
				claimedAt: '2026-05-02T00:00:00.000Z',
			});
		});

		const panelA = screen.getByLabelText('Project A panel');
		const panelB = screen.getByLabelText('Project B panel');

		expect(within(panelA).getByText('#254')).toBeInTheDocument();
		expect(within(panelA).getByText(/On \(Busy:/)).toBeInTheDocument();
		expect(within(panelB).queryByText('#254')).not.toBeInTheDocument();
		expect(within(panelB).getByText('On (Available)')).toBeInTheDocument();
	});
});
