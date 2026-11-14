/**
 * Tests for the Peer Agents section on the wizard's directory step.
 *
 * The screen mounts `PeerAgentsSection` under Additional Directories and binds
 * it to wizard state. The section's own behavior is tested in
 * `PeerAgentsSection.test.tsx`; these cases cover what only the screen decides:
 * where the section sits, what it is fed, and that its picker does not share
 * Enter and Escape with the screen.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { DirectorySelectionScreen } from '../../../../../../renderer/components/Wizard/screens/DirectorySelectionScreen';
import {
	WizardProvider,
	useWizard,
} from '../../../../../../renderer/components/Wizard/WizardContext';
import { LayerStackProvider } from '../../../../../../renderer/contexts/LayerStackContext';
import { useSessionStore } from '../../../../../../renderer/stores/sessionStore';
import { createMockSession } from '../../../../../helpers/mockSession';
import { mockTheme } from '../../../../../helpers/mockTheme';

/** The screen on the directory step, with the wizard state it writes shown beside it. */
function ScreenWithState({ directoryPath = '' }: { directoryPath?: string }) {
	const { goToStep, setSelectedAgent, setDirectoryPath, state } = useWizard();

	React.useEffect(() => {
		setSelectedAgent('claude-code');
		if (directoryPath) setDirectoryPath(directoryPath);
		goToStep('directory-selection');
	}, [goToStep, setSelectedAgent, setDirectoryPath, directoryPath]);

	return (
		<>
			<div data-testid="current-step">{state.currentStep}</div>
			<div data-testid="peer-state">
				{JSON.stringify({
					peerAgents: state.peerAgents,
					groupPeerAccess: state.groupPeerAccess ?? null,
					worktreePeerAccess: state.worktreePeerAccess ?? null,
				})}
			</div>
			<DirectorySelectionScreen theme={mockTheme} />
		</>
	);
}

async function renderScreen(props: { directoryPath?: string } = {}) {
	render(
		<LayerStackProvider>
			<WizardProvider>
				<ScreenWithState {...props} />
			</WizardProvider>
		</LayerStackProvider>
	);
	await waitFor(() => {
		expect(screen.queryByText('Detecting project location...')).not.toBeInTheDocument();
	});
}

function peerState() {
	return JSON.parse(screen.getByTestId('peer-state').textContent ?? '{}');
}

describe('DirectorySelectionScreen - Peer Agents', () => {
	beforeEach(() => {
		useSessionStore.setState({
			sessions: [
				createMockSession({ id: 'agent-a', name: 'Alpha' }),
				createMockSession({ id: 'agent-b', name: 'Beta' }),
			],
			groups: [],
		});
	});

	it('draws the section directly under Additional Directories', async () => {
		await renderScreen();

		const directories = screen.getByText('Additional Directories');
		const peers = screen.getByText('Peer Agents');
		expect(
			directories.compareDocumentPosition(peers) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
	});

	it('draws the group grant disabled, because the wizard creates an agent in no group', async () => {
		await renderScreen();

		expect(screen.getByRole('checkbox', { name: /Peers in my group/ })).toBeDisabled();
		expect(screen.getByRole('checkbox', { name: /Worktree family/ })).toBeEnabled();
	});

	it('offers the whole fleet in the picker and stores the chosen row in wizard state', async () => {
		await renderScreen();

		fireEvent.click(screen.getByRole('button', { name: 'Add Peer' }));
		fireEvent.click(screen.getByRole('button', { name: 'Peer agent' }));
		// No agent is left out: the new agent has no id yet, so none of these is it.
		expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
			'Select an agent...',
			'Alpha',
			'Beta',
		]);

		fireEvent.click(screen.getByRole('option', { name: 'Beta' }));
		fireEvent.click(screen.getByRole('switch', { name: 'Delegate to this peer' }));

		expect(peerState().peerAgents).toEqual([
			{ sessionId: 'agent-b', read: true, write: true, description: '' },
		]);
	});

	it('stores a grant when it is checked and removes it when it is unchecked', async () => {
		await renderScreen();
		const worktree = screen.getByRole('checkbox', { name: /Worktree family/ });

		fireEvent.click(worktree);
		expect(peerState().worktreePeerAccess).toEqual({ read: true, write: false });

		fireEvent.click(worktree);
		// Absent, not a pair of false bits.
		expect(peerState().worktreePeerAccess).toBeNull();
		expect(peerState().groupPeerAccess).toBeNull();
	});

	it('keeps Enter and Escape inside the open picker', async () => {
		// A valid directory, so a stray Enter WOULD continue the wizard.
		await renderScreen({ directoryPath: '/valid/path' });

		fireEvent.click(screen.getByRole('button', { name: 'Add Peer' }));
		fireEvent.click(screen.getByRole('button', { name: 'Peer agent' }));
		const filter = screen.getByLabelText('Filter agents...');

		// Escape closes the menu. It does not step the wizard back.
		fireEvent.keyDown(filter, { key: 'Escape' });
		expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
		expect(screen.getByTestId('current-step')).toHaveTextContent('directory-selection');

		// Enter chooses the highlighted option. It does not continue the wizard.
		fireEvent.click(screen.getByRole('button', { name: 'Peer agent' }));
		fireEvent.change(screen.getByLabelText('Filter agents...'), { target: { value: 'Alp' } });
		fireEvent.keyDown(screen.getByLabelText('Filter agents...'), { key: 'Enter' });

		expect(peerState().peerAgents).toEqual([
			{ sessionId: 'agent-a', read: true, write: false, description: '' },
		]);
		expect(screen.getByTestId('current-step')).toHaveTextContent('directory-selection');
	});
});
