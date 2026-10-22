/**
 * @fileoverview Tests for PeersTab: the peers tabpanel, its intro line, and the
 * Peer Agents section it hands every other prop to.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
	PeersTab,
	type PeersTabProps,
} from '../../../../renderer/components/AgentSettings/PeersTab';
import { createMockTheme } from '../../../helpers/mockTheme';

const FLEET = [
	{ id: 'self', name: 'Me', groupId: 'g-backend' },
	{ id: 'peer-1', name: 'Docs', groupId: 'g-backend' },
	{ id: 'peer-2', name: 'Infra' },
];

function renderTab(overrides: Partial<PeersTabProps> = {}) {
	const props: PeersTabProps = {
		theme: createMockTheme(),
		idPrefix: 'edit-agent',
		peers: [],
		onChange: vi.fn(),
		onGroupAccessChange: vi.fn(),
		onWorktreeAccessChange: vi.fn(),
		availableAgents: FLEET,
		selfSessionId: 'self',
		groupId: 'g-backend',
		groupName: 'Backend',
		...overrides,
	};
	render(<PeersTab {...props} />);
	return props;
}

describe('PeersTab', () => {
	it('is the peers tabpanel', () => {
		renderTab();
		expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'edit-agent-tabpanel-peers');
	});

	it('says what the agent does with its roster', () => {
		renderTab();
		const intro = screen.getByText(/reads its peer roster/);
		expect(intro).toHaveTextContent('the same way it reads its working directories');
		expect(intro).toHaveTextContent('decides on its own when to consult a peer or delegate to one');
	});

	it('draws the Peer Agents section from its own props', () => {
		renderTab({
			peers: [{ sessionId: 'peer-2', read: true, write: false, description: 'Owns the infra' }],
			groupAccess: { read: true, write: false },
		});

		// The group count comes from the fleet, the group and the self id.
		expect(screen.getByText('1 other agent in Backend')).toBeInTheDocument();
		expect(screen.getByRole('switch', { name: 'Consult peers in my group' })).toHaveAttribute(
			'aria-checked',
			'true'
		);
		expect(screen.getByDisplayValue('Owns the infra')).toBeInTheDocument();
	});

	it('raises the section callbacks unchanged', () => {
		const props = renderTab({
			peers: [{ sessionId: 'peer-2', read: true, write: false }],
		});

		fireEvent.click(screen.getByRole('switch', { name: 'Delegate to this peer' }));
		expect(props.onChange).toHaveBeenCalledWith([{ sessionId: 'peer-2', read: true, write: true }]);

		fireEvent.click(screen.getByRole('switch', { name: 'Consult the worktree family' }));
		expect(props.onWorktreeAccessChange).toHaveBeenCalledWith({ read: true, write: false });

		fireEvent.click(screen.getByRole('button', { name: 'Remove peer' }));
		expect(props.onChange).toHaveBeenLastCalledWith([]);
	});
});
