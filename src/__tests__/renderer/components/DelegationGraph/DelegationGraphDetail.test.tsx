/**
 * Tests for DelegationGraphDetail - the selected agent's relationships in words.
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { DelegationGraphDetail } from '../../../../renderer/components/DelegationGraph/DelegationGraphDetail';
import { buildDelegationGraph } from '../../../../shared/delegationGraph';
import type { PeerRosterInput } from '../../../../shared/peerAgents';
import { mockTheme } from '../../../helpers/mockTheme';

const ALL = { kind: 'all' } as const;

/**
 * Lead may consult and delegate to Dev (a named row with a note). Dev may
 * consult Lead back through its group grant. Docs reaches nobody and nobody
 * reaches it.
 */
const FLEET: PeerRosterInput[] = [
	{
		id: 'lead',
		name: 'Lead',
		groupId: 'g-1',
		peerAgents: [{ sessionId: 'dev', read: true, write: true, description: 'Owns the build' }],
	},
	{ id: 'dev', name: 'Dev', groupId: 'g-1', groupPeerAccess: { read: true, write: false } },
	{ id: 'docs', name: 'Docs' },
];

function renderDetail(sessionId: string, handlers = { onOpenPeers: vi.fn(), onClose: vi.fn() }) {
	render(
		<DelegationGraphDetail
			theme={mockTheme}
			model={buildDelegationGraph(ALL, FLEET)}
			sessionId={sessionId}
			onOpenPeers={handlers.onOpenPeers}
			onClose={handlers.onClose}
		/>
	);
	return handlers;
}

describe('DelegationGraphDetail', () => {
	it('names the selected agent', () => {
		renderDetail('lead');
		expect(screen.getByRole('region', { name: 'Selected agent' })).toHaveTextContent('Lead');
	});

	it('lists who the agent can reach, with the access and the note of the row', () => {
		renderDetail('lead');
		const outbound = screen.getByTestId('delegation-graph-detail-outbound');

		expect(outbound).toHaveTextContent('Dev');
		expect(outbound).toHaveTextContent('Owns the build');
		expect(within(outbound).getByTestId('delegation-edge-badge')).toHaveAttribute(
			'data-edge-kind',
			'both'
		);
	});

	// The reverse relationship is a separate edge with its own bits.
	it('lists who can reach the agent, with the access of THAT edge', () => {
		renderDetail('lead');
		const inbound = screen.getByTestId('delegation-graph-detail-inbound');

		expect(inbound).toHaveTextContent('Dev');
		expect(within(inbound).getByTestId('delegation-edge-badge')).toHaveAttribute(
			'data-edge-kind',
			'consult'
		);
	});

	it('names the grant behind a derived edge, and nothing for an explicit one', () => {
		renderDetail('dev');

		expect(screen.getByTestId('delegation-graph-detail-outbound')).toHaveTextContent(
			'Peers in my group'
		);
		expect(screen.getByTestId('delegation-graph-detail-inbound')).not.toHaveTextContent(
			'Peers in my group'
		);
	});

	it('says so when the agent reaches nobody and nobody reaches it', () => {
		renderDetail('docs');

		expect(screen.getByTestId('delegation-graph-detail-outbound')).toHaveTextContent('Nobody.');
		expect(screen.getByTestId('delegation-graph-detail-inbound')).toHaveTextContent('Nobody.');
	});

	it('still names an agent that left the graph a render ago', () => {
		renderDetail('deleted-agent-id');
		expect(screen.getByRole('region', { name: 'Selected agent' })).toHaveTextContent(
			'Removed agent deleted-'
		);
	});

	it('hands the agent to the Peers tab link', () => {
		const { onOpenPeers } = renderDetail('lead');

		fireEvent.click(screen.getByTestId('delegation-graph-detail-open-peers'));

		expect(onOpenPeers).toHaveBeenCalledWith('lead');
	});

	it('clears the selection from its close button', () => {
		const { onClose } = renderDetail('lead');

		fireEvent.click(screen.getByRole('button', { name: 'Clear the selection' }));

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	// A click-driven surface is `select-none`; this panel is the text a user copies.
	it('keeps its text selectable', () => {
		renderDetail('lead');
		expect(screen.getByTestId('delegation-graph-detail')).toHaveClass('select-text');
	});
});
