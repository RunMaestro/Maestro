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
		select: vi.fn(async () => {}),
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
			ownerPluginId: 'com.example.agent',
			workspaceLocalId: 'workspace',
			snapshotToken: 'opaque-workspace-capability-token',
		});
	});

	it('renders genuine offline and error states supplied by the projection source', async () => {
		const offlineSource = source({ ...snapshot, connection: 'offline' });
		const { rerender } = render(
			<PluginWorkspaceRail
				theme={THEMES.dracula}
				source={offlineSource}
				ownerPluginId="com.example.agent"
				workspaceLocalId="workspace"
			/>
		);
		expect(await screen.findByRole('status')).toHaveTextContent('Offline');

		rerender(
			<PluginWorkspaceRail
				theme={THEMES.dracula}
				source={source({ ...snapshot, connection: 'error', error: 'Transport stopped' })}
				ownerPluginId="com.example.agent"
				workspaceLocalId="workspace"
			/>
		);
		expect(await screen.findByRole('alert')).toHaveTextContent('Transport stopped');
	});
});
