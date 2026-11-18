/**
 * @fileoverview Tests for HostAgentPicker, the list New Agent shows when "Runs
 * on" is a Federation host with agents the Left Bar does not show yet.
 */

import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
	HostAgentPicker,
	hostAgentDetail,
} from '../../../../renderer/components/NewInstanceModal/HostAgentPicker';
import type { HostedAgentListing } from '../../../../shared/federationCommands';
import { createMockTheme } from '../../../helpers/mockTheme';

const listing = (agentId: string, name: string, extra: Partial<HostedAgentListing> = {}) =>
	({
		peerId: 'tome',
		peerName: 'PedTome',
		remoteId: 'remote-tome',
		agentId,
		ref: `tome:${agentId}`,
		name,
		toolType: 'claude-code',
		...extra,
	}) satisfies HostedAgentListing;

const listings = [
	listing('k1', 'Kensho', { hostGroupName: 'Research', cwd: '/srv/kensho' }),
	listing('d1', 'Docs', { toolType: 'codex', cwd: '/srv/docs' }),
];

function Harness({ onAdd = vi.fn() }: { onAdd?: (ref: string) => void }) {
	const [selected, setSelected] = useState<string | null>(null);
	return (
		<>
			<HostAgentPicker
				theme={createMockTheme()}
				listings={listings}
				hostName="PedTome"
				selectedRef={selected}
				onSelectedRefChange={setSelected}
				onAdd={onAdd}
			/>
			<output data-testid="selected">{selected ?? ''}</output>
		</>
	);
}

describe('HostAgentPicker', () => {
	it('lists each agent with its provider, host group, and folder', () => {
		render(<Harness />);
		const rows = screen.getAllByTestId('host-agent-row');
		expect(rows).toHaveLength(2);
		expect(rows[0]).toHaveTextContent('Kensho');
		expect(rows[0]).toHaveTextContent('Claude Code · Research · /srv/kensho');
		expect(hostAgentDetail(listings[1])).toBe('Codex · /srv/docs');
	});

	it('selects the first agent, and follows a click', () => {
		render(<Harness />);
		expect(screen.getByTestId('selected')).toHaveTextContent('tome:k1');
		fireEvent.click(screen.getAllByTestId('host-agent-row')[1]);
		expect(screen.getByTestId('selected')).toHaveTextContent('tome:d1');
	});

	it('narrows by the filter and keeps a visible selection', () => {
		render(<Harness />);
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'docs' } });
		expect(screen.getAllByTestId('host-agent-row')).toHaveLength(1);
		expect(screen.getByTestId('selected')).toHaveTextContent('tome:d1');
	});

	it('adds on Enter in the filter and on a double-click', () => {
		const onAdd = vi.fn();
		render(<Harness onAdd={onAdd} />);
		fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowDown' });
		fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
		expect(onAdd).toHaveBeenLastCalledWith('tome:d1');
		fireEvent.doubleClick(screen.getAllByTestId('host-agent-row')[0]);
		expect(onAdd).toHaveBeenLastCalledWith('tome:k1');
	});
});
