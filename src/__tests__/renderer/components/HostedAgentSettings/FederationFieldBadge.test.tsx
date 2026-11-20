/**
 * Tests for FederationFieldBadge: on a hosted agent's settings, each field says where its value
 * lives (from the Federation tables), and a shared field adds Pending or Conflict. Without the
 * editor's context (an ordinary local agent) nothing renders.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	FederatedSetting,
	FederationFieldBadge,
	FederationFieldsProvider,
	federationTargetOfSession,
	unhonoredPeerRowNotice,
	type FederationFieldsValue,
} from '../../../../renderer/components/HostedAgentSettings/FederationFieldBadge';
import { useHostedAgentSettingsStore } from '../../../../renderer/stores/hostedAgentSettingsStore';
import {
	buildLiftPeerIdMap,
	HOSTED_SETTINGS_NOT_YET_SYNCED,
} from '../../../../shared/maestro-lib/agents/lift-settings-sync';
import { mockTheme } from '../../../helpers/mockTheme';

function value(state: Partial<FederationFieldsValue['state']> = {}): FederationFieldsValue {
	return {
		peerId: 'box',
		agentId: 'host-1',
		mode: 'pointer',
		theme: mockTheme,
		hostName: 'Build Box',
		state: { pendingIds: [], conflictIds: [], ...state },
		peerIds: buildLiftPeerIdMap(
			[{ id: 'local-2', liftedTo: { peer: 'box', agentId: 'host-2', at: 1 } }],
			'box',
			['host-1', 'host-2', 'host-only']
		),
		hostAgents: [],
		hostGroups: [],
	};
}

function renderBadge(field: Parameters<typeof FederationFieldBadge>[0]['field'], ctx = value()) {
	return render(
		<FederationFieldsProvider value={ctx}>
			<FederationFieldBadge field={field} />
		</FederationFieldsProvider>
	);
}

describe('FederationFieldBadge', () => {
	beforeEach(() => {
		useHostedAgentSettingsStore.setState({ conflictsOpen: false });
	});

	it('renders nothing for an ordinary local agent', () => {
		const { container } = render(<FederationFieldBadge field="model" />);
		expect(container).toBeEmptyDOMElement();
		const wrapped = render(
			<FederatedSetting field="model">
				<span>field</span>
			</FederatedSetting>
		);
		expect(wrapped.container.innerHTML).toBe('<span>field</span>');
	});

	it('names each scope the way the tables decide it', () => {
		renderBadge('model');
		expect(screen.getByTestId('federation-scope-model')).toHaveTextContent('From host');
		renderBadge('ssh');
		expect(screen.getByTestId('federation-scope-ssh')).toHaveTextContent('This machine');
		renderBadge('additionalDirectories');
		const notSynced = screen.getByTestId('federation-scope-additionalDirectories');
		expect(notSynced).toHaveTextContent('Not synced yet');
		expect(notSynced).toHaveAttribute(
			'title',
			HOSTED_SETTINGS_NOT_YET_SYNCED.additionalDirectories
		);
	});

	it('adds Pending with the host name for an edit the host has not taken', () => {
		renderBadge('model', value({ pendingIds: ['customModel'] }));
		expect(screen.getByTestId('federation-pending-model')).toHaveTextContent(
			'Pending on Build Box'
		);
	});

	it('adds Conflict, and a click opens the Federation Settings Conflicts modal', () => {
		renderBadge('nudgeMessage', value({ conflictIds: ['nudgeMessage'] }));
		fireEvent.click(screen.getByTestId('federation-conflict-nudgeMessage'));
		expect(useHostedAgentSettingsStore.getState().conflictsOpen).toBe(true);
	});

	it('reads one control that writes several fields as one badge', () => {
		renderBadge(['enableMaestroP', 'maestroPMode'], value({ pendingIds: ['maestroPMode'] }));
		expect(screen.getByTestId('federation-scope-enableMaestroP')).toHaveTextContent('From host');
		expect(screen.getByTestId('federation-pending-enableMaestroP')).toBeInTheDocument();
	});
});

describe('federationTargetOfSession', () => {
	it('finds the host agent of a lifted pointer, and nothing for a local agent', () => {
		expect(
			federationTargetOfSession({ liftedTo: { peer: 'box', agentId: 'host-1', at: 1 } })
		).toEqual({ peerId: 'box', agentId: 'host-1', mode: 'pointer' });
		expect(federationTargetOfSession({})).toBeNull();
	});
});

describe('unhonoredPeerRowNotice', () => {
	it('names a row for an agent the host does not hold', () => {
		expect(unhonoredPeerRowNotice(value(), 'local-2')).toBeUndefined();
		expect(unhonoredPeerRowNotice(value(), 'host-only')).toBeUndefined();
		expect(unhonoredPeerRowNotice(value(), 'laptop-only')).toContain('Not honored by Build Box');
		expect(unhonoredPeerRowNotice(null, 'laptop-only')).toBeUndefined();
	});
});
