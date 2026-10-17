/**
 * Tests for DelegationGraphPlacement - the "Add agent" control, the overlay
 * drawn while an agent is dragged over the canvas, and the notice that stays
 * while an added agent has no edge.
 *
 * What the view does with them (what a pick and a drop write, and what they do
 * not) is in `DelegationGraphView.test.tsx`.
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
	DelegationAddAgentSelect,
	DelegationDropOverlay,
	DelegationPlacedNotice,
	delegationGroupLabel,
	delegationScopeGroups,
	placedAgentHint,
	sectionAgentsForAdding,
	type DelegationAddAgentSection,
} from '../../../../renderer/components/DelegationGraph/DelegationGraphPlacement';
import type { DelegationOffGraphAgent } from '../../../../shared/delegationGraph';
import { mockTheme } from '../../../helpers/mockTheme';

const PLATFORM = { id: 'g-1', name: 'Platform', emoji: '' };
const RESEARCH = { id: 'g-2', name: 'Research', emoji: '🔬' };

const GAMMA: DelegationOffGraphAgent = { sessionId: 'c', name: 'Gamma', groupId: RESEARCH.id };
const ZETA: DelegationOffGraphAgent = { sessionId: 'z', name: 'Zeta', groupId: RESEARCH.id };
const PAPA: DelegationOffGraphAgent = { sessionId: 'p', name: 'Papa', groupId: PLATFORM.id };
const FOXTROT: DelegationOffGraphAgent = { sessionId: 'f', name: 'Foxtrot' };
/** In a group that was deleted. */
const ORPHAN: DelegationOffGraphAgent = { sessionId: 'o', name: 'Orphan', groupId: 'g-gone' };

describe('delegationGroupLabel', () => {
	it('is the name, with the emoji in front when the group has one', () => {
		expect(delegationGroupLabel(PLATFORM)).toBe('Platform');
		expect(delegationGroupLabel(RESEARCH)).toBe('🔬 Research');
	});
});

// The one order for a list of groups a graph can open on: the scope select of
// the graph and the command palette both read it.
describe('delegationScopeGroups', () => {
	it('sorts by name and ignores a leading emoji', () => {
		const zulu = { id: 'g-3', name: 'Zulu', emoji: '' };
		expect(delegationScopeGroups([zulu, RESEARCH, PLATFORM])).toEqual([PLATFORM, RESEARCH, zulu]);
	});

	it('returns a new array and leaves the one it was given alone', () => {
		const given = [RESEARCH, PLATFORM];
		const sorted = delegationScopeGroups(given);
		expect(sorted).not.toBe(given);
		expect(given).toEqual([RESEARCH, PLATFORM]);
	});
});

// The one sentence that says placing is not moving. The overlay and the notice
// both read it.
describe('placedAgentHint', () => {
	it('says the agent is not moved into the group, by name', () => {
		expect(placedAgentHint('Platform')).toMatch(/does not move it into Platform\./);
	});

	it('says what keeps the agent on the graph, and what does not', () => {
		const hint = placedAgentHint('Platform');

		expect(hint).toMatch(/Draw an edge/);
		expect(hint).toMatch(/outside the group/);
		expect(hint).toMatch(/With no edge, it is gone/);
	});

	it('still reads as a sentence with no group name', () => {
		expect(placedAgentHint(undefined)).toMatch(/does not move it into this group\./);
	});
});

describe('sectionAgentsForAdding', () => {
	it('makes one section per group, in the order of the groups, with no group last', () => {
		const sections = sectionAgentsForAdding([FOXTROT, GAMMA, PAPA, ZETA], [PLATFORM, RESEARCH]);

		expect(sections).toEqual([
			{ key: PLATFORM.id, label: 'Platform', agents: [PAPA] },
			{ key: RESEARCH.id, label: '🔬 Research', agents: [GAMMA, ZETA] },
			{ key: 'ungrouped', label: 'Ungrouped', agents: [FOXTROT] },
		]);
	});

	it('makes no section for a group with no agent to add', () => {
		const sections = sectionAgentsForAdding([GAMMA], [PLATFORM, RESEARCH]);

		expect(sections.map((section) => section.key)).toEqual([RESEARCH.id]);
	});

	it('lists an agent whose group is gone with the agents in no group', () => {
		const sections = sectionAgentsForAdding([FOXTROT, ORPHAN], [PLATFORM]);

		expect(sections).toEqual([{ key: 'ungrouped', label: 'Ungrouped', agents: [FOXTROT, ORPHAN] }]);
	});

	it('is empty with no agent to add', () => {
		expect(sectionAgentsForAdding([], [PLATFORM, RESEARCH])).toEqual([]);
	});
});

describe('DelegationAddAgentSelect', () => {
	const SECTIONS: DelegationAddAgentSection[] = [
		{ key: RESEARCH.id, label: '🔬 Research', agents: [GAMMA, ZETA] },
		{ key: 'ungrouped', label: 'Ungrouped', agents: [FOXTROT] },
	];

	function renderSelect(props: { disabledReason?: string } = {}) {
		const onAdd = vi.fn();
		render(
			<DelegationAddAgentSelect theme={mockTheme} sections={SECTIONS} onAdd={onAdd} {...props} />
		);
		return {
			onAdd,
			select: screen.getByRole('combobox', { name: 'Add agent' }) as HTMLSelectElement,
		};
	}

	it('reads "Add agent..." and lists each agent under its group', () => {
		const { select } = renderSelect();

		expect(select.value).toBe('');
		expect(select.options[0].textContent).toBe('Add agent...');
		expect(Array.from(select.querySelectorAll('optgroup')).map((group) => group.label)).toEqual([
			'🔬 Research',
			'Ungrouped',
		]);
		expect(Array.from(select.options).map((option) => option.value)).toEqual(['', 'c', 'z', 'f']);
	});

	it('adds the picked agent and goes back to its label', () => {
		const { onAdd, select } = renderSelect();

		fireEvent.change(select, { target: { value: 'z' } });

		expect(onAdd).toHaveBeenCalledTimes(1);
		expect(onAdd).toHaveBeenCalledWith('z');
		expect(select.value).toBe('');
	});

	it('adds nothing when the label itself is picked', () => {
		const { onAdd, select } = renderSelect();

		fireEvent.change(select, { target: { value: '' } });

		expect(onAdd).not.toHaveBeenCalled();
	});

	it('says in its title that the agent is not moved into the group', () => {
		expect(renderSelect().select.title).toMatch(/not moved into the group/);
	});

	it('is disabled with the reason as its title', () => {
		const { select } = renderSelect({ disabledReason: 'Every agent is already on this graph' });

		expect(select).toBeDisabled();
		expect(select).toHaveAttribute('title', 'Every agent is already on this graph');
	});
});

describe('DelegationDropOverlay', () => {
	it('says what the drop does and that it does not move the agent', () => {
		render(
			<DelegationDropOverlay
				theme={mockTheme}
				agentName="Gamma"
				alreadyDrawn={false}
				groupName="Platform"
			/>
		);
		const overlay = screen.getByTestId('delegation-graph-drop-overlay');

		expect(overlay).toHaveTextContent('Drop to add Gamma');
		expect(overlay).toHaveTextContent(placedAgentHint('Platform'));
		expect(overlay).toHaveAttribute('data-already-drawn', 'false');
	});

	it('says that a drop selects an agent that is already drawn', () => {
		render(
			<DelegationDropOverlay theme={mockTheme} agentName="Beta" alreadyDrawn groupName="Platform" />
		);
		const overlay = screen.getByTestId('delegation-graph-drop-overlay');

		expect(overlay).toHaveTextContent('Beta is already on this graph');
		expect(overlay).toHaveTextContent('Drop to select it.');
		expect(overlay).not.toHaveTextContent('does not move');
		expect(overlay).toHaveAttribute('data-already-drawn', 'true');
	});

	// An overlay that took pointer events would take the drop from the canvas.
	it('takes no pointer event', () => {
		render(<DelegationDropOverlay theme={mockTheme} agentName="Gamma" alreadyDrawn={false} />);

		expect(screen.getByTestId('delegation-graph-drop-overlay').className).toContain(
			'pointer-events-none'
		);
	});
});

describe('DelegationPlacedNotice', () => {
	function renderNotice(agentNames: string[]) {
		const onClear = vi.fn();
		render(
			<DelegationPlacedNotice
				theme={mockTheme}
				agentNames={agentNames}
				groupName="Platform"
				onClear={onClear}
			/>
		);
		return { onClear, notice: screen.getByTestId('delegation-graph-placed') };
	}

	it('names one agent in the singular, with the hint', () => {
		const { notice } = renderNotice(['Gamma']);

		expect(notice).toHaveAttribute('role', 'status');
		expect(notice).toHaveTextContent('Gamma has no edge yet.');
		expect(notice).toHaveTextContent(placedAgentHint('Platform'));
	});

	it('names several agents in the plural', () => {
		expect(renderNotice(['Foxtrot', 'Gamma']).notice).toHaveTextContent(
			'Foxtrot, Gamma have no edge yet.'
		);
	});

	// The text is what a user copies into a question, on a click-driven surface.
	it('lets its text be selected', () => {
		expect(renderNotice(['Gamma']).notice.className).toContain('select-text');
	});

	it('takes the agents off the graph from its button', () => {
		const { onClear } = renderNotice(['Gamma']);

		fireEvent.click(screen.getByTestId('delegation-graph-placed-clear'));

		expect(onClear).toHaveBeenCalledTimes(1);
	});
});
