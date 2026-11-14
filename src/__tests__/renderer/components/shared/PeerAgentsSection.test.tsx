/**
 * @fileoverview Tests for PeerAgentsSection - the editor for an agent's peer
 * grants, shared by the create-agent, edit-agent, and Wizard surfaces.
 *
 * The section holds no state and reads no store, so every case renders it with
 * fixed props and reads what it raises. Three rules get the most cases, because
 * the data model depends on them and the UI is the only place they are made:
 * a grant that is off is ABSENT, never a pair of false bits; an explicit row
 * with neither square lit is an exclusion and is never dropped; the agent being
 * edited is never offered as its own peer.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import {
	PeerAgentsSection,
	type PeerAgentOption,
	type PeerAgentsSectionProps,
} from '../../../../renderer/components/shared/PeerAgentsSection';
import { mockTheme } from '../../../helpers/mockTheme';
import type { PeerAgent } from '../../../../renderer/types';

// By name, without `self`: Docs, Infra, Solo, Web.
const FLEET: PeerAgentOption[] = [
	{ id: 'self', name: 'Me', groupId: 'g-backend' },
	{ id: 'peer-infra', name: 'Infra', groupId: 'g-backend' },
	{ id: 'peer-docs', name: 'Docs', groupId: 'g-backend' },
	{ id: 'peer-web', name: 'Web', groupId: 'g-frontend' },
	{ id: 'peer-solo', name: 'Solo' },
];

const DOCS_ROW: PeerAgent = { sessionId: 'peer-docs', read: true, write: false };
const INFRA_ROW: PeerAgent = { sessionId: 'peer-infra', read: true, write: true };

/** An agent in the Backend group, editing its own peers, with nothing granted yet. */
function renderSection(overrides: Partial<PeerAgentsSectionProps> = {}) {
	const props: PeerAgentsSectionProps = {
		theme: mockTheme,
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
	render(<PeerAgentsSection {...props} />);
	return props;
}

const groupCheckbox = () => screen.getByRole('checkbox', { name: /Peers in my group/ });
const worktreeCheckbox = () => screen.getByRole('checkbox', { name: /Worktree family/ });
const square = (name: string) => screen.getByRole('switch', { name });
const pickers = () => screen.getAllByRole('button', { name: 'Peer agent' });

/** Open one row's agent picker and read what it offers, top to bottom. */
function openPicker(row = 0): string[] {
	fireEvent.click(pickers()[row]);
	return screen.getAllByRole('option').map((option) => option.textContent ?? '');
}

describe('PeerAgentsSection', () => {
	describe('copy', () => {
		// The only place the user learns what the squares do here and that a row
		// is an override. Neither is visible in the controls themselves.
		it('says what R and W do and that a named row overrides the grants', () => {
			renderSection();

			const copy = screen.getByText(/Agents this one may reach on its own/);
			expect(copy).toHaveTextContent('R lets it consult a peer');
			expect(copy).toHaveTextContent("the peer's open tab is not touched");
			expect(copy).toHaveTextContent("W lets it delegate: the work lands in the peer's live tab");
			expect(copy).toHaveTextContent(
				'A row for a named agent overrides the group and worktree grants'
			);
			expect(copy).toHaveTextContent('a row with neither square lit excludes that agent');
		});

		it('draws the two grants above the explicit rows, the broader statement first', () => {
			renderSection({ peers: [DOCS_ROW] });

			const order = [
				groupCheckbox(),
				worktreeCheckbox(),
				pickers()[0],
				screen.getByRole('button', { name: 'Add Peer' }),
			];
			for (let i = 0; i < order.length - 1; i++) {
				expect(
					order[i].compareDocumentPosition(order[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING
				).toBeTruthy();
			}
		});
	});

	describe('explicit rows', () => {
		it('adds a consult-only row so delegate is a deliberate second click', () => {
			const { onChange } = renderSection();

			fireEvent.click(screen.getByRole('button', { name: 'Add Peer' }));

			expect(onChange).toHaveBeenCalledWith([
				{ sessionId: '', read: true, write: false, description: '' },
			]);
		});

		it('appends the new row after the rows already there', () => {
			const { onChange } = renderSection({ peers: [DOCS_ROW] });

			fireEvent.click(screen.getByRole('button', { name: 'Add Peer' }));

			expect(onChange).toHaveBeenCalledWith([
				DOCS_ROW,
				{ sessionId: '', read: true, write: false, description: '' },
			]);
		});

		it('removes only the targeted row', () => {
			const { onChange } = renderSection({ peers: [DOCS_ROW, INFRA_ROW] });

			fireEvent.click(screen.getAllByRole('button', { name: 'Remove peer' })[0]);

			expect(onChange).toHaveBeenCalledWith([INFRA_ROW]);
		});

		it('toggles consult and delegate independently', () => {
			const { onChange } = renderSection({ peers: [DOCS_ROW] });

			fireEvent.click(square('Delegate to this peer'));
			expect(onChange).toHaveBeenLastCalledWith([
				{ sessionId: 'peer-docs', read: true, write: true },
			]);

			fireEvent.click(square('Consult this peer'));
			// The section holds no state: the second click still sees write off.
			expect(onChange).toHaveBeenLastCalledWith([
				{ sessionId: 'peer-docs', read: false, write: false },
			]);
		});

		it('changes only the row whose square was clicked', () => {
			const { onChange } = renderSection({ peers: [DOCS_ROW, INFRA_ROW] });

			fireEvent.click(screen.getAllByRole('switch', { name: 'Consult this peer' })[1]);

			expect(onChange).toHaveBeenCalledWith([
				DOCS_ROW,
				{ sessionId: 'peer-infra', read: false, write: true },
			]);
		});

		it('reflects each access in the square state for screen readers', () => {
			renderSection({ peers: [DOCS_ROW] });

			expect(square('Consult this peer')).toHaveAttribute('aria-checked', 'true');
			expect(square('Delegate to this peer')).toHaveAttribute('aria-checked', 'false');
		});

		it('edits the optional note on a peer', () => {
			const { onChange } = renderSection({ peers: [DOCS_ROW] });

			fireEvent.change(
				screen.getByPlaceholderText('Optional: what this peer is for or when to reach it'),
				{ target: { value: 'Owns the public docs' } }
			);

			expect(onChange).toHaveBeenCalledWith([
				{ sessionId: 'peer-docs', read: true, write: false, description: 'Owns the public docs' },
			]);
		});

		it('says a row with neither square lit excludes the agent', () => {
			renderSection({ peers: [{ sessionId: 'peer-docs', read: false, write: false }] });

			expect(screen.getByText(/this row excludes the agent/)).toBeInTheDocument();
		});

		it('does not call a row an exclusion before an agent is picked', () => {
			renderSection({ peers: [{ sessionId: '', read: false, write: false }] });

			expect(screen.queryByText(/this row excludes the agent/)).not.toBeInTheDocument();
		});

		it('keeps a row whose agent is gone and says it grants nothing', () => {
			const gone: PeerAgent = { sessionId: 'deleted-agent', read: false, write: false };
			const { onChange } = renderSection({ peers: [gone, DOCS_ROW] });

			// Never a bare session id in the trigger.
			expect(pickers()[0]).toHaveTextContent('Agent no longer exists');
			expect(pickers()[0]).not.toHaveTextContent('deleted-agent');
			expect(screen.getByText(/This agent no longer exists/)).toBeInTheDocument();
			// A missing agent is not an exclusion: there is nobody to exclude.
			expect(screen.queryByText(/this row excludes the agent/)).not.toBeInTheDocument();

			// An edit to another row carries the stale row along untouched.
			fireEvent.click(screen.getAllByRole('switch', { name: 'Delegate to this peer' })[1]);
			expect(onChange).toHaveBeenCalledWith([gone, { ...DOCS_ROW, write: true }]);
		});

		it('disables Add Peer when every other agent already has a row', () => {
			renderSection({
				peers: ['peer-docs', 'peer-infra', 'peer-solo', 'peer-web'].map((sessionId) => ({
					sessionId,
					read: true,
					write: false,
				})),
			});

			const add = screen.getByRole('button', { name: 'Add Peer' });
			expect(add).toBeDisabled();
			expect(add).toHaveAttribute('title', 'Every other agent already has a row');
		});

		it('disables Add Peer when the fleet is only the agent itself', () => {
			renderSection({ availableAgents: [FLEET[0]] });

			const add = screen.getByRole('button', { name: 'Add Peer' });
			expect(add).toBeDisabled();
			expect(add).toHaveAttribute('title', 'There are no other agents yet');
		});
	});

	describe('agent picker', () => {
		it('leaves the agent being edited out and lists the others by name', () => {
			renderSection({ peers: [{ sessionId: '', read: true, write: false }] });

			expect(openPicker()).toEqual(['Select an agent...', 'Docs', 'Infra', 'Solo', 'Web']);
		});

		it('offers the whole fleet on create, when there is no agent to leave out', () => {
			renderSection({
				selfSessionId: undefined,
				peers: [{ sessionId: '', read: true, write: false }],
			});

			expect(openPicker()).toEqual(['Select an agent...', 'Docs', 'Infra', 'Me', 'Solo', 'Web']);
		});

		it('shows the picked agent by name, not by session id', () => {
			renderSection({ peers: [DOCS_ROW] });

			expect(pickers()[0]).toHaveTextContent('Docs');
			expect(pickers()[0]).not.toHaveTextContent('peer-docs');
		});

		it('stores the session id of the chosen agent', () => {
			const { onChange } = renderSection({
				peers: [{ sessionId: '', read: true, write: false, description: '' }],
			});

			openPicker();
			fireEvent.click(screen.getByRole('option', { name: 'Infra' }));

			expect(onChange).toHaveBeenCalledWith([
				{ sessionId: 'peer-infra', read: true, write: false, description: '' },
			]);
		});

		// Two rows for one agent collapse to the last on save, so a second row
		// for the same agent is never offered.
		it('leaves out the agents the other rows hold and keeps its own', () => {
			renderSection({ peers: [DOCS_ROW, INFRA_ROW] });

			expect(openPicker(0)).toEqual(['Select an agent...', 'Docs', 'Solo', 'Web']);
		});
	});

	describe('group grant', () => {
		it('is disabled with a hint when the agent has no group', () => {
			renderSection({ groupId: undefined, groupName: undefined });

			expect(groupCheckbox()).toBeDisabled();
			expect(groupCheckbox()).not.toBeChecked();
			expect(square('Consult peers in my group')).toBeDisabled();
			expect(square('Delegate to peers in my group')).toBeDisabled();
			expect(
				screen.getByText('This agent is not in a group. Put it in one to use this.')
			).toBeInTheDocument();
		});

		it('is enabled in a group and counts the other members, not the agent itself', () => {
			renderSection();

			expect(groupCheckbox()).toBeEnabled();
			// Me, Infra and Docs are in Backend. Me is the agent being edited.
			expect(screen.getByText('2 other agents in Backend')).toBeInTheDocument();
		});

		it('counts every member on create, when there is no agent to leave out', () => {
			renderSection({ selfSessionId: undefined });

			expect(screen.getByText('3 other agents in Backend')).toBeInTheDocument();
		});

		it('counts one member in the singular', () => {
			renderSection({ groupId: 'g-frontend', groupName: 'Frontend' });

			expect(screen.getByText('1 other agent in Frontend')).toBeInTheDocument();
		});

		it('says an empty group still covers the agents that join it', () => {
			renderSection({ groupId: 'g-empty', groupName: 'Empty' });

			expect(
				screen.getByText('No other agents in Empty yet. Agents that join it are covered.')
			).toBeInTheDocument();
		});

		it('counts without a name when the group name is not known', () => {
			renderSection({ groupName: undefined });

			expect(screen.getByText('2 other agents in this group')).toBeInTheDocument();
		});

		it('emits a consult-only grant when checked', () => {
			const { onGroupAccessChange, onWorktreeAccessChange } = renderSection();

			fireEvent.click(groupCheckbox());

			expect(onGroupAccessChange).toHaveBeenCalledWith({ read: true, write: false });
			expect(onWorktreeAccessChange).not.toHaveBeenCalled();
		});

		// Absent is what the data model uses for "off". A pair of false bits would
		// be stored as a grant that is on and grants nothing.
		it('emits undefined when unchecked, not a pair of false bits', () => {
			const { onGroupAccessChange } = renderSection({ groupAccess: { read: true, write: true } });
			expect(groupCheckbox()).toBeChecked();

			fireEvent.click(groupCheckbox());

			expect(onGroupAccessChange).toHaveBeenCalledTimes(1);
			expect(vi.mocked(onGroupAccessChange).mock.calls[0]).toEqual([undefined]);
			expect(onGroupAccessChange).not.toHaveBeenCalledWith({ read: false, write: false });
		});

		it('toggles consult and delegate independently while it is on', () => {
			const { onGroupAccessChange } = renderSection({ groupAccess: { read: true, write: false } });

			fireEvent.click(square('Delegate to peers in my group'));
			expect(onGroupAccessChange).toHaveBeenLastCalledWith({ read: true, write: true });

			fireEvent.click(square('Consult peers in my group'));
			// Only the checkbox turns the grant off. Clearing a square does not.
			expect(onGroupAccessChange).toHaveBeenLastCalledWith({ read: false, write: false });
		});

		it('turns on with only that access when a square is clicked while it is off', () => {
			const { onGroupAccessChange } = renderSection();

			fireEvent.click(square('Delegate to peers in my group'));

			expect(onGroupAccessChange).toHaveBeenCalledWith({ read: false, write: true });
		});

		it('reflects the grant in the checkbox and the squares', () => {
			renderSection({ groupAccess: { read: false, write: true } });

			expect(groupCheckbox()).toBeChecked();
			expect(square('Consult peers in my group')).toHaveAttribute('aria-checked', 'false');
			expect(square('Delegate to peers in my group')).toHaveAttribute('aria-checked', 'true');
		});

		it('says a checked grant with neither square lit grants nothing', () => {
			renderSection({ groupAccess: { read: false, write: false } });

			expect(groupCheckbox()).toBeChecked();
			expect(screen.getByText(/this grants nothing/)).toBeInTheDocument();
		});

		it('does not warn about a grant that is off', () => {
			renderSection();

			expect(screen.queryByText(/this grants nothing/)).not.toBeInTheDocument();
		});

		it('does not warn about a grant that grants something', () => {
			renderSection({ groupAccess: { read: true, write: false } });

			expect(screen.queryByText(/this grants nothing/)).not.toBeInTheDocument();
		});

		// An agent that left its group keeps the stored grant. It must stay
		// editable, or the user could never switch it off.
		it('keeps a stored grant editable after the agent left its group', () => {
			const { onGroupAccessChange } = renderSection({
				groupId: undefined,
				groupName: undefined,
				groupAccess: { read: true, write: false },
			});

			expect(groupCheckbox()).toBeEnabled();
			expect(
				screen.getByText('This agent is not in a group, so this grants nothing until it joins one.')
			).toBeInTheDocument();

			fireEvent.click(groupCheckbox());
			expect(vi.mocked(onGroupAccessChange).mock.calls[0]).toEqual([undefined]);
		});
	});

	describe('worktree grant', () => {
		it('is enabled for an agent with no group', () => {
			renderSection({ groupId: undefined, groupName: undefined });

			expect(worktreeCheckbox()).toBeEnabled();
			expect(square('Consult the worktree family')).toBeEnabled();
			expect(square('Delegate to the worktree family')).toBeEnabled();
		});

		it('emits a consult-only grant when checked', () => {
			const { onWorktreeAccessChange, onGroupAccessChange } = renderSection();

			fireEvent.click(worktreeCheckbox());

			expect(onWorktreeAccessChange).toHaveBeenCalledWith({ read: true, write: false });
			expect(onGroupAccessChange).not.toHaveBeenCalled();
		});

		it('emits undefined when unchecked, not a pair of false bits', () => {
			const { onWorktreeAccessChange } = renderSection({
				worktreeAccess: { read: true, write: false },
			});

			fireEvent.click(worktreeCheckbox());

			expect(onWorktreeAccessChange).toHaveBeenCalledTimes(1);
			expect(vi.mocked(onWorktreeAccessChange).mock.calls[0]).toEqual([undefined]);
		});

		it('toggles consult and delegate independently while it is on', () => {
			const { onWorktreeAccessChange } = renderSection({
				worktreeAccess: { read: true, write: false },
			});

			fireEvent.click(square('Delegate to the worktree family'));
			expect(onWorktreeAccessChange).toHaveBeenLastCalledWith({ read: true, write: true });

			fireEvent.click(square('Consult the worktree family'));
			expect(onWorktreeAccessChange).toHaveBeenLastCalledWith({ read: false, write: false });
		});

		it('says a checked grant with neither square lit grants nothing', () => {
			renderSection({ worktreeAccess: { read: false, write: false } });

			expect(screen.getByText(/this grants nothing/)).toBeInTheDocument();
		});
	});
});
