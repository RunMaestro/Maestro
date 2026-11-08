/**
 * The Left Bar's mark on an agent that moved to a Federation host (FED-SSH-06): hidden while
 * Federation is off or for an agent that never moved, and a click opens the mirrored agent without
 * selecting the row.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../../../renderer/services/agentLift', () => ({
	openLiftedAgent: vi.fn(),
}));

import { LiftedPointerChip } from '../../../../renderer/components/SessionList/LiftedPointerChip';
import { openLiftedAgent } from '../../../../renderer/services/agentLift';
import { usePeerMirrorStore } from '../../../../renderer/stores/peerMirrorStore';
import {
	createMirroredPeer,
	replacePeerAgents,
} from '../../../../shared/maestro-lib/client/peer-mirror';
import { resetStores } from '../../../helpers';
import { mockTheme } from '../../../helpers/mockTheme';

const pointer = { peer: 'box', agentId: 'h1', at: 1 };

function mirror(agentIds: string[]) {
	const { peer } = replacePeerAgents(
		createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'box' }),
		agentIds.map((id) => ({ id, name: id, toolType: 'claude-code', aiTabs: [] })),
		[],
		1
	);
	usePeerMirrorStore.getState().hydrate([peer]);
}

beforeEach(() => {
	resetStores(usePeerMirrorStore);
	vi.mocked(openLiftedAgent).mockClear();
});

describe('LiftedPointerChip', () => {
	it('renders nothing while Federation is off', () => {
		const { container } = render(<LiftedPointerChip theme={mockTheme} liftedTo={pointer} />);
		expect(container).toBeEmptyDOMElement();
	});

	it('renders nothing for an agent that never moved', () => {
		mirror(['h1']);
		const { container } = render(<LiftedPointerChip theme={mockTheme} liftedTo={undefined} />);
		expect(container).toBeEmptyDOMElement();
	});

	it('names the peer, and a click opens the mirrored agent without reaching the row', () => {
		mirror(['h1']);
		const onRowClick = vi.fn();
		render(
			<div onClick={onRowClick}>
				<LiftedPointerChip theme={mockTheme} liftedTo={pointer} />
			</div>
		);
		const chip = screen.getByTestId('lifted-pointer-chip');
		expect(chip).toHaveTextContent('on box');
		expect(chip.getAttribute('title')).toContain('Click to open it on the host');
		fireEvent.click(chip);
		expect(openLiftedAgent).toHaveBeenCalledWith({ liftedTo: pointer });
		expect(onRowClick).not.toHaveBeenCalled();
	});

	it('says so when the peer does not show the agent', () => {
		mirror([]);
		render(<LiftedPointerChip theme={mockTheme} liftedTo={pointer} />);
		expect(screen.getByTestId('lifted-pointer-chip').getAttribute('title')).toContain(
			'does not show it right now'
		);
	});
});
