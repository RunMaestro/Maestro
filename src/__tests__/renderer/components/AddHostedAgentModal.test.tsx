/**
 * Tests for the Add Hosted Agent modal: it lists only the host agents the Left Bar does not show,
 * filters them, and adds the one picked to the chosen group through `addHostedAgent()`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../renderer/services/hostedAgents', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/services/hostedAgents')>()),
	addHostedAgent: vi.fn(async () => ({
		ok: true,
		added: { id: 'row-9', name: 'Kensho', ref: 'tome:k1' },
	})),
}));

import { AddHostedAgentModal } from '../../../renderer/components/AddHostedAgentModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { addHostedAgent } from '../../../renderer/services/hostedAgents';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import {
	createMirroredPeer,
	replacePeerAgents,
} from '../../../shared/maestro-lib/client/peer-mirror';
import { resetStores } from '../../helpers';
import { mockTheme } from '../../helpers/mockTheme';

function hydrate() {
	const { peer } = replacePeerAgents(
		createMirroredPeer({ peerId: 'tome', remoteId: 'r-tome', name: 'PedTome' }),
		[
			{ id: 'k1', name: 'Kensho', toolType: 'claude-code', cwd: '/srv/kensho', aiTabs: [] },
			{ id: 'm1', name: 'Maestro', toolType: 'codex', aiTabs: [] },
		],
		[],
		1
	);
	usePeerMirrorStore.getState().hydrate([{ ...peer, connection: 'connected' }]);
}

const renderModal = (onClose = vi.fn()) => {
	render(<AddHostedAgentModal theme={mockTheme} onClose={onClose} />, {
		wrapper: LayerStackProvider,
	});
	return onClose;
};

describe('AddHostedAgentModal', () => {
	beforeEach(() => {
		resetStores(usePeerMirrorStore, useSessionStore);
		vi.mocked(addHostedAgent).mockClear();
	});

	it('lists only the host agents the Left Bar does not show yet', () => {
		hydrate();
		useSessionStore.setState({
			sessions: [{ id: 'row-1', liftedTo: { peer: 'tome', agentId: 'm1', at: 1 } }] as never,
		});
		renderModal();
		expect(screen.getByText('PedTome')).toBeInTheDocument();
		expect(screen.getByText('Kensho')).toBeInTheDocument();
		expect(screen.queryByText('Maestro')).not.toBeInTheDocument();
	});

	it('says so when every host agent is in the Left Bar already', () => {
		renderModal();
		expect(screen.getByTestId('add-hosted-empty')).toBeInTheDocument();
	});

	it('filters by name and adds the picked agent, then closes', async () => {
		hydrate();
		const onClose = renderModal();
		fireEvent.change(screen.getByPlaceholderText('Filter by name, host, or folder...'), {
			target: { value: 'kensho' },
		});
		const buttons = screen.getAllByTestId('add-hosted-agent-button');
		expect(buttons).toHaveLength(1);
		fireEvent.click(buttons[0]);
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(addHostedAgent).toHaveBeenCalledWith({ agent: 'tome:k1' });
	});
});
