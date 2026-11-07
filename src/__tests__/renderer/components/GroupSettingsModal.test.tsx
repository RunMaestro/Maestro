/**
 * @fileoverview Tests for GroupSettingsModal: the explainer, the tabbed form
 * seeded from a group's defaults, the save that omits every blank field, the
 * group's own pill label, Clear defaults, and the dialog that asks whether a
 * save is published to the agents already in the group.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { GroupSettingsModal } from '../../../renderer/components/GroupSettingsModal';
import { __resetRememberedModalTabsForTests } from '../../../renderer/components/ui/ModalTabStrip';
import { __resetGroupDefaultsPublishForTests } from '../../../renderer/services/groupDefaultsPublish';
import { useModalStore } from '../../../renderer/stores/modalStore';
import { useNotificationStore } from '../../../renderer/stores/notificationStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { AgentConfig, Group, Session } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';
import { createMockTheme } from '../../helpers/mockTheme';

// lucide-react icons are mocked globally in src/__tests__/setup.ts using a Proxy

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: vi.fn(() => 'layer-group-settings'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
		getTopLayer: () => undefined,
		closeTopLayer: vi.fn().mockResolvedValue(true),
		getLayers: () => [],
		hasOpenLayers: () => false,
		hasOpenModal: () => false,
	}),
}));

const theme = createMockTheme();

const createGroup = (overrides: Partial<Group> = {}): Group => ({
	id: 'g-backend',
	name: 'Backend',
	emoji: '🌳',
	collapsed: false,
	...overrides,
});

const docsGroup: Group = { id: 'g-docs', name: 'Docs', emoji: '📚', collapsed: false };

/** Show one tab of the form. Only the active tab's fields are rendered. */
const openTab = (name: string) =>
	fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${name}`) }));

describe('GroupSettingsModal', () => {
	let setGroups: ReturnType<typeof vi.fn>;
	let onClose: ReturnType<typeof vi.fn>;

	const renderModal = (group: Group) =>
		render(
			<GroupSettingsModal theme={theme} group={group} setGroups={setGroups} onClose={onClose} />
		);

	/** The groups the last write through `setGroups` would leave in the store. */
	const written = (group: Group): Group[] => {
		const updater = setGroups.mock.calls.at(-1)?.[0] as (prev: Group[]) => Group[];
		return updater([group, docsGroup]);
	};

	beforeEach(() => {
		setGroups = vi.fn();
		onClose = vi.fn();
		// The form remembers its last tab per app session; start every case on General.
		__resetRememberedModalTabsForTests();
		useModalStore.setState({ modals: new Map() });
		useSettingsStore.setState({
			showGroupLabelInBookmarks: true,
			showFullGroupLabelInBookmarks: false,
		});

		vi.mocked(window.maestro.agents.detect).mockResolvedValue([
			{
				id: 'claude-code',
				name: 'Claude Code',
				available: true,
				path: '/usr/local/bin/claude',
				binaryName: 'claude',
				hidden: false,
				configOptions: [{ key: 'model', type: 'text', label: 'Model', default: '' }],
			} as unknown as AgentConfig,
		]);
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({ model: 'claude-sonnet' });
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue(['claude-sonnet', 'claude-opus']);
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [],
		});
	});

	afterEach(() => {
		useSessionStore.setState({ sessions: [], groups: [] } as never);
	});

	it('names the group, says the defaults are copied at create, and shows every tab', () => {
		renderModal(createGroup());

		expect(screen.getByText('Group Settings: 🌳 Backend')).toBeInTheDocument();
		const explainer = screen.getByTestId('group-settings-explainer');
		expect(explainer).toHaveTextContent('Nothing here is read while an agent runs.');
		expect(explainer).toHaveTextContent('Leave a field blank to use the Maestro default.');
		expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
			'General',
			'Provider',
			'Models',
			'Peers',
			'SSH',
		]);
		// The form names no agent.
		expect(screen.queryByText('Agent Name')).not.toBeInTheDocument();
	});

	it('seeds the form from the group defaults', () => {
		renderModal(
			createGroup({
				defaults: {
					projectRoot: '/srv/app',
					nudgeMessage: 'Be brief.',
					customEnvVars: { CLAUDE_CONFIG_DIR: '~/.claude-work' },
				},
			})
		);

		expect(screen.getByDisplayValue('/srv/app')).toBeInTheDocument();
		expect(screen.getByDisplayValue('Be brief.')).toBeInTheDocument();

		openTab('Provider');
		expect(screen.getByDisplayValue('CLAUDE_CONFIG_DIR')).toBeInTheDocument();
		expect(screen.getByDisplayValue('~/.claude-work')).toBeInTheDocument();
	});

	it('saves only what is set, through setGroups, and closes', () => {
		const group = createGroup({ shortLabel: 'BE' });
		renderModal(group);

		fireEvent.change(screen.getByPlaceholderText(/appended to every message/), {
			target: { value: '  Be brief.  ' },
		});
		fireEvent.click(screen.getByText('Save'));

		expect(setGroups).toHaveBeenCalledTimes(1);
		const [saved, untouched] = written(group);
		expect(saved.defaults).toEqual({ nudgeMessage: 'Be brief.' });
		// The pill label is a property of the group and is carried over.
		expect(saved.shortLabel).toBe('BE');
		expect(untouched).toBe(docsGroup);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('stores no defaults field for a form that holds no opinion', () => {
		const group = createGroup({ defaults: { nudgeMessage: 'Be brief.' } });
		renderModal(group);

		fireEvent.change(screen.getByDisplayValue('Be brief.'), { target: { value: '' } });
		fireEvent.click(screen.getByText('Save'));

		expect(written(group)[0]).not.toHaveProperty('defaults');
	});

	it('saves from the keyboard with Cmd+S', () => {
		const group = createGroup({ defaults: { nudgeMessage: 'Be brief.' } });
		renderModal(group);

		fireEvent.keyDown(window, { key: 's', metaKey: true });

		expect(written(group)[0].defaults).toEqual({ nudgeMessage: 'Be brief.' });
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('refuses a relative default working directory before the save', () => {
		renderModal(createGroup());

		fireEvent.change(screen.getByLabelText('Default Working Directory'), {
			target: { value: 'projects/app' },
		});

		expect(screen.getByText('Enter an absolute path')).toBeInTheDocument();
		expect(screen.getByText('Save')).toBeDisabled();
		fireEvent.keyDown(window, { key: 's', metaKey: true });
		expect(setGroups).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});

	describe('Group pill label', () => {
		const labelInput = () => screen.getByLabelText('Group Pill Label');
		const preview = () => screen.getByTestId('group-settings-pill-preview');

		it('is the first field of the General tab, capped at the shared length', () => {
			renderModal(createGroup());

			const fields = within(screen.getByTestId('group-settings-tab-body')).getAllByRole('textbox');
			expect(fields[0]).toBe(labelInput());
			expect(labelInput()).toHaveAttribute('maxlength', '12');
			expect(
				screen.getByText(/Shown beside bookmarked agents in the Left Bar\./)
			).toHaveTextContent('The full name still appears on hover.');
		});

		it('seeds from the group shortLabel', () => {
			renderModal(createGroup({ shortLabel: 'BE' }));

			expect(labelInput()).toHaveValue('BE');
			expect(preview()).toHaveTextContent('BE');
		});

		it('shows the automatic abbreviation as its placeholder and in the preview', () => {
			renderModal(createGroup({ name: '[1] Aleyemma/Money-Sessions' }));

			expect(labelInput()).toHaveValue('');
			expect(labelInput()).toHaveAttribute('placeholder', 'AMS');
			expect(preview()).toHaveTextContent('AMS');
		});

		it('previews the label as it is typed, with the full name on hover', () => {
			renderModal(createGroup());

			fireEvent.change(labelInput(), { target: { value: 'Back' } });

			expect(preview()).toHaveTextContent('Back');
			expect(preview()).toHaveAttribute('title', 'Backend');
			expect(preview().className).toContain('row-group-chip');
		});

		it('saves a trimmed label and stores no defaults for a label-only change', () => {
			const group = createGroup();
			renderModal(group);

			fireEvent.change(labelInput(), { target: { value: '  Back  ' } });
			fireEvent.click(screen.getByText('Save'));

			expect(setGroups).toHaveBeenCalledTimes(1);
			const [saved, untouched] = written(group);
			expect(saved.shortLabel).toBe('Back');
			// The label is a property of the group, never one of its defaults.
			expect(saved).not.toHaveProperty('defaults');
			expect(untouched).toBe(docsGroup);
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('leaves the defaults a group holds alone when only the label changes', () => {
			const group = createGroup({ defaults: { nudgeMessage: 'Be brief.' } });
			renderModal(group);

			fireEvent.change(labelInput(), { target: { value: 'BE' } });
			fireEvent.click(screen.getByText('Save'));

			expect(written(group)[0]).toEqual({ ...group, shortLabel: 'BE' });
		});

		it.each([
			['cleared', ''],
			['whitespace only', '   '],
		])('deletes the field when the label is %s', (_case, value) => {
			const group = createGroup({ shortLabel: 'BE' });
			renderModal(group);

			fireEvent.change(labelInput(), { target: { value } });
			// The automatic abbreviation is back in the preview before the save.
			expect(preview()).toHaveTextContent('Backend');
			fireEvent.click(screen.getByText('Save'));

			expect(written(group)[0]).not.toHaveProperty('shortLabel');
		});

		it('says nothing about Display settings while the label is on screen', () => {
			renderModal(createGroup());

			expect(screen.queryByTestId('group-settings-pill-hidden-note')).not.toBeInTheDocument();
			expect(screen.queryByTestId('group-settings-pill-full-name-note')).not.toBeInTheDocument();
		});

		it('says group pills are hidden, and opens the Display setting that shows them', () => {
			useSettingsStore.setState({ showGroupLabelInBookmarks: false });
			renderModal(createGroup());

			const note = screen.getByTestId('group-settings-pill-hidden-note');
			expect(note).toHaveTextContent(
				'Group pills are currently hidden. Turn on Show group label on bookmarked agents in Settings -> Display to see this.'
			);

			fireEvent.click(
				within(note).getByRole('button', { name: 'Show group label on bookmarked agents' })
			);

			// Settings sits below this modal, so the modal closes first. Nothing is saved.
			expect(onClose).toHaveBeenCalledTimes(1);
			expect(setGroups).not.toHaveBeenCalled();
			expect(useModalStore.getState().isOpen('settings')).toBe(true);
			expect(useModalStore.getState().getData('settings')).toMatchObject({
				tab: 'display',
				settingId: 'display-left-panel-group-label',
			});
		});

		it('says the full group name is drawn in place of the label when that setting is on', () => {
			useSettingsStore.setState({ showFullGroupLabelInBookmarks: true });
			renderModal(createGroup());

			const note = screen.getByTestId('group-settings-pill-full-name-note');
			expect(note).toHaveTextContent('Group pills currently show the full group name');
			// The preview stays the short form: it is the thing this field names.
			fireEvent.change(labelInput(), { target: { value: 'BE' } });
			expect(preview()).toHaveTextContent('BE');

			fireEvent.click(
				within(note).getByRole('button', { name: 'Show full group label on bookmarked agents' })
			);
			expect(useModalStore.getState().getData('settings')).toMatchObject({
				tab: 'display',
				settingId: 'display-left-panel-group-label',
			});
		});

		it('names the hidden pills, not the full name, when both settings are set', () => {
			useSettingsStore.setState({
				showGroupLabelInBookmarks: false,
				showFullGroupLabelInBookmarks: true,
			});
			renderModal(createGroup());

			expect(screen.getByTestId('group-settings-pill-hidden-note')).toBeInTheDocument();
			expect(screen.queryByTestId('group-settings-pill-full-name-note')).not.toBeInTheDocument();
		});
	});

	describe('Provider tab', () => {
		it('starts on no default provider and keeps the env vars when one is chosen', async () => {
			const group = createGroup({
				defaults: { customEnvVars: { CLAUDE_CONFIG_DIR: '~/.claude-work' } },
			});
			renderModal(group);
			openTab('Provider');

			const select = screen.getByTestId('group-settings-provider');
			expect(select).toHaveValue('');
			fireEvent.change(select, { target: { value: 'claude-code' } });
			// The provider's own settings load once it is chosen.
			await waitFor(() => expect(screen.getByText('Claude Code Settings')).toBeInTheDocument());

			fireEvent.click(screen.getByText('Save'));
			expect(written(group)[0].defaults).toEqual({
				toolType: 'claude-code',
				customEnvVars: { CLAUDE_CONFIG_DIR: '~/.claude-work' },
			});
		});

		it('does not write the provider model back as a group default', async () => {
			const group = createGroup({ defaults: { toolType: 'claude-code' } });
			renderModal(group);
			openTab('Provider');

			// The panel shows the provider's own model; the group has no opinion on it.
			await waitFor(() => expect(screen.getByDisplayValue('claude-sonnet')).toBeInTheDocument());
			fireEvent.click(screen.getByText('Save'));

			expect(written(group)[0].defaults).toEqual({ toolType: 'claude-code' });
		});
	});

	describe('Peers tab', () => {
		it('enables the group grant for this group', () => {
			useSessionStore.setState({
				sessions: [
					{ id: 'a1', name: 'Infra', groupId: 'g-backend' },
					{ id: 'a2', name: 'Docs', groupId: 'g-backend' },
				],
				groups: [createGroup()],
			} as never);
			const group = createGroup();
			renderModal(group);
			openTab('Peers');

			const grant = screen.getByRole('checkbox', { name: /Peers in my group/ });
			expect(grant).not.toBeDisabled();
			// The row counts the agents of this group by its name, not "in this group".
			expect(screen.getByText(/other agents? in Backend/)).toBeInTheDocument();

			fireEvent.click(grant);
			fireEvent.click(screen.getByText('Save'));
			// Two agents already live in this group, so the save asks where the grant goes.
			const dialog = screen.getByRole('dialog', { name: 'Publish to existing agents?' });
			fireEvent.click(within(dialog).getByRole('button', { name: 'New agents only' }));
			expect(written(group)[0].defaults).toEqual({
				groupPeerAccess: { read: true, write: false },
			});
		});
	});

	describe('Clear defaults', () => {
		it('is disabled for a group that holds none', () => {
			renderModal(createGroup());
			expect(screen.getByTestId('group-settings-clear')).toBeDisabled();
		});

		it('removes the field after a confirmation, and closes', () => {
			const group = createGroup({ shortLabel: 'BE', defaults: { nudgeMessage: 'Be brief.' } });
			renderModal(group);

			fireEvent.click(screen.getByTestId('group-settings-clear'));
			// Nothing is written until the confirmation is answered.
			expect(setGroups).not.toHaveBeenCalled();

			const confirm = screen.getByRole('dialog', { name: 'Clear defaults' });
			expect(confirm).toHaveTextContent('clearing is not published to them');
			fireEvent.click(within(confirm).getByRole('button', { name: 'Clear defaults' }));

			const [cleared] = written(group);
			expect(cleared).not.toHaveProperty('defaults');
			expect(cleared.shortLabel).toBe('BE');
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('writes nothing when the confirmation is cancelled', () => {
			renderModal(createGroup({ defaults: { nudgeMessage: 'Be brief.' } }));

			fireEvent.click(screen.getByTestId('group-settings-clear'));
			const confirm = screen.getByRole('dialog', { name: 'Clear defaults' });
			fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));

			expect(screen.queryByRole('dialog', { name: 'Clear defaults' })).not.toBeInTheDocument();
			expect(setGroups).not.toHaveBeenCalled();
			expect(onClose).not.toHaveBeenCalled();
		});
	});

	describe('Publishing a save', () => {
		const PUBLISH_DIALOG = 'Publish to existing agents?';
		const aiTabs = [{ id: 'tab-1', agentSessionId: 'provider-session-1' }] as Session['aiTabs'];
		let agents: Session[];

		const stored = (id: string) => useSessionStore.getState().sessions.find((s) => s.id === id)!;
		const changeNudge = (value: string) =>
			fireEvent.change(screen.getByPlaceholderText(/appended to every message/), {
				target: { value },
			});
		const dialog = () => screen.getByRole('dialog', { name: PUBLISH_DIALOG });

		beforeEach(() => {
			__resetGroupDefaultsPublishForTests();
			useNotificationStore.setState({ toasts: [] });
			vi.mocked(window.maestro.sessions.setMany).mockResolvedValue(undefined as never);
			agents = [
				createMockSession({ id: 'a', name: 'API', groupId: 'g-backend', aiTabs }),
				createMockSession({
					id: 'b',
					name: 'Scraper',
					groupId: 'g-backend',
					nudgeMessage: 'Mine.',
				}),
				createMockSession({ id: 'c', name: 'Triage', groupId: 'g-backend' }),
				// Not a member: a publish must never reach it.
				createMockSession({ id: 'other', name: 'Elsewhere', groupId: 'g-docs' }),
			];
			useSessionStore.setState({ sessions: agents, groups: [] } as never);
		});

		it('saves with no dialog when the group has no agents', () => {
			useSessionStore.setState({ sessions: [agents[3]] });
			const group = createGroup();
			renderModal(group);

			changeNudge('Be brief.');
			fireEvent.click(screen.getByText('Save'));

			expect(screen.queryByRole('dialog', { name: PUBLISH_DIALOG })).not.toBeInTheDocument();
			expect(written(group)[0].defaults).toEqual({ nudgeMessage: 'Be brief.' });
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('saves with no dialog when only the pill label changed', () => {
			const group = createGroup({ defaults: { nudgeMessage: 'Be brief.' } });
			renderModal(group);

			fireEvent.change(screen.getByLabelText('Group Pill Label'), { target: { value: 'API' } });
			fireEvent.click(screen.getByText('Save'));

			expect(screen.queryByRole('dialog', { name: PUBLISH_DIALOG })).not.toBeInTheDocument();
			expect(written(group)[0].shortLabel).toBe('API');
			expect(useSessionStore.getState().sessions).toEqual(agents);
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('saves with no dialog when nothing an agent can take changed', () => {
			// A working directory is for new agents only, so there is nothing to ask.
			const group = createGroup();
			renderModal(group);

			fireEvent.change(screen.getByLabelText('Default Working Directory'), {
				target: { value: '/srv/app' },
			});
			fireEvent.click(screen.getByText('Save'));

			expect(screen.queryByRole('dialog', { name: PUBLISH_DIALOG })).not.toBeInTheDocument();
			expect(written(group)[0].defaults).toEqual({ projectRoot: '/srv/app' });
		});

		it('asks before it writes anything, and names the change and the agents', async () => {
			renderModal(createGroup());

			changeNudge('Be brief.');
			fireEvent.click(screen.getByText('Save'));

			expect(dialog()).toHaveTextContent('You changed Nudge Message.');
			expect(dialog()).toHaveTextContent('🌳 Backend has 3 agents: API, Scraper, Triage.');
			expect(
				within(dialog()).getByRole('button', { name: 'Publish to all 3 agents' })
			).toBeTruthy();
			expect(setGroups).not.toHaveBeenCalled();
			expect(onClose).not.toHaveBeenCalled();
			// The safe outcome has the focus.
			await waitFor(() =>
				expect(document.activeElement).toBe(
					within(dialog()).getByRole('button', { name: 'New agents only' })
				)
			);
		});

		it('says what is not published', () => {
			renderModal(createGroup());

			changeNudge('Be brief.');
			fireEvent.change(screen.getByLabelText('Default Working Directory'), {
				target: { value: '/srv/app' },
			});
			fireEvent.click(screen.getByText('Save'));

			expect(screen.getByTestId('group-settings-publish-unpublished')).toHaveTextContent(
				'Not published (new agents only): Working Directory.'
			);
		});

		it('New agents only writes the profile and leaves every agent as it was', () => {
			const group = createGroup();
			renderModal(group);

			changeNudge('Be brief.');
			fireEvent.click(screen.getByText('Save'));
			fireEvent.click(within(dialog()).getByRole('button', { name: 'New agents only' }));

			expect(written(group)[0].defaults).toEqual({ nudgeMessage: 'Be brief.' });
			// The same objects: not one agent was rewritten.
			const sessions = useSessionStore.getState().sessions;
			expect(sessions).toHaveLength(agents.length);
			sessions.forEach((session, index) => expect(session).toBe(agents[index]));
			expect(useNotificationStore.getState().toasts).toEqual([]);
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('Publish writes the profile and the direct members, and no tab', async () => {
			const group = createGroup();
			renderModal(group);

			changeNudge('Be brief.');
			fireEvent.click(screen.getByText('Save'));
			fireEvent.click(within(dialog()).getByRole('button', { name: 'Publish to all 3 agents' }));

			expect(written(group)[0].defaults).toEqual({ nudgeMessage: 'Be brief.' });
			expect(['a', 'b', 'c'].map((id) => stored(id).nudgeMessage)).toEqual([
				'Be brief.',
				'Be brief.',
				'Be brief.',
			]);
			expect(stored('a').aiTabs).toBe(aiTabs);
			expect(stored('other')).toBe(agents[3]);
			expect(onClose).toHaveBeenCalledTimes(1);

			// The toast is the Undo.
			await waitFor(() =>
				expect(useNotificationStore.getState().toasts[0]?.title).toBe('Published to 3 agents')
			);
			expect(useNotificationStore.getState().toasts[0].clickAction).toEqual({
				kind: 'undo-group-publish',
				publishId: expect.any(String),
			});
		});

		it('Cancel writes nothing at all and keeps the form', () => {
			renderModal(createGroup());

			changeNudge('Be brief.');
			fireEvent.click(screen.getByText('Save'));
			// A save from the keyboard cannot go through under the dialog.
			fireEvent.keyDown(window, { key: 's', metaKey: true });
			fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));

			expect(screen.queryByRole('dialog', { name: PUBLISH_DIALOG })).not.toBeInTheDocument();
			expect(setGroups).not.toHaveBeenCalled();
			expect(useSessionStore.getState().sessions).toEqual(agents);
			expect(onClose).not.toHaveBeenCalled();
			expect(screen.getByDisplayValue('Be brief.')).toBeInTheDocument();
		});
	});
});
