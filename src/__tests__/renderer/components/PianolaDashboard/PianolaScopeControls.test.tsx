/** Rendered native selections use the real hook; only IPC transport is a fixture. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PianolaScopeControls } from '../../../../renderer/components/PianolaDashboard/PianolaScopeControls';
import { usePianolaSupervisor } from '../../../../renderer/components/PianolaDashboard/usePianolaSupervisor';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
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

function Controls() {
	const supervisor = usePianolaSupervisor();
	return <PianolaScopeControls theme={mockTheme} supervisor={supervisor} />;
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
