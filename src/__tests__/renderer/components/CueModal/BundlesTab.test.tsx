/**
 * The Cue modal's Bundles tab: export a pipeline or an agent, and import a
 * bundle through inspect, folder mapping, the dry run and the import.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BundlesTab } from '../../../../renderer/components/CueModal/BundlesTab';
import { THEMES } from '../../../../renderer/constants/themes';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import type { Session } from '../../../../renderer/types';

const theme = THEMES['dracula'];
const api = () => window.maestro.cueBundle as unknown as Record<string, ReturnType<typeof vi.fn>>;

const manifest = {
	bundleVersion: 1,
	kind: 'maestro-pipeline',
	producer: { app: 'maestro', version: '0.18.6' },
	minEngineVersion: '0.18.0',
	name: 'Nightly',
	workspaces: [
		{
			key: 'web',
			name: 'web',
			source: { gitRemote: 'https://github.com/acme/web.git' },
			claude: { skills: ['triage'], mcpServers: ['github'], autoMemory: ['MEMORY.md'] },
		},
	],
	agents: [
		{ id: 'a1', name: 'Reviewer', toolType: 'claude-code', workspace: 'web', settings: 's' },
	],
	requirements: { events: ['time.heartbeat'], tools: ['git'], secrets: ['GITHUB_TOKEN'] },
	files: [{ path: 'README.md', sha256: 'x', size: 1 }],
};

function plan(overrides: Record<string, unknown> = {}) {
	return {
		bundle: { name: 'Nightly', kind: 'maestro-pipeline', producerVersion: '0.18.6' },
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
		files: [{ kind: 'workspace', source: 's', target: 't', action: 'create' }],
		cueConfigs: [
			{
				workspace: 'web',
				path: 'p',
				created: true,
				added: ['nightly'],
				replaced: [],
				unchanged: [],
				settingsKept: [],
			},
		],
		agentPaths: [],
		shellCommands: [],
		env: [],
		secrets: [{ name: 'GITHUB_TOKEN', set: false, usedBy: ['mcp:web'] }],
		conflicts: [],
		warnings: [],
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	useSessionStore.setState({
		sessions: [
			{ id: 'a1', name: 'Reviewer', toolType: 'claude-code' },
			{ id: 't1', name: 'Shell', toolType: 'terminal' },
		] as unknown as Session[],
	});
});

function renderTab(onImported = vi.fn()) {
	render(
		<BundlesTab theme={theme} pipelines={[{ id: 'p1', name: 'Nightly' }]} onImported={onImported} />
	);
	return { onImported };
}

describe('export', () => {
	it('exports the chosen pipeline with every Claude asset by default', async () => {
		vi.mocked(window.maestro.dialog.saveFile).mockResolvedValue('/tmp/nightly.zip');
		api().export.mockResolvedValue({
			ok: true,
			outputPath: '/tmp/nightly.zip',
			size: 2048,
			sha256: 'abc',
			manifest,
		});
		renderTab();

		fireEvent.click(screen.getByRole('button', { name: /Export…/ }));

		await waitFor(() => expect(api().export).toHaveBeenCalled());
		expect(window.maestro.dialog.saveFile).toHaveBeenCalledWith(
			expect.objectContaining({ defaultPath: 'nightly.maestro-bundle.zip' })
		);
		expect(api().export).toHaveBeenCalledWith({
			pipeline: 'Nightly',
			outputPath: '/tmp/nightly.zip',
			claudeAssets: { skills: true, mcp: true, memory: true },
		});
		expect(await screen.findByText('Exported Nightly')).toBeInTheDocument();
		expect(screen.getByText('GITHUB_TOKEN')).toBeInTheDocument();
	});

	it('exports an agent without the assets switched off, and lists no terminals', async () => {
		vi.mocked(window.maestro.dialog.saveFile).mockResolvedValue('/tmp/reviewer.zip');
		renderTab();

		fireEvent.click(screen.getByRole('radio', { name: 'Agent' }));
		const select = screen.getByRole('combobox', { name: 'Agent to export' });
		expect([...(select as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
			'Reviewer',
		]);
		fireEvent.click(screen.getByRole('checkbox', { name: /Memory/ }));
		fireEvent.click(screen.getByRole('button', { name: /Export…/ }));

		await waitFor(() =>
			expect(api().export).toHaveBeenCalledWith({
				agentId: 'a1',
				outputPath: '/tmp/reviewer.zip',
				claudeAssets: { skills: true, mcp: true, memory: false },
			})
		);
	});

	it('shows why an export was refused', async () => {
		vi.mocked(window.maestro.dialog.saveFile).mockResolvedValue('/tmp/x.zip');
		api().export.mockResolvedValue({
			ok: false,
			code: 'EXPORT_FAILED',
			message: 'Subscription "hook" has a literal webhook.secret.',
		});
		renderTab();
		fireEvent.click(screen.getByRole('button', { name: /Export…/ }));
		expect(await screen.findByText('Export failed')).toBeInTheDocument();
		expect(screen.getByText(/literal webhook.secret/)).toBeInTheDocument();
	});

	it('shows every problem of a config refusal on its own line', async () => {
		vi.mocked(window.maestro.dialog.saveFile).mockResolvedValue('/tmp/x.zip');
		const message = [
			'Refusing to export: the Cue config would fail bundle validation with 2 errors. Fix it and export again.',
			'  [cue-config-invalid] workspace "web": Subscription "gather": "source_sub" is required',
			'  [name-has-colon] workspace "web": Subscription "a:b" contains ":"',
		].join('\n');
		api().export.mockResolvedValue({
			ok: false,
			code: 'BUNDLE_INVALID',
			message,
			details: { errors: [] },
		});
		renderTab();
		fireEvent.click(screen.getByRole('button', { name: /Export…/ }));
		expect(await screen.findByText('Export failed')).toBeInTheDocument();
		const body = screen.getByText(/Refusing to export/);
		expect(body.textContent).toBe(message);
		expect(body).toHaveClass('whitespace-pre-line');
	});

	it('does nothing when the save dialog is cancelled', async () => {
		vi.mocked(window.maestro.dialog.saveFile).mockResolvedValue(null);
		renderTab();
		fireEvent.click(screen.getByRole('button', { name: /Export…/ }));
		await waitFor(() => expect(window.maestro.dialog.saveFile).toHaveBeenCalled());
		expect(api().export).not.toHaveBeenCalled();
	});
});

describe('import', () => {
	async function chooseBundle() {
		api().chooseFile.mockResolvedValue('/tmp/nightly.zip');
		api().inspect.mockResolvedValue({
			ok: true,
			bundlePath: '/tmp/nightly.zip',
			manifest,
			valid: true,
			errors: [],
			warnings: [],
		});
		fireEvent.click(screen.getByRole('button', { name: /Choose Bundle/ }));
		await screen.findByText('Reviewer (claude-code)');
	}

	async function mapWorkspace() {
		vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue('/srv/web');
		fireEvent.click(screen.getByRole('button', { name: 'Choose the folder for workspace web' }));
		await screen.findByText('/srv/web');
	}

	it('shows the bundle, dry-runs once mapped, then imports into the app', async () => {
		api()
			.import.mockResolvedValueOnce({ ok: true, applied: false, plan: plan() })
			.mockResolvedValueOnce({ ok: true, applied: true, plan: plan() });
		const { onImported } = renderTab();

		await chooseBundle();
		expect(screen.getByText('web: 1 skill, 1 MCP server, 1 memory file')).toBeInTheDocument();
		expect(screen.getByText('clone https://github.com/acme/web.git')).toBeInTheDocument();

		await mapWorkspace();
		await screen.findByText(/in/, { selector: 'li' });
		expect(api().import).toHaveBeenCalledWith({
			bundlePath: '/tmp/nightly.zip',
			workspaces: { web: '/srv/web' },
			dryRun: true,
		});
		expect(screen.getByText('Set these before the agents run')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Import' }));
		expect(await screen.findByText('Imported Nightly')).toBeInTheDocument();
		expect(api().import).toHaveBeenLastCalledWith({
			bundlePath: '/tmp/nightly.zip',
			workspaces: { web: '/srv/web' },
			force: false,
			dryRun: false,
		});
		expect(onImported).toHaveBeenCalled();
	});

	it('holds the import until conflicts are accepted', async () => {
		api()
			.import.mockResolvedValueOnce({
				ok: true,
				applied: false,
				plan: plan({
					conflicts: [
						{ kind: 'agent', target: 'a1', message: 'Agent a1 ("Reviewer") already exists' },
					],
				}),
			})
			.mockResolvedValueOnce({ ok: true, applied: true, plan: plan() });
		renderTab();
		await chooseBundle();
		await mapWorkspace();

		expect(await screen.findByText('Agent a1 ("Reviewer") already exists')).toBeInTheDocument();
		const button = screen.getByRole('button', { name: 'Import' });
		expect(button).toBeDisabled();

		fireEvent.click(screen.getByRole('checkbox', { name: /Overwrite them/ }));
		expect(button).toBeEnabled();
		fireEvent.click(button);
		await waitFor(() =>
			expect(api().import).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }))
		);
	});

	it('asks again for overwrite approval when a folder change brings a new plan', async () => {
		const conflicted = plan({
			conflicts: [{ kind: 'file', target: '/a/.mcp.json', message: 'differs in A' }],
		});
		api()
			.import.mockResolvedValueOnce({ ok: true, applied: false, plan: conflicted })
			.mockResolvedValueOnce({
				ok: true,
				applied: false,
				plan: plan({
					conflicts: [{ kind: 'file', target: '/b/.mcp.json', message: 'differs in B' }],
				}),
			});
		renderTab();
		await chooseBundle();
		await mapWorkspace();
		await screen.findByText('differs in A');
		fireEvent.click(screen.getByRole('checkbox', { name: /Overwrite them/ }));
		expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();

		vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue('/srv/other');
		fireEvent.click(screen.getByRole('button', { name: 'Choose the folder for workspace web' }));
		await screen.findByText('differs in B');
		expect(screen.getByRole('checkbox', { name: /Overwrite them/ })).not.toBeChecked();
		expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
	});

	it('lists what makes a bundle unusable and asks for no folders', async () => {
		api().chooseFile.mockResolvedValue('/tmp/old.zip');
		api().inspect.mockResolvedValue({
			ok: true,
			bundlePath: '/tmp/old.zip',
			manifest,
			valid: false,
			errors: [{ code: 'engine-too-old', message: 'Needs Cue engine 9.0.0 or newer' }],
			warnings: [],
		});
		renderTab();
		fireEvent.click(screen.getByRole('button', { name: /Choose Bundle/ }));

		expect(await screen.findByText('This bundle cannot be imported')).toBeInTheDocument();
		expect(screen.getByText('Needs Cue engine 9.0.0 or newer')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Choose the folder/ })).toBeNull();
	});

	it('shows a refusal from the app', async () => {
		api()
			.import.mockResolvedValueOnce({ ok: true, applied: false, plan: plan() })
			.mockResolvedValueOnce({
				ok: false,
				code: 'WRITE_FAILED',
				message: 'Import failed and was rolled back: disk full',
			});
		renderTab();
		await chooseBundle();
		await mapWorkspace();
		await screen.findByRole('button', { name: 'Import' });
		fireEvent.click(screen.getByRole('button', { name: 'Import' }));
		expect(await screen.findByText('Import refused')).toBeInTheDocument();
		expect(screen.getByText(/rolled back: disk full/)).toBeInTheDocument();
	});
});
