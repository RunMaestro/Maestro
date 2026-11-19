/**
 * PlaybookConfigureModal: opens from the modal store, lists the agent's
 * playbooks when none is named, and shows the chosen one's ParameterSheet.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybookConfigureModal } from '../../../../renderer/components/PlaybookLaunch/PlaybookConfigureModal';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import {
	closePlaybookConfigure,
	openPlaybookConfigure,
} from '../../../../renderer/services/playbookConfigure';
import { useModalStore } from '../../../../renderer/stores/modalStore';
import type { Playbook } from '../../../../shared/types';
import { mockTheme } from '../../../helpers/mockTheme';

function makePlaybook(id: string, name: string, prompt: string): Playbook {
	return {
		id,
		name,
		createdAt: 0,
		updatedAt: 0,
		documents: [{ filename: 'doc', resetOnCompletion: false }],
		loopEnabled: false,
		prompt,
	};
}

const WITH_PARAMS = makePlaybook(
	'pb-params',
	'Triage Issues',
	'<!-- CONFIGURE: How many -->\n**MAX_ITEMS:** `25`'
);
const WITHOUT_PARAMS = makePlaybook('pb-plain', 'Plain Run', 'Just do it.');

const list = () => window.maestro.playbooks.list as ReturnType<typeof vi.fn>;

function renderModal() {
	return render(
		<LayerStackProvider>
			<PlaybookConfigureModal theme={mockTheme} />
		</LayerStackProvider>
	);
}

function isOpen(): boolean {
	return useModalStore.getState().modals.get('playbookConfigure')?.open ?? false;
}

describe('PlaybookConfigureModal', () => {
	beforeEach(() => {
		act(() => closePlaybookConfigure());
		list().mockReset();
		list().mockResolvedValue({ success: true, playbooks: [WITH_PARAMS, WITHOUT_PARAMS] });
	});

	it('renders nothing while closed', () => {
		renderModal();
		expect(screen.queryByTestId('playbook-configure-modal')).toBeNull();
	});

	it("lists the agent's playbooks with their parameter counts, then opens the chosen one", async () => {
		renderModal();
		act(() => openPlaybookConfigure({ sessionId: 'agent-1' }));

		await waitFor(() => expect(screen.getByTestId('playbook-configure-picker')).toBeTruthy());
		expect(list()).toHaveBeenCalledWith('agent-1');
		expect(screen.getByTestId('playbook-configure-pick-pb-params')).toHaveTextContent(
			'1 parameter'
		);
		expect(screen.getByTestId('playbook-configure-pick-pb-plain')).toHaveTextContent(
			'No parameters'
		);

		fireEvent.click(screen.getByTestId('playbook-configure-pick-pb-params'));
		expect(screen.getByTestId('parameter-row-MAX_ITEMS')).toBeInTheDocument();

		// Back returns to the picker, because that is where the user came from.
		fireEvent.click(screen.getByTestId('playbook-configure-back'));
		expect(screen.getByTestId('playbook-configure-picker')).toBeInTheDocument();
	});

	it('opens straight on a named playbook, with no Back, and Done closes it', async () => {
		renderModal();
		act(() => openPlaybookConfigure({ sessionId: 'agent-1', playbookId: 'pb-params' }));

		await waitFor(() => expect(screen.getByTestId('parameter-sheet')).toBeTruthy());
		expect(screen.queryByTestId('playbook-configure-back')).toBeNull();
		fireEvent.click(screen.getByTestId('parameter-sheet-run'));
		await waitFor(() => expect(isOpen()).toBe(false));
	});

	it('says so when the named playbook no longer exists', async () => {
		renderModal();
		act(() => openPlaybookConfigure({ sessionId: 'agent-1', playbookId: 'gone' }));
		await waitFor(() =>
			expect(screen.getByText('This playbook no longer exists.')).toBeInTheDocument()
		);
	});

	it('shows the error when the playbooks cannot be read', async () => {
		list().mockResolvedValue({ success: false, playbooks: [], error: 'Disk unreadable' });
		renderModal();
		act(() => openPlaybookConfigure({ sessionId: 'agent-1' }));
		await waitFor(() => expect(screen.getByText('Disk unreadable')).toBeInTheDocument());
	});

	it('asks for an agent when none is active', () => {
		renderModal();
		act(() => useModalStore.getState().openModal('playbookConfigure', {}));
		expect(
			screen.getByText('Select an agent first: playbooks belong to an agent.')
		).toBeInTheDocument();
	});
});
