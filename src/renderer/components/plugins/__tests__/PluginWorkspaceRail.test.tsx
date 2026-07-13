import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PluginWorkspaceRail } from '../PluginWorkspaceRail';
import type {
	PluginWorkspaceProjection,
	PluginWorkspaceProjectionSource,
} from '../pluginWorkspaceProjection';
import { THEMES } from '../../../constants/themes';

const snapshot: PluginWorkspaceProjection = {
	connection: 'ready',
	workspaces: [
		{
			ownerPluginId: 'com.example.agent',
			workspaceLocalId: 'workspace',
			panelLocalId: 'main-panel',
			generation: '1',
			projectionRevision: 1,
			status: { state: 'ready', label: 'Ready' },
			badge: null,
			sessions: [
				{
					externalSessionId: 'external-1',
					title: 'Review queue ordering',
					status: 'waiting_for_approval',
					unread: 3,
					pendingApproval: true,
					snapshotToken: 'opaque-workspace-capability-token',
					updatedAt: 1,
				},
			],
		},
	],
	selection: null,
};

function source(value: PluginWorkspaceProjection): PluginWorkspaceProjectionSource {
	return {
		getSnapshot: vi.fn(async () => value),
		subscribe: vi.fn(() => vi.fn()),
		reveal: vi.fn(async () => {}),
	};
}

describe('PluginWorkspaceRail', () => {
	it('projects host-provided status, unread count, approval attention, and keyboard selection', async () => {
		const projectionSource = source(snapshot);
		render(
			<PluginWorkspaceRail
				theme={THEMES.dracula}
				source={projectionSource}
				ownerPluginId="com.example.agent"
				workspaceLocalId="workspace"
			/>
		);

		const session = await screen.findByRole('button', { name: /Review queue ordering/ });
		expect(session).toHaveTextContent('3');
		expect(session).toHaveAccessibleDescription('Approval required');
		fireEvent.keyDown(session, { key: 'Enter' });
		expect(projectionSource.reveal).toHaveBeenCalledWith({
			snapshotToken: 'opaque-workspace-capability-token',
		});
	});

	it('announces exact connecting, degraded, offline, and error registry status labels', async () => {
		const connecting = source({
			...snapshot,
			workspaces: [
				{ ...snapshot.workspaces[0], status: { state: 'connecting', label: 'Connecting OMP' } },
			],
		});
		const { rerender } = render(
			<PluginWorkspaceRail
				theme={THEMES.dracula}
				source={connecting}
				ownerPluginId="com.example.agent"
				workspaceLocalId="workspace"
			/>
		);
		const connectingStatus = (await screen.findByText('Connecting OMP')).closest('[role="status"]');
		expect(connectingStatus).toHaveAttribute('aria-live', 'polite');

		rerender(
			<PluginWorkspaceRail
				theme={THEMES.dracula}
				source={source({
					...snapshot,
					workspaces: [
						{ ...snapshot.workspaces[0], status: { state: 'degraded', label: 'OMP degraded' } },
					],
				})}
				ownerPluginId="com.example.agent"
				workspaceLocalId="workspace"
			/>
		);
		expect(await screen.findByText('OMP degraded')).toBeInTheDocument();

		rerender(
			<PluginWorkspaceRail
				theme={THEMES.dracula}
				source={source({
					...snapshot,
					workspaces: [
						{ ...snapshot.workspaces[0], status: { state: 'offline', label: 'OMP offline' } },
					],
				})}
				ownerPluginId="com.example.agent"
				workspaceLocalId="workspace"
			/>
		);
		expect(await screen.findByText('OMP offline')).toBeInTheDocument();

		rerender(
			<PluginWorkspaceRail
				theme={THEMES.dracula}
				source={source({
					...snapshot,
					workspaces: [
						{ ...snapshot.workspaces[0], status: { state: 'error', label: 'OMP failed' } },
					],
				})}
				ownerPluginId="com.example.agent"
				workspaceLocalId="workspace"
			/>
		);
		const errorStatus = (await screen.findByText('OMP failed')).closest('[role="alert"]');
		expect(errorStatus).toHaveAttribute('aria-live', 'assertive');
	});
});
