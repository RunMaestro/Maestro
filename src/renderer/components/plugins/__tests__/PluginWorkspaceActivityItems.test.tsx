import '@testing-library/jest-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginWorkspaceActivityItems } from '../PluginWorkspaceActivityItems';
import type { InteractivePanelHostBinder } from '../PluginInteractivePanelFrame';
import { closePluginWorkspace } from '../pluginWorkspaceNavigation';
import type {
	PluginWorkspaceProjection,
	PluginWorkspaceProjectionSource,
} from '../pluginWorkspaceProjection';
import { THEMES } from '../../../constants/themes';
import type {
	AggregatedContributions,
	CanonicalInteractivePanelContribution,
	CanonicalWorkspaceContribution,
} from '../../../../shared/plugins/contributions';

const EMPTY: AggregatedContributions = {
	themes: [],
	iconPacks: [],
	prompts: [],
	settings: [],
	commandMacros: [],
	cueTriggers: [],
	commands: [],
	panels: [],
	workspaces: [],
	interactivePanels: [],
	agents: [],
	tools: [],
	keybindings: [],
	uiItems: [],
	hostViews: [],
	groupings: [],
	errorsByPlugin: {},
};

const workspace = {
	ownerPluginId: 'com.example.agent',
	localId: 'workspace',
	canonicalContributionId: 'com.example.agent/workspace',
	title: 'Agent workspace',
	icon: 'bot',
	panelLocalId: 'workspace-panel',
	order: 0,
} as unknown as CanonicalWorkspaceContribution;
const interactivePanel = {
	ownerPluginId: 'com.example.agent',
	localId: 'workspace-panel',
	canonicalContributionId: 'com.example.agent/workspace-panel',
	title: 'Agent panel',
	entry: 'panel.html',
} as unknown as CanonicalInteractivePanelContribution;

const pluginBridge = {
	contributions: vi.fn<() => Promise<AggregatedContributions>>(),
	onChanged: vi.fn(() => () => {}),
};

const projectionSource: PluginWorkspaceProjectionSource = {
	getSnapshot: vi.fn(
		async (): Promise<PluginWorkspaceProjection> => ({
			connection: 'ready',
			workspaces: [],
			selection: null,
		})
	),
	subscribe: vi.fn(() => vi.fn()),
	reveal: vi.fn(async () => {}),
};
const binder: InteractivePanelHostBinder = { bind: vi.fn(() => vi.fn()) };

beforeEach(() => {
	window.maestro.plugins = pluginBridge as unknown as typeof window.maestro.plugins;
	pluginBridge.contributions.mockReset().mockResolvedValue(EMPTY);
	pluginBridge.onChanged.mockClear();
	closePluginWorkspace();
});

afterEach(() => cleanup());

describe('PluginWorkspaceActivityItems', () => {
	it('renders a destination only when a paired workspace and interactive panel are capability-gated in', async () => {
		pluginBridge.contributions.mockResolvedValue({
			...EMPTY,
			workspaces: [workspace],
			interactivePanels: [interactivePanel],
		});

		render(
			<PluginWorkspaceActivityItems
				theme={THEMES.dracula}
				binder={binder}
				source={projectionSource}
			/>
		);

		const destination = await screen.findByRole('button', { name: 'Open Agent workspace' });
		fireEvent.click(destination);
		await waitFor(() => expect(destination).toHaveAttribute('aria-current', 'page'));
	});

	it('displays the host badge verbatim instead of deriving a badge from sessions', async () => {
		pluginBridge.contributions.mockResolvedValue({
			...EMPTY,
			workspaces: [workspace],
			interactivePanels: [interactivePanel],
		});
		const source: PluginWorkspaceProjectionSource = {
			getSnapshot: vi.fn(async () => ({
				connection: 'ready' as const,
				selection: null,
				workspaces: [
					{
						ownerPluginId: workspace.ownerPluginId,
						workspaceLocalId: workspace.localId,
						panelLocalId: workspace.panelLocalId,
						generation: '1',
						projectionRevision: 1,
						status: { state: 'ready' as const, label: 'Ready' },
						badge: 7,
						sessions: [
							{
								externalSessionId: 'session',
								title: 'OMP',
								status: 'working' as const,
								unread: 42,
								pendingApproval: false,
								updatedAt: 1,
								snapshotToken: 'opaque-token-000000000000',
							},
						],
					},
				],
			})),
			subscribe: vi.fn(() => vi.fn()),
			reveal: vi.fn(async () => {}),
		};

		render(<PluginWorkspaceActivityItems theme={THEMES.dracula} binder={binder} source={source} />);

		expect(await screen.findByText('7')).toBeInTheDocument();
		expect(screen.queryByText('42')).toBeNull();
	});

	it('refreshes destinations after the workspace projection arrives after plugin consent', async () => {
		let emitProjection: ((snapshot: PluginWorkspaceProjection) => void) | undefined;
		const source: PluginWorkspaceProjectionSource = {
			getSnapshot: vi.fn(async () => ({
				connection: 'ready' as const,
				selection: null,
				workspaces: [],
			})),
			subscribe: vi.fn((listener) => {
				emitProjection = listener;
				return vi.fn();
			}),
			reveal: vi.fn(async () => {}),
		};

		render(<PluginWorkspaceActivityItems theme={THEMES.dracula} binder={binder} source={source} />);
		await waitFor(() => expect(pluginBridge.contributions).toHaveBeenCalledOnce());
		expect(screen.queryByRole('button', { name: 'Open Agent workspace' })).toBeNull();

		pluginBridge.contributions.mockResolvedValue({
			...EMPTY,
			workspaces: [workspace],
			interactivePanels: [interactivePanel],
		});
		emitProjection?.({
			connection: 'ready',
			selection: null,
			workspaces: [
				{
					ownerPluginId: workspace.ownerPluginId,
					workspaceLocalId: workspace.localId,
					panelLocalId: workspace.panelLocalId,
					generation: '1',
					projectionRevision: 1,
					status: { state: 'ready', label: 'Ready' },
					badge: null,
					sessions: [],
				},
			],
		});

		expect(await screen.findByRole('button', { name: 'Open Agent workspace' })).toBeVisible();
	});

	it('does not expose a route before the host binder is injected', async () => {
		pluginBridge.contributions.mockResolvedValue({
			...EMPTY,
			workspaces: [workspace],
		});
		const { container } = render(<PluginWorkspaceActivityItems theme={THEMES.dracula} />);

		expect(container.querySelector('[data-plugin-workspace-activity-items]')).toBeNull();
	});
});
