/**
 * The Left Bar's Export Agent and Import Agent modals: which options an export
 * offers and sends, and how an import is placed in a group and restores an
 * exact copy.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
	AgentExportModal,
	AgentImportModal,
} from '../../../../renderer/components/Bundles/AgentBundleModals';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { THEMES } from '../../../../renderer/constants/themes';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import type { Group, Session } from '../../../../renderer/types';
import type { EncoreFeatureFlags } from '../../../../renderer/types';

const theme = THEMES['dracula'];
const api = () => window.maestro.cueBundle as unknown as Record<string, ReturnType<typeof vi.fn>>;

const claudeAgent = { id: 'a1', name: 'Reviewer', toolType: 'claude-code' } as Session;
const codexAgent = { id: 'c1', name: 'Coder', toolType: 'codex' } as Session;

function setCue(enabled: boolean) {
	useSettingsStore.setState({
		encoreFeatures: { maestroCue: enabled } as unknown as EncoreFeatureFlags,
	});
}

function renderExport(session: Session) {
	return render(
		<LayerStackProvider>
			<AgentExportModal theme={theme} session={session} onClose={vi.fn()} />
		</LayerStackProvider>
	);
}

async function clickExport() {
	fireEvent.click(screen.getByRole('button', { name: /^Export…$/ }));
	await waitFor(() => expect(api().export).toHaveBeenCalled());
	return api().export.mock.calls[0][0];
}

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	setCue(true);
	vi.mocked(window.maestro.dialog.saveFile).mockResolvedValue('/tmp/reviewer.zip');
	api().export.mockResolvedValue({ ok: false, code: 'EXPORT_FAILED', message: 'stop here' });
});

describe('AgentExportModal', () => {
	it('exports a Claude Code agent with its Cue subscriptions and every Claude asset', async () => {
		renderExport(claudeAgent);
		expect(screen.getByRole('checkbox', { name: /Cue subscriptions/ })).toBeChecked();
		expect(screen.getByRole('checkbox', { name: /Exact copy/ })).not.toBeChecked();

		expect(await clickExport()).toEqual({
			agentId: 'a1',
			outputPath: '/tmp/reviewer.zip',
			includeCue: true,
			includeLocal: false,
			claudeAssets: { skills: true, mcp: true, memory: true },
		});
		expect(window.maestro.dialog.saveFile).toHaveBeenCalledWith(
			expect.objectContaining({ defaultPath: 'reviewer.maestro-bundle.zip' })
		);
	});

	it('hides the Cue option and leaves subscriptions out while Cue is off', async () => {
		setCue(false);
		renderExport(claudeAgent);
		expect(screen.queryByRole('checkbox', { name: /Cue subscriptions/ })).toBeNull();
		expect(await clickExport()).toMatchObject({ includeCue: false });
	});

	it('offers no Claude assets for another provider', async () => {
		renderExport(codexAgent);
		expect(screen.queryByRole('checkbox', { name: /Skills/ })).toBeNull();
		expect(await clickExport()).not.toHaveProperty('claudeAssets');
	});

	it('warns about an exact copy, sends it, and remembers the choice', async () => {
		const { unmount } = renderExport(claudeAgent);
		fireEvent.click(screen.getByRole('checkbox', { name: /Exact copy/ }));
		expect(screen.getByText(/will hold secret values and local paths/)).toBeInTheDocument();
		expect(await clickExport()).toMatchObject({ includeLocal: true });

		unmount();
		renderExport(claudeAgent);
		expect(screen.getByRole('checkbox', { name: /Exact copy/ })).toBeChecked();
	});

	it('shows a refusal', async () => {
		renderExport(claudeAgent);
		await clickExport();
		expect(await screen.findByText('Export failed')).toBeInTheDocument();
		expect(screen.getByText('stop here')).toBeInTheDocument();
	});
});

const manifest = {
	bundleVersion: 1,
	kind: 'maestro-agent',
	producer: { app: 'maestro', version: '0.18.6' },
	minEngineVersion: '0.18.0',
	name: 'Reviewer',
	workspaces: [{ key: 'web', name: 'web' }],
	agents: [
		{ id: 'a1', name: 'Reviewer', toolType: 'claude-code', workspace: 'web', settings: 's' },
	],
	requirements: { events: [], tools: [], secrets: [] },
	files: [],
};

const plan = {
	bundle: { name: 'Reviewer', kind: 'maestro-agent', producerVersion: '0.18.6' },
	dataDir: '/app',
	createDataDir: false,
	agents: [
		{
			id: 'a1',
			name: 'Reviewer',
			toolType: 'claude-code',
			workspace: 'web',
			cwd: '/srv/web',
			action: 'create',
		},
	],
	files: [],
	cueConfigs: [],
	agentPaths: [],
	shellCommands: [],
	env: [],
	secrets: [],
	conflicts: [],
	warnings: [],
	local: {
		applied: true,
		workspaces: {},
		agents: [
			{
				agentId: 'a1',
				agentName: 'Reviewer',
				fields: ['customPath'],
				binaries: ['/usr/local/bin/claude'],
			},
		],
	},
};

function renderImport(groupId?: string) {
	return render(
		<LayerStackProvider>
			<AgentImportModal theme={theme} groupId={groupId} onClose={vi.fn()} />
		</LayerStackProvider>
	);
}

describe('AgentImportModal', () => {
	beforeEach(() => {
		useSessionStore.setState({
			groups: [{ id: 'g1', name: 'Maestro', emoji: '🎹', collapsed: false } as Group],
		});
		api().chooseFile.mockResolvedValue('/tmp/reviewer.zip');
		api().import.mockResolvedValue({ ok: true, applied: false, plan });
	});

	it('opens the file chooser at once and names the group in its header', async () => {
		api().inspect.mockResolvedValue({
			ok: true,
			bundlePath: '/tmp/reviewer.zip',
			manifest,
			valid: true,
			errors: [],
			warnings: [],
		});
		renderImport('g1');
		await waitFor(() => expect(api().chooseFile).toHaveBeenCalledTimes(1));
		expect(screen.getByTestId('modal-subtitle')).toHaveTextContent('Maestro');

		vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue('/srv/web');
		fireEvent.click(
			await screen.findByRole('button', { name: 'Choose the folder for workspace web' })
		);
		await waitFor(() =>
			expect(api().import).toHaveBeenCalledWith({
				bundlePath: '/tmp/reviewer.zip',
				workspaces: { web: '/srv/web' },
				groupId: 'g1',
				dryRun: true,
			})
		);
	});

	it('restores an exact copy into the folders it came from, and imports it portably when told to', async () => {
		api().inspect.mockResolvedValue({
			ok: true,
			bundlePath: '/tmp/reviewer.zip',
			manifest: { ...manifest, local: 'local.json' },
			valid: true,
			errors: [],
			warnings: [],
			localWorkspaces: { web: { path: '/Users/me/web', exists: true } },
		});
		renderImport('g1');

		await waitFor(() =>
			expect(api().import).toHaveBeenCalledWith({
				bundlePath: '/tmp/reviewer.zip',
				workspaces: { web: '/Users/me/web' },
				groupId: 'g1',
				useLocal: true,
				dryRun: true,
			})
		);
		expect(await screen.findByText('Runs these binaries')).toBeInTheDocument();
		expect(screen.getByText('Reviewer: /usr/local/bin/claude')).toBeInTheDocument();

		// Declined: the folder is no longer suggested, so the dry run waits for one.
		api().import.mockClear();
		fireEvent.click(screen.getByRole('checkbox', { name: /Restore machine settings/ }));
		expect(await screen.findByText('not chosen')).toBeInTheDocument();
		expect(api().import).not.toHaveBeenCalled();
	});
});
