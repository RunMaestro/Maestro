/** Rendered native selections use the real hook; only IPC transport is a fixture. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PianolaScopeControls } from '../../../../renderer/components/PianolaDashboard/PianolaScopeControls';
import { usePianolaSupervisor } from '../../../../renderer/components/PianolaDashboard/usePianolaSupervisor';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { notifyToast } from '../../../../renderer/stores/notificationStore';
import { createMockSession, resetAllStores } from '../../../helpers';
import { mockTheme } from '../../../helpers/mockTheme';
import type { PianolaSupervisorSnapshot } from '../../../../main/ipc/handlers/pianola';
import type { PianolaSupervisedTarget } from '../../../../shared/pianola/storage';

vi.mock('../../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<object>()),
	notifyToast: vi.fn(),
}));
vi.mock('../../../../renderer/utils/sentry', () => ({ captureException: vi.fn() }));

const scope: PianolaSupervisedTarget = {
	id: '11111111-1111-4111-8111-111111111111',
	kind: 'watch-scope',
	enabled: true,
	createdAt: 1,
	managerAgentId: 'manager',
	selection: {
		mode: 'agents-and-groups',
		label: 'Fixture selection',
		agentIds: ['owner'],
		groupIds: ['group'],
		excludedAgentIds: ['excluded'],
	},
};
let persisted: PianolaSupervisorSnapshot;
let original: typeof window.maestro;

function Controls({ autoWatchControl = false }: { autoWatchControl?: boolean }) {
	const supervisor = usePianolaSupervisor();
	return (
		<PianolaScopeControls
			theme={mockTheme}
			supervisor={supervisor}
			autoWatchControl={autoWatchControl}
		/>
	);
}

beforeEach(() => {
	resetAllStores();
	useSessionStore.setState({
		sessions: [
			createMockSession({ id: 'owner', name: 'Owner' }),
			createMockSession({ id: 'excluded', name: 'Excluded agent' }),
			createMockSession({ id: 'manager', name: 'Mira', isPianola: true }),
		],
		groups: [{ id: 'group', name: 'Native group', emoji: '📁', collapsed: false }],
	});
	persisted = { targets: [structuredClone(scope)], health: [], checkpoints: [] };
	original = window.maestro;
	window.maestro = {
		...original,
		pianola: {
			...original.pianola,
			supervisor: {
				list: vi.fn(async () => structuredClone(persisted)),
				add: vi.fn(async (target) => {
					persisted.targets = [
						{
							...target,
							id: target.id ?? scope.id,
							createdAt: target.createdAt ?? 1,
						} as PianolaSupervisedTarget,
					];
					return structuredClone(persisted);
				}),
				setEnabled: vi.fn(async (id, enabled) => {
					persisted.targets = persisted.targets.map((t) => (t.id === id ? { ...t, enabled } : t));
					return structuredClone(persisted);
				}),
				remove: vi.fn(async () => ({ targets: [], health: [], checkpoints: [] })),
			},
		},
	};
});
afterEach(() => {
	window.maestro = original;
	vi.restoreAllMocks();
	resetAllStores();
});

describe('PianolaScopeControls production hook composition', () => {
	it('keeps the selection open and displays the migration refusal', async () => {
		vi.mocked(window.maestro.pianola.supervisor.add).mockResolvedValueOnce({
			...persisted,
			migration: {
				status: 'NeedsConfiguration',
				scopeId: scope.id,
				watchIds: ['old'],
				reason: 'Legacy owner cannot be fenced',
			},
		});
		render(<Controls />);
		await screen.findByText('Fixture selection');
		fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() =>
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({ message: 'Legacy owner cannot be fenced' })
			)
		);
		expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
	});

	it('keeps the edited selection open when saving fails', async () => {
		vi.mocked(window.maestro.pianola.supervisor.add).mockRejectedValueOnce(new Error('disk full'));
		render(<Controls />);
		await screen.findByText('Fixture selection');
		fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
		fireEvent.change(screen.getByRole('textbox', { name: 'Label' }), {
			target: { value: 'Unsaved selection' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
		expect(screen.getByRole('textbox', { name: 'Label' })).toHaveValue('Unsaved selection');
		expect(persisted.targets[0].selection?.label).toBe('Fixture selection');
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'Could not save selection: disk full' })
		);
	});

	it('saves native group/whole-agent/exclusion identities and reloads the persisted edit', async () => {
		const view = render(<Controls />);
		await screen.findByText('Fixture selection');
		fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
		expect(screen.getByRole('combobox', { name: 'Manager' })).toHaveValue('manager');
		expect(screen.getByRole('checkbox', { name: 'Native group' })).toBeChecked();
		expect(screen.getByRole('checkbox', { name: 'Select Owner' })).toBeChecked();
		fireEvent.click(screen.getByRole('checkbox', { name: 'Exclude Owner' }));
		fireEvent.click(screen.getByRole('checkbox', { name: 'Native group' }));
		fireEvent.change(screen.getByRole('textbox', { name: 'Label' }), {
			target: { value: 'Updated selection' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await screen.findByText('Updated selection');
		expect(window.maestro.pianola.supervisor.add).toHaveBeenCalledWith(
			expect.objectContaining({
				id: scope.id,
				managerAgentId: 'manager',
				enabled: true,
				selection: {
					mode: 'agents-and-groups',
					label: 'Updated selection',
					agentIds: ['owner'],
					groupIds: [],
					excludedAgentIds: ['excluded', 'owner'],
				},
			})
		);
		view.unmount();
		render(<Controls />);
		await screen.findByText('Updated selection');
		fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
		expect(screen.getByRole('checkbox', { name: 'Native group' })).not.toBeChecked();
		expect(screen.getAllByRole('checkbox', { name: /Owner/ })[1]).toBeChecked();
	});

	it('pauses/resumes through the persisted native API and creates selections disabled', async () => {
		render(<Controls />);
		await screen.findByText('Fixture selection');
		fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
		await screen.findByRole('button', { name: 'Resume' });
		expect(window.maestro.pianola.supervisor.setEnabled).toHaveBeenLastCalledWith(scope.id, false);
		fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
		await screen.findByRole('button', { name: 'Pause' });
		expect(window.maestro.pianola.supervisor.setEnabled).toHaveBeenLastCalledWith(scope.id, true);
		fireEvent.click(screen.getByRole('button', { name: '+ Add selection' }));
		const save = screen.getByRole('button', { name: 'Save' });
		expect(save).toBeDisabled();
		fireEvent.change(screen.getByRole('textbox', { name: 'Label' }), {
			target: { value: 'New selection' },
		});
		fireEvent.change(screen.getByRole('combobox', { name: 'Manager' }), {
			target: { value: 'manager' },
		});
		expect(save).toBeDisabled();
		fireEvent.click(screen.getByRole('checkbox', { name: 'Native group' }));
		expect(screen.queryByRole('checkbox', { name: /Mira/ })).not.toBeInTheDocument();
		fireEvent.click(save);
		await waitFor(() =>
			expect(window.maestro.pianola.supervisor.add).toHaveBeenCalledWith(
				expect.objectContaining({
					enabled: false,
					managerAgentId: 'manager',
					selection: expect.objectContaining({ groupIds: ['group'] }),
				})
			)
		);
	});

	it.each(['blocked', 'stale', 'paused'] as const)(
		'shows %s current coverage and per-tab errors despite a running worker',
		async (status) => {
			persisted.health = [
				{
					id: scope.id,
					kind: 'watch-scope',
					state: 'running',
					restarts: 0,
					recentLogs: [],
				},
			];
			persisted.checkpoints = [
				{
					scopeId: scope.id,
					checkpoint: null,
					coverage: {
						configurationFingerprint: 'a'.repeat(64),
						checkpointFingerprint: 'b'.repeat(64),
						censusAt: 100,
						ageMs: 30_001,
						staleAfterMs: 30_000,
						fresh: false,
						status,
						reason: 'Current census requires attention',
						nextActor: status === 'paused' ? 'none' : 'operator',
						nextAction: 'Restore current census',
						tabs: [
							{
								agentId: 'owner',
								tabId: 'broken',
								status,
								ownerScopeId: null,
								observedAt: 100,
								reason: 'Current ownership unavailable',
								error: 'Transcript cursor unavailable',
								nextActor: 'operator',
								nextAction: 'Restore transcript cursor',
							},
							{
								agentId: 'owner',
								tabId: 'healthy',
								status: 'covered',
								ownerScopeId: scope.id,
								observedAt: 100,
								reason: 'Transcript verified',
								nextActor: 'worker',
								nextAction: 'Continue monitoring',
							},
						],
					},
				},
			];
			render(<Controls />);
			await screen.findByText(/Coverage: /);
			expect(
				screen.getByText(new RegExp(`Coverage: ${status} \\(not fresh\\)`))
			).toBeInTheDocument();
			expect(screen.getByText(/Chat broken:/)).toHaveTextContent('Transcript cursor unavailable');
			expect(screen.getByText(/Chat broken:/)).toHaveTextContent(
				'operator: Restore transcript cursor'
			);
			expect(screen.getByText(/Chat healthy:/)).toHaveTextContent('covered');
			expect(screen.getAllByText('Owner')).toHaveLength(1);
		}
	);

	it('shows unknown coverage for historical snapshots and cancels without saving', async () => {
		render(<Controls />);
		await screen.findByText('Fixture selection');
		expect(screen.getByText(/Coverage unknown: current census unavailable/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
		fireEvent.change(screen.getByRole('textbox', { name: 'Label' }), {
			target: { value: 'Discarded' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(window.maestro.pianola.supervisor.add).not.toHaveBeenCalled();
		expect(screen.getByText('Fixture selection')).toBeInTheDocument();
	});
});

it('configures standing future coverage at Auto-Watch with an explicitly chosen manager', async () => {
	persisted.targets = [];
	render(<Controls autoWatchControl />);
	await screen.findByText('No selections registered.');
	fireEvent.click(screen.getByRole('checkbox', { name: /Automatically watch future/ }));
	expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
	expect(window.maestro.pianola.supervisor.add).not.toHaveBeenCalled();
	fireEvent.change(screen.getByRole('combobox', { name: 'Manager' }), {
		target: { value: 'manager' },
	});
	fireEvent.click(screen.getByRole('button', { name: 'Save' }));
	await waitFor(() =>
		expect(window.maestro.pianola.supervisor.add).toHaveBeenCalledWith(
			expect.objectContaining({
				managerAgentId: 'manager',
				enabled: false,
				selection: expect.objectContaining({ futureLocalAgents: true, agentIds: [], groupIds: [] }),
			})
		)
	);
	fireEvent.click(screen.getByRole('checkbox', { name: /Automatically watch future/ }));
	await waitFor(() =>
		expect(window.maestro.pianola.supervisor.setEnabled).toHaveBeenCalledWith(scope.id, true)
	);
});

it('does not choose a manager implicitly when multiple future scopes exist', async () => {
	persisted.targets = [
		scope,
		{ ...scope, id: '22222222-2222-4222-8222-222222222222', managerAgentId: 'other' },
	].map((t) => ({ ...t, selection: { ...t.selection!, futureLocalAgents: true } }));
	render(<Controls autoWatchControl />);
	await screen.findByText(/Multiple future-agent selections/);
	expect(screen.getByRole('checkbox', { name: /Automatically watch future/ })).toBeDisabled();
	expect(window.maestro.pianola.supervisor.setEnabled).not.toHaveBeenCalled();
});

it('distinguishes registry pause from actual worker health and identifies selected members', async () => {
	persisted.targets[0].enabled = false;
	persisted.health = [
		{ id: scope.id, kind: 'watch-scope', state: 'running', restarts: 0, recentLogs: [] },
	];
	render(<Controls />);
	await screen.findByText('Fixture selection');
	expect(screen.getByText(/Registry: Paused/)).toBeInTheDocument();
	expect(screen.getByText(/Worker: running/)).toBeInTheDocument();
	expect(screen.getByText(/Agents: Owner/)).toBeInTheDocument();
	expect(screen.getByText(/Groups: Native group/)).toBeInTheDocument();
	expect(screen.getByText(/Excluded: Excluded agent/)).toBeInTheDocument();
});

it('does not label an unused Auto-Watch as a legacy configuration problem', async () => {
	persisted.targets = [];
	render(<Controls autoWatchControl />);
	await screen.findByText('No selections registered.');
	expect(screen.queryByText(/NeedsConfiguration/)).not.toBeInTheDocument();
});

it('shows NeedsConfiguration for a legacy auto-watch boolean without a policy', async () => {
	persisted.targets = [];
	useSettingsStore.setState({ pianolaAutoWatchNewAgents: true });
	render(<Controls autoWatchControl />);
	await screen.findByText(/NeedsConfiguration/);
	expect(
		screen.getByText(/Legacy Auto-Watch is enabled without a manager policy/)
	).toBeInTheDocument();
});
