import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MarketplaceModal } from '../../renderer/components/MarketplaceModal';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../renderer/types';
import { logger } from '../../renderer/utils/logger';
import type { MarketplaceManifest, MarketplacePlaybook } from '../../shared/marketplace-types';

const theme: Theme = {
	id: 'integration-dark',
	name: 'Integration Dark',
	mode: 'dark',
	colors: {
		bgMain: '#101114',
		bgSidebar: '#20242b',
		bgActivity: '#181b20',
		border: '#3f3f46',
		textMain: '#f4f4f5',
		textDim: '#a1a1aa',
		accent: '#4f8cff',
		accentDim: '#1d4ed8',
		accentText: '#4f8cff',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

const securityPlaybook: MarketplacePlaybook = {
	id: 'security-review',
	title: 'Security Review',
	description: 'Review code for security issues',
	category: 'Development',
	subcategory: 'Security',
	author: 'Maestro',
	authorLink: 'https://example.com/maestro',
	tags: ['security', 'review'],
	lastUpdated: '2026-05-01',
	path: 'development/security-review',
	documents: [
		{ filename: '01-scan', resetOnCompletion: true },
		{ filename: '02-fix', resetOnCompletion: false },
	],
	loopEnabled: true,
	maxLoops: 2,
	prompt: null,
	source: 'official',
};

const localPlaybook: MarketplacePlaybook = {
	...securityPlaybook,
	id: 'local-helper',
	title: 'Local Helper',
	description: 'Local workflow',
	category: 'Operations',
	subcategory: undefined,
	author: 'Local User',
	authorLink: undefined,
	tags: ['local'],
	path: '/local/helper',
	documents: [{ filename: 'runbook', resetOnCompletion: false }],
	loopEnabled: false,
	maxLoops: null,
	source: 'local',
};

const manifest: MarketplaceManifest = {
	lastUpdated: '2026-05-25',
	playbooks: [securityPlaybook, localPlaybook],
};

let manifestChangedHandler: (() => void | Promise<void>) | undefined;
let manifestCleanup: ReturnType<typeof vi.fn>;
const originalMaestro = window.maestro;
const originalScrollIntoView = Element.prototype.scrollIntoView;

function marketplaceApi() {
	return window.maestro.marketplace as unknown as Record<string, ReturnType<typeof vi.fn>>;
}

function createProps(
	overrides: Partial<ComponentProps<typeof MarketplaceModal>> = {}
): ComponentProps<typeof MarketplaceModal> {
	return {
		autoRunFolderPath: '/autorun',
		isOpen: true,
		onClose: vi.fn(),
		onImportComplete: vi.fn(),
		sessionId: 'session-1',
		theme,
		...overrides,
	};
}

function renderMarketplace(overrides: Partial<ComponentProps<typeof MarketplaceModal>> = {}) {
	return render(
		<LayerStackProvider>
			<MarketplaceModal {...createProps(overrides)} />
		</LayerStackProvider>
	);
}

async function renderLoaded(overrides: Partial<ComponentProps<typeof MarketplaceModal>> = {}) {
	const result = renderMarketplace(overrides);
	expect(await screen.findByText('Security Review')).toBeInTheDocument();
	return result;
}

describe('MarketplaceModal integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		manifestChangedHandler = undefined;
		manifestCleanup = vi.fn();

		window.maestro = {
			...originalMaestro,
			dialog: {
				...originalMaestro.dialog,
				selectFolder: vi.fn().mockResolvedValue('/chosen/folder'),
			},
			marketplace: {
				...originalMaestro.marketplace,
				getManifest: vi.fn().mockResolvedValue({
					success: true,
					manifest,
					fromCache: true,
					cacheAge: 2 * 60 * 60 * 1000,
				}),
				refreshManifest: vi.fn().mockResolvedValue({
					success: true,
					manifest: {
						...manifest,
						playbooks: [
							...manifest.playbooks,
							{
								...localPlaybook,
								id: 'refreshed-helper',
								title: 'Refreshed Helper',
							},
						],
					},
					fromCache: false,
					cacheAge: 0,
				}),
				getReadme: vi.fn().mockResolvedValue({
					success: true,
					content:
						'# Security Review\n[Docs](https://example.com/docs)\n[Email](mailto:team@example.com)\n[Local](/local-doc)',
				}),
				getDocument: vi.fn().mockResolvedValue({ success: true, content: '# Fix\nDocument body' }),
				importPlaybook: vi.fn().mockResolvedValue({
					success: true,
					importedDocs: ['01-scan', '02-fix'],
					playbook: {
						id: 'imported',
						name: 'Security Review',
						createdAt: 1,
						updatedAt: 1,
						documents: [],
						loopEnabled: true,
						maxLoops: 2,
						prompt: '',
					},
				}),
				onManifestChanged: vi.fn((handler: () => void | Promise<void>) => {
					manifestChangedHandler = handler;
					return manifestCleanup;
				}),
			},
			shell: {
				...originalMaestro.shell,
				openExternal: vi.fn().mockResolvedValue(undefined),
			},
		};

		Element.prototype.scrollIntoView = vi.fn();
	});

	afterEach(() => {
		cleanup();
		window.maestro = originalMaestro;
		Element.prototype.scrollIntoView = originalScrollIntoView;
		vi.restoreAllMocks();
	});

	it('returns null when closed', () => {
		marketplaceApi().getManifest.mockReturnValueOnce(new Promise(() => {}));

		renderMarketplace({ isOpen: false });

		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
	});

	it('loads marketplace data through the bridge, filters it, refreshes it, and cleans up listeners', async () => {
		const { unmount } = await renderLoaded();
		const api = marketplaceApi();

		expect(api.getManifest).toHaveBeenCalledOnce();
		expect(api.onManifestChanged).toHaveBeenCalledOnce();
		expect(screen.getByText('Cached 2h ago')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Development\s*\(1\)/ })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Operations\s*\(1\)/ })).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Operations\s*\(1\)/ }));
		expect(screen.queryByText('Security Review')).not.toBeInTheDocument();
		expect(screen.getByText('Local Helper')).toBeInTheDocument();

		fireEvent.change(screen.getByPlaceholderText('Search playbooks...'), {
			target: { value: 'missing' },
		});
		expect(screen.getByText('No results found')).toBeInTheDocument();

		fireEvent.change(screen.getByPlaceholderText('Search playbooks...'), {
			target: { value: '' },
		});
		fireEvent.click(screen.getByRole('button', { name: /All\s*\(2\)/ }));
		fireEvent.click(screen.getByRole('button', { name: 'Refresh marketplace' }));

		expect(await screen.findByText('Refreshed Helper')).toBeInTheDocument();
		expect(screen.getByText('Live')).toBeInTheDocument();
		expect(api.refreshManifest).toHaveBeenCalledOnce();

		api.getManifest.mockResolvedValueOnce({
			success: true,
			manifest: {
				...manifest,
				playbooks: [securityPlaybook],
			},
			fromCache: false,
		});
		const consoleLog = vi.spyOn(globalThis.console, 'log').mockImplementation(() => {});
		await act(async () => {
			await manifestChangedHandler?.();
		});
		consoleLog.mockRestore();
		await waitFor(() => {
			expect(screen.queryByText('Local Helper')).not.toBeInTheDocument();
		});

		api.getManifest.mockRejectedValueOnce(new Error('reload boom'));
		const secondConsoleLog = vi.spyOn(globalThis.console, 'log').mockImplementation(() => {});
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
		await act(async () => {
			await manifestChangedHandler?.();
		});
		secondConsoleLog.mockRestore();
		expect(loggerError).toHaveBeenCalledWith(
			'Failed to reload manifest after change:',
			undefined,
			expect.any(Error)
		);

		unmount();
		expect(manifestCleanup).toHaveBeenCalledOnce();
	});

	it('previews documents, opens safe external links, browses folders, and imports locally', async () => {
		const onClose = vi.fn();
		const onImportComplete = vi.fn();
		await renderLoaded({ onClose, onImportComplete });
		const api = marketplaceApi();

		fireEvent.click(screen.getByText('Security Review'));

		await waitFor(() => {
			expect(api.getReadme).toHaveBeenCalledWith('development/security-review');
		});
		expect(await screen.findByText('Import Playbook')).toBeInTheDocument();
		expect(screen.getByDisplayValue('security-review')).toBeInTheDocument();
		expect(screen.getAllByRole('heading', { name: 'Security Review' }).length).toBeGreaterThan(0);
		expect(screen.getByText(/Loop:/)).toHaveTextContent('Loop: Yes (max 2)');

		fireEvent.click(screen.getAllByRole('button', { name: /01-scan\.md/ })[0]);
		await waitFor(() => {
			expect(api.getDocument).toHaveBeenCalledWith('development/security-review', '01-scan');
		});
		expect(screen.getByText('Document body')).toBeInTheDocument();

		const preview = document.querySelector('.marketplace-preview') as HTMLElement;
		const scrollTo = vi.fn();
		const scrollBy = vi.fn();
		preview.scrollTo = scrollTo;
		preview.scrollBy = scrollBy;
		Object.defineProperty(preview, 'clientHeight', { configurable: true, value: 120 });
		Object.defineProperty(preview, 'scrollHeight', { configurable: true, value: 960 });

		fireEvent.keyDown(window, { key: 'ArrowDown', metaKey: true });
		expect(scrollTo).toHaveBeenCalledWith({ top: 960, behavior: 'smooth' });
		fireEvent.keyDown(window, { key: 'ArrowUp', metaKey: true });
		expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
		fireEvent.keyDown(window, { key: 'ArrowDown', altKey: true });
		expect(scrollBy).toHaveBeenCalledWith({ top: 108, behavior: 'smooth' });
		fireEvent.keyDown(window, { key: 'ArrowUp', altKey: true });
		expect(scrollBy).toHaveBeenCalledWith({ top: -108, behavior: 'smooth' });
		fireEvent.keyDown(screen.getByLabelText(/Import to folder/i), {
			key: 'ArrowDown',
			altKey: true,
		});
		expect(scrollBy).toHaveBeenCalledTimes(2);

		const dropdownTrigger = document.querySelector('.relative > button') as HTMLButtonElement;
		fireEvent.click(dropdownTrigger);
		fireEvent.click(screen.getAllByRole('button', { name: 'README.md' }).at(-1)!);
		expect(screen.getAllByRole('heading', { name: 'Security Review' }).length).toBeGreaterThan(0);

		fireEvent.click(dropdownTrigger);
		fireEvent.click(screen.getAllByRole('button', { name: '02-fix.md' }).at(-1)!);
		await waitFor(() => {
			expect(api.getDocument).toHaveBeenCalledWith('development/security-review', '02-fix');
		});

		fireEvent.click(dropdownTrigger);
		expect(document.querySelector('.absolute.top-full')).toBeInTheDocument();
		fireEvent.mouseDown(document.body);
		expect(document.querySelector('.absolute.top-full')).not.toBeInTheDocument();

		fireEvent.click(screen.getByText('Read more...'));
		expect(screen.getAllByRole('heading', { name: 'Security Review' }).length).toBeGreaterThan(0);

		fireEvent.click(screen.getByText('Docs'));
		fireEvent.click(screen.getByText('Email'));
		fireEvent.click(screen.getByText('Local'));
		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://example.com/docs');
		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('mailto:team@example.com');
		expect(window.maestro.shell.openExternal).not.toHaveBeenCalledWith('/local-doc');

		fireEvent.click(screen.getByRole('button', { name: /Maestro/i }));
		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://example.com/maestro');

		fireEvent.change(screen.getByLabelText(/Import to folder/i), {
			target: { value: 'custom/import-folder' },
		});
		expect(screen.getByDisplayValue('custom/import-folder')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Browse for folder'));
		expect(await screen.findByDisplayValue('/chosen/folder')).toBeInTheDocument();
		expect(window.maestro.dialog.selectFolder).toHaveBeenCalledOnce();

		fireEvent.click(screen.getByRole('button', { name: /Import Playbook/i }));
		await waitFor(() => {
			expect(api.importPlaybook).toHaveBeenCalledWith(
				'security-review',
				'/chosen/folder',
				'/autorun',
				'session-1',
				undefined
			);
		});
		expect(onImportComplete).toHaveBeenCalledWith('/chosen/folder');
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('uses layer-stack escape handling and keyboard shortcuts across list and detail views', async () => {
		const onClose = vi.fn();
		await renderLoaded({ onClose });
		const api = marketplaceApi();

		fireEvent.keyDown(window, { key: 'f', metaKey: true });
		const searchInput = screen.getByPlaceholderText('Search playbooks...');
		expect(document.activeElement).toBe(searchInput);
		fireEvent.change(searchInput, { target: { value: 'security' } });
		fireEvent.keyDown(searchInput, { key: 'ArrowRight' });
		fireEvent.change(searchInput, { target: { value: '' } });
		fireEvent.keyDown(searchInput, { key: 'ArrowRight' });
		fireEvent.keyDown(searchInput, { key: 'ArrowDown' });

		fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });
		fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });
		expect(screen.queryByText('Security Review')).not.toBeInTheDocument();
		expect(screen.getByText('Local Helper')).toBeInTheDocument();

		fireEvent.keyDown(window, { key: '[', metaKey: true, shiftKey: true });
		expect(await screen.findByText('Security Review')).toBeInTheDocument();

		fireEvent.keyDown(window, { key: 'ArrowRight' });
		fireEvent.keyDown(window, { key: 'ArrowLeft' });
		fireEvent.keyDown(window, { key: 'ArrowDown' });
		fireEvent.keyDown(window, { key: 'ArrowUp' });
		expect(Element.prototype.scrollIntoView).toHaveBeenCalled();

		fireEvent.keyDown(window, { key: 'Enter' });
		expect(await screen.findByText('Import Playbook')).toBeInTheDocument();

		fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });
		await waitFor(() => {
			expect(api.getDocument).toHaveBeenCalledWith('development/security-review', '01-scan');
		});

		fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });
		await waitFor(() => {
			expect(api.getDocument).toHaveBeenCalledWith('development/security-review', '02-fix');
		});

		fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });
		expect(screen.getByRole('button', { name: 'README.md' })).toBeInTheDocument();

		const documentCallCount = api.getDocument.mock.calls.length;
		fireEvent.keyDown(window, { key: '[', metaKey: true, shiftKey: true });
		await waitFor(() => {
			expect(api.getDocument.mock.calls.length).toBeGreaterThan(documentCallCount);
		});
		expect(api.getDocument).toHaveBeenLastCalledWith('development/security-review', '02-fix');

		fireEvent.keyDown(window, { key: 'Escape' });
		expect(screen.queryByText('Import Playbook')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Help' }));
		expect(screen.getByText('About the Playbook Exchange')).toBeInTheDocument();
		fireEvent.keyDown(window, { key: 'Escape' });
		expect(screen.queryByText('About the Playbook Exchange')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Help' }));
		expect(screen.getByText('About the Playbook Exchange')).toBeInTheDocument();
		fireEvent.click(screen.getByText('github.com/RunMaestro/Maestro-Playbooks'));
		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
			'https://github.com/RunMaestro/Maestro-Playbooks'
		);
		await waitFor(() => {
			expect(screen.queryByText('About the Playbook Exchange')).not.toBeInTheDocument();
		});

		fireEvent.click(screen.getByRole('button', { name: 'Help' }));
		expect(screen.getByText('About the Playbook Exchange')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		expect(screen.queryByText('About the Playbook Exchange')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Submit Playbook via GitHub/i }));
		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
			'https://github.com/RunMaestro/Maestro-Playbooks'
		);

		fireEvent.keyDown(window, { key: 'Escape' });
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('renders loading, error, empty, local, remote, null document, and import failure states', async () => {
		let resolveManifest: (value: unknown) => void = () => {};
		marketplaceApi().getManifest.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveManifest = resolve;
			})
		);
		const { unmount } = renderMarketplace();
		expect(document.querySelectorAll('.animate-pulse')).toHaveLength(6);
		resolveManifest({ success: true, manifest, fromCache: true, cacheAge: null });
		expect(await screen.findByText('Security Review')).toBeInTheDocument();
		expect(screen.getByText('Cached just now')).toBeInTheDocument();
		unmount();
		cleanup();

		marketplaceApi().getManifest.mockResolvedValueOnce({
			success: true,
			manifest,
			fromCache: true,
			cacheAge: 5 * 60 * 1000,
		});
		renderMarketplace();
		expect(await screen.findByText('Cached 5m ago')).toBeInTheDocument();
		cleanup();

		marketplaceApi().getManifest.mockResolvedValueOnce({
			success: true,
			manifest,
			fromCache: true,
			cacheAge: 30_000,
		});
		renderMarketplace();
		expect(await screen.findByText('Cached just now')).toBeInTheDocument();
		cleanup();

		marketplaceApi().getManifest.mockResolvedValueOnce({
			success: false,
			error: 'Network down',
		});
		renderMarketplace();
		expect(await screen.findByText('Failed to load marketplace')).toBeInTheDocument();
		expect(screen.getByText('Network down')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
		expect(await screen.findByText('Security Review')).toBeInTheDocument();
		cleanup();

		marketplaceApi().getManifest.mockResolvedValueOnce({
			success: true,
			manifest: { ...manifest, playbooks: [] },
			fromCache: false,
		});
		renderMarketplace();
		expect(await screen.findByText('No playbooks available')).toBeInTheDocument();
		fireEvent.keyDown(window, { key: 'ArrowRight' });
		cleanup();

		marketplaceApi().getReadme.mockResolvedValueOnce({ success: true, content: null });
		marketplaceApi().getDocument.mockResolvedValueOnce({ success: true, content: null });
		marketplaceApi().importPlaybook.mockResolvedValueOnce({
			success: false,
			error: 'Import failed',
		});
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
		await renderLoaded({ sshRemoteId: 'remote-1' });

		fireEvent.click(screen.getByText('Local Helper'));
		expect(await screen.findByText('Import Playbook')).toBeInTheDocument();
		expect(screen.getAllByText('Local').length).toBeGreaterThan(0);
		expect(screen.getByText(/Loop:/)).toHaveTextContent('Loop: No');
		expect(screen.getByText('No README available')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /runbook\.md/ }));
		expect(await screen.findByText('Document not found')).toBeInTheDocument();

		const browseButton = screen.getByTitle('Browse is not available for remote sessions');
		expect(browseButton).toBeDisabled();

		fireEvent.click(screen.getByRole('button', { name: /Import Playbook/i }));
		await waitFor(() => {
			expect(marketplaceApi().importPlaybook).toHaveBeenCalledWith(
				'local-helper',
				'local-helper',
				'/autorun',
				'session-1',
				'remote-1'
			);
		});
		expect(loggerError).toHaveBeenCalledWith('Import failed:', undefined, 'Import failed');
	});

	it('handles bridge rejection and unsuccessful response fallbacks', async () => {
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});

		marketplaceApi().getManifest.mockRejectedValueOnce(new Error('manifest boom'));
		renderMarketplace();
		expect(await screen.findByText('Failed to load marketplace')).toBeInTheDocument();
		expect(screen.getByText('Failed to load marketplace data')).toBeInTheDocument();
		expect(loggerError).toHaveBeenCalledWith(
			'Failed to load marketplace manifest:',
			undefined,
			expect.any(Error)
		);
		cleanup();

		await renderLoaded();
		marketplaceApi().refreshManifest.mockResolvedValueOnce({ success: false });
		fireEvent.click(screen.getByRole('button', { name: 'Refresh marketplace' }));
		expect(await screen.findByText('Failed to refresh marketplace data')).toBeInTheDocument();

		marketplaceApi().refreshManifest.mockRejectedValueOnce(new Error('refresh boom'));
		fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
		await waitFor(() => {
			expect(loggerError).toHaveBeenCalledWith(
				'Failed to refresh marketplace manifest:',
				undefined,
				expect.any(Error)
			);
		});
		cleanup();

		marketplaceApi().getReadme.mockResolvedValueOnce({ success: false });
		marketplaceApi().getDocument.mockResolvedValueOnce({ success: false });
		marketplaceApi().importPlaybook.mockRejectedValueOnce(new Error('import boom'));
		await renderLoaded();

		fireEvent.click(screen.getByText('Security Review'));
		expect(await screen.findByText('Import Playbook')).toBeInTheDocument();
		expect(screen.getByText('No README available')).toBeInTheDocument();

		fireEvent.click(screen.getAllByRole('button', { name: /01-scan\.md/ })[0]);
		expect(await screen.findByText('Document not found')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Import Playbook/i }));
		await waitFor(() => {
			expect(loggerError).toHaveBeenCalledWith(
				'Failed to import playbook:',
				undefined,
				expect.any(Error)
			);
		});
		expect(loggerError).toHaveBeenCalledWith('Import failed:', undefined, 'Import failed');

		cleanup();
		marketplaceApi().getReadme.mockRejectedValueOnce(new Error('readme boom'));
		marketplaceApi().getDocument.mockRejectedValueOnce(new Error('document boom'));
		await renderLoaded();

		fireEvent.click(screen.getByText('Security Review'));
		expect(await screen.findByText('No README available')).toBeInTheDocument();
		await waitFor(() => {
			expect(loggerError).toHaveBeenCalledWith(
				'Failed to fetch README:',
				undefined,
				expect.any(Error)
			);
		});

		fireEvent.click(screen.getAllByRole('button', { name: /01-scan\.md/ })[0]);
		expect(await screen.findByText('Document not found')).toBeInTheDocument();
		expect(loggerError).toHaveBeenCalledWith(
			'Failed to fetch document:',
			undefined,
			expect.any(Error)
		);
	});
});
