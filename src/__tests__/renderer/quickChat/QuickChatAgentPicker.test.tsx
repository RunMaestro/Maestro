/**
 * QuickChatAgentPicker - the fuzzy agent picker in the Quick Chat window.
 *
 * It replaced a native <select>, which offered no filter and whose popup menu
 * did not open reliably in the Quick Chat panel window.
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
	QuickChatAgentPicker,
	filterQuickChatAgents,
} from '../../../renderer/quickChat/QuickChatAgentPicker';
import { mockTheme } from '../../helpers/mockTheme';
import type { QuickChatAgentOption } from '../../../shared/quickChat';

const AGENTS: QuickChatAgentOption[] = [
	{ id: 'm', name: 'Maestro', groupName: 'Work', provider: 'Claude Code' },
	{ id: 'b', name: 'Backend API', groupName: 'Work', provider: 'Codex' },
	{ id: 'n', name: 'Notes', groupName: 'Personal', provider: 'Claude Code' },
	{ id: 'r', name: 'Research Bot', provider: 'OpenCode' },
];

const ids = (agents: QuickChatAgentOption[], query: string) =>
	filterQuickChatAgents(agents, query).map((hit) => hit.agent.id);

describe('filterQuickChatAgents', () => {
	it('keeps the given order with no query', () => {
		expect(ids(AGENTS, '')).toEqual(['m', 'b', 'n', 'r']);
	});

	it('matches a fuzzy subsequence of the name', () => {
		expect(ids(AGENTS, 'bapi')).toEqual(['b']);
		expect(ids(AGENTS, 'rsb')).toEqual(['r']);
	});

	it('matches the group or provider when no name does', () => {
		expect(ids(AGENTS, 'personal')).toEqual(['n']);
		expect(ids(AGENTS, 'opencode')).toEqual(['r']);
	});

	it('ranks a name hit above a group or provider hit', () => {
		// "work" names nothing but is the group of two agents; "notes" names one.
		const agents: QuickChatAgentOption[] = [
			{ id: 'x', name: 'Alpha', groupName: 'Notes' },
			{ id: 'y', name: 'Notes' },
		];
		expect(ids(agents, 'notes')).toEqual(['y', 'x']);
	});

	it('returns nothing for a query nothing matches', () => {
		expect(ids(AGENTS, 'zzzz')).toEqual([]);
	});
});

function renderPicker(currentAgentId: string | null = 'm') {
	const onPick = vi.fn();
	const onClose = vi.fn();
	render(
		<QuickChatAgentPicker
			theme={mockTheme}
			agents={AGENTS}
			currentAgentId={currentAgentId}
			onPick={onPick}
			onClose={onClose}
		/>
	);
	const input = screen.getByTestId('quick-chat-agent-filter');
	return { onPick, onClose, input };
}

describe('QuickChatAgentPicker', () => {
	it('lists every agent with its group and provider', () => {
		renderPicker();
		expect(screen.getAllByTestId('quick-chat-agent-row')).toHaveLength(4);
		expect(screen.getByText('Work - Codex')).toBeInTheDocument();
	});

	it('starts on the current agent', () => {
		const { onPick, input } = renderPicker('n');
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(onPick).toHaveBeenCalledWith('n');
	});

	it('filters as you type and picks the best match with Enter', () => {
		const { onPick, input } = renderPicker();
		fireEvent.change(input, { target: { value: 'back' } });
		expect(screen.getAllByTestId('quick-chat-agent-row')).toHaveLength(1);
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(onPick).toHaveBeenCalledWith('b');
	});

	it('moves with the arrow keys', () => {
		const { onPick, input } = renderPicker('m');
		fireEvent.keyDown(input, { key: 'ArrowDown' });
		fireEvent.keyDown(input, { key: 'ArrowDown' });
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(onPick).toHaveBeenCalledWith('n');
	});

	it('picks a row on click', () => {
		const { onPick } = renderPicker();
		fireEvent.click(screen.getByText('Research Bot'));
		expect(onPick).toHaveBeenCalledWith('r');
	});

	it('closes on Escape without picking, and keeps the key from the window', () => {
		const { onPick, onClose, input } = renderPicker();
		const windowListener = vi.fn();
		window.addEventListener('keydown', windowListener);
		fireEvent.keyDown(input, { key: 'Escape' });
		window.removeEventListener('keydown', windowListener);

		expect(onClose).toHaveBeenCalled();
		expect(onPick).not.toHaveBeenCalled();
		// The window's own Escape hides Quick Chat; backing out of the picker must not.
		expect(windowListener).not.toHaveBeenCalled();
	});

	it('says so when nothing matches', () => {
		const { input } = renderPicker();
		fireEvent.change(input, { target: { value: 'zzzz' } });
		expect(screen.getByText('No agent matches "zzzz"')).toBeInTheDocument();
	});
});
