/**
 * @fileoverview Tests for PublishDefaultsDialog: what the publish dialog says
 * about a save. The three outcomes are tested through the modal that raises it
 * (`GroupSettingsModal.test.tsx`); here it is the wording, which is what tells
 * the user who gets what.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
	PublishDefaultsDialog,
	type PublishDialogMember,
} from '../../../../renderer/components/GroupSettingsModal/PublishDefaultsDialog';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { diffGroupDefaults } from '../../../../shared/groupAgentDefaults';
import type { GroupAgentDefaults } from '../../../../shared/types';
import { createMockTheme } from '../../../helpers/mockTheme';

// lucide-react icons are mocked globally in src/__tests__/setup.ts using a Proxy

const theme = createMockTheme();
const group = { name: 'Backend', emoji: '🌳' };

const member = (name: string, toolType: PublishDialogMember['toolType'] = 'claude-code') => ({
	id: name.toLowerCase(),
	name,
	toolType,
});

const renderDialog = (
	before: GroupAgentDefaults,
	after: GroupAgentDefaults,
	members: PublishDialogMember[]
) =>
	render(
		<LayerStackProvider>
			<PublishDefaultsDialog
				theme={theme}
				group={group}
				diff={diffGroupDefaults(before, after)}
				members={members}
				onPublish={vi.fn()}
				onNewAgentsOnly={vi.fn()}
				onCancel={vi.fn()}
			/>
		</LayerStackProvider>
	);

describe('PublishDefaultsDialog', () => {
	it('lists the changed fields by label, and a variable by its name', () => {
		renderDialog(
			{ toolType: 'claude-code' },
			{
				toolType: 'claude-code',
				customModel: 'opus',
				customEnvVars: { CLAUDE_CONFIG_DIR: '~/.work' },
				groupPeerAccess: { read: true, write: false },
			},
			[member('API'), member('Docs')]
		);

		const dialog = screen.getByRole('dialog', { name: 'Publish to existing agents?' });
		expect(dialog).toHaveTextContent(
			'You changed Model, CLAUDE_CONFIG_DIR, and Peers in my group.'
		);
		expect(screen.getByTestId('group-settings-publish-members')).toHaveTextContent(
			'🌳 Backend has 2 agents: API, Docs.'
		);
		expect(screen.getByRole('button', { name: 'Publish to all 2 agents' })).toBeInTheDocument();
		// Every member is on the provider, so there is nothing to say about it.
		expect(screen.queryByTestId('group-settings-publish-provider-note')).not.toBeInTheDocument();
		expect(screen.queryByTestId('group-settings-publish-unpublished')).not.toBeInTheDocument();
		expect(screen.queryByTestId('group-settings-publish-replaced')).not.toBeInTheDocument();
	});

	it('says who a provider setting reaches when the group mixes providers', () => {
		renderDialog(
			{ toolType: 'claude-code' },
			{ toolType: 'claude-code', customModel: 'opus', nudgeMessage: 'Be brief.' },
			[member('API'), member('Scraper', 'codex'), member('Docs')]
		);

		expect(screen.getByTestId('group-settings-publish-provider-note')).toHaveTextContent(
			'Model is a Claude Code setting. Published only to API, Docs.'
		);
		// The nudge still reaches all three.
		expect(screen.getByRole('button', { name: 'Publish to all 3 agents' })).toBeInTheDocument();
	});

	it('counts only the agents a provider-only change reaches', () => {
		renderDialog({ toolType: 'claude-code' }, { toolType: 'claude-code', customModel: 'opus' }, [
			member('API'),
			member('Scraper', 'codex'),
			member('Triage', 'codex'),
		]);

		expect(screen.getByRole('button', { name: 'Publish to 1 of 3 agents' })).toBeInTheDocument();
	});

	it('lists what is for new agents only', () => {
		renderDialog({}, { toolType: 'codex', projectRoot: '/srv/app', nudgeMessage: 'Be brief.' }, [
			member('API'),
		]);

		expect(screen.getByTestId('group-settings-publish-unpublished')).toHaveTextContent(
			'Not published (new agents only): Working Directory and Provider.'
		);
		expect(screen.getByRole('button', { name: 'Publish to 1 agent' })).toBeInTheDocument();
	});

	it('says out loud that a list replaces', () => {
		renderDialog({}, { peerAgents: [{ sessionId: 'docs', read: true, write: false }] }, [
			member('API'),
			member('Docs'),
		]);

		expect(screen.getByTestId('group-settings-publish-replaced')).toHaveTextContent(
			"Peer Agents replaces each agent's own list. A list is not merged."
		);
	});

	it('counts the rest of a long member list', () => {
		const names = Array.from({ length: 11 }, (_, index) => `Agent${index + 1}`);
		renderDialog(
			{},
			{ nudgeMessage: 'Be brief.' },
			names.map((name) => member(name))
		);

		const line = screen.getByTestId('group-settings-publish-members');
		expect(line).toHaveTextContent('has 11 agents: Agent1, ');
		expect(line).toHaveTextContent('Agent8, and 3 more.');
		expect(line).not.toHaveTextContent('Agent9');
	});
});
