import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MarketplaceModal } from '../../../renderer/components/MarketplaceModal';
import type { Theme } from '../../../renderer/types';
import type { MarketplaceManifest, MarketplacePlaybook } from '../../../shared/marketplace-types';

const mocks = vi.hoisted(() => ({
	registerLayer: vi.fn(() => 'marketplace-layer'),
	unregisterLayer: vi.fn(),
	setSelectedCategory: vi.fn(),
	setSearchQuery: vi.fn(),
	refresh: vi.fn(),
	importPlaybook: vi.fn(),
	fetchReadme: vi.fn(),
	fetchDocument: vi.fn(),
	openExternal: vi.fn(),
	selectFolder: vi.fn(),
}));

type MarketplaceHookState = {
	manifest: MarketplaceManifest | null;
	categories: string[];
	isLoading: boolean;
	isRefreshing: boolean;
	isImporting: boolean;
	fromCache: boolean;
	cacheAge: number | null;
	error: string | null;
	selectedCategory: string;
	searchQuery: string;
	filteredPlaybooks: MarketplacePlaybook[];
};

let marketplaceState: MarketplaceHookState;
const originalMaestro = window.maestro;
const originalScrollIntoView = Element.prototype.scrollIntoView;

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mocks.registerLayer,
		unregisterLayer: mocks.unregisterLayer,
	}),
}));

vi.mock('../../../renderer/hooks/batch/useMarketplace', () => ({
	useMarketplace: () => ({
		...marketplaceState,
		setSelectedCategory: mocks.setSelectedCategory,
		setSearchQuery: mocks.setSearchQuery,
		refresh: mocks.refresh,
		importPlaybook: mocks.importPlaybook,
		fetchReadme: mocks.fetchReadme,
		fetchDocument: mocks.fetchDocument,
	}),
}));

vi.mock('../../../renderer/utils/markdownConfig', () => ({
	REMARK_GFM_PLUGINS: [],
	generateProseStyles: vi.fn(() => ''),
	createMarkdownComponents: vi.fn(
		({ onExternalLinkClick }: { onExternalLinkClick?: (href: string) => void } = {}) => ({
			a: ({ href, children }: { href?: string; children: React.ReactNode }) => (
				<a
					href={href}
					onClick={(event) => {
						event.preventDefault();
						if (href) {
							onExternalLinkClick?.(href);
						}
					}}
				>
					{children}
				</a>
			),
		})
	),
}));

vi.mock('../../../renderer/utils/shortcutFormatter', () => ({
	formatShortcutKeys: (keys: string[]) => keys.join('+'),
}));

vi.mock('react-markdown', () => ({
	default: ({
		children,
		components,
	}: {
		children: React.ReactNode;
		components?: Record<string, React.ComponentType<any>>;
	}) => {
		const markdown = String(children ?? '');
		const AnchorComponent = components?.a;
		const linkMatches = [...markdown.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)];

		return (
			<div data-testid="markdown-preview">
				{children}
				{AnchorComponent &&
					linkMatches.map((match, index) => (
						<AnchorComponent key={`${match[2]}-${index}`} href={match[2]}>
							{match[1]}
						</AnchorComponent>
					))}
			</div>
		);
	},
}));

vi.mock('lucide-react', () => {
	const Icon = ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="icon" className={className} style={style} />
	);
	return {
		LayoutGrid: Icon,
		RefreshCw: Icon,
		X: Icon,
		Search: Icon,
		Loader2: Icon,
		Package: Icon,
		ArrowLeft: Icon,
		ChevronDown: Icon,
		Download: Icon,
		ExternalLink: Icon,
		FolderOpen: Icon,
		HelpCircle: Icon,
		Github: Icon,
	};
});

const theme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#181818',
		bgActivity: '#222222',
		textMain: '#eeeeee',
		textDim: '#999999',
		accent: '#4f9cff',
		accentDim: 'rgba(79, 156, 255, 0.2)',
		accentText: '#ffffff',
		accentForeground: '#000000',
		border: '#333333',
		error: '#ff5555',
		warning: '#ffaa00',
		success: '#22c55e',
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
	id: 'local-playbook',
	title: 'Local Helper',
	description: 'Local workflow',
	category: 'Operations',
	subcategory: undefined,
	author: 'Local User',
	authorLink: undefined,
	tags: [],
	path: '/local/helper',
	documents: [{ filename: 'runbook', resetOnCompletion: false }],
	loopEnabled: false,
	maxLoops: null,
	source: 'local',
};

const unlimitedLocalPlaybook: MarketplacePlaybook = {
	...localPlaybook,
	id: 'unlimited-local',
	title: 'Unlimited Local',
	path: '/local/unlimited',
	loopEnabled: true,
	maxLoops: null,
};

function defaultState(overrides: Partial<MarketplaceHookState> = {}): MarketplaceHookState {
	const playbooks = [securityPlaybook, localPlaybook];
	return {
		manifest: { lastUpdated: '2026-05-01', playbooks },
		categories: ['All', 'Development', 'Operations'],
		isLoading: false,
		isRefreshing: false,
		isImporting: false,
		fromCache: true,
		cacheAge: 2 * 60 * 60 * 1000,
		error: null,
		selectedCategory: 'All',
		searchQuery: '',
		filteredPlaybooks: playbooks,
		...overrides,
	};
}

function marketplaceElement(props: Partial<React.ComponentProps<typeof MarketplaceModal>> = {}) {
	return (
		<MarketplaceModal
			theme={theme}
			isOpen
			onClose={vi.fn()}
			autoRunFolderPath="/autorun"
			sessionId="session-1"
			onImportComplete={vi.fn()}
			{...props}
		/>
	);
}

function renderMarketplace(props: Partial<React.ComponentProps<typeof MarketplaceModal>> = {}) {
	return render(marketplaceElement(props));
}

describe('MarketplaceModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		marketplaceState = defaultState();
		mocks.fetchReadme.mockResolvedValue('# Security Review\nRead me');
		mocks.fetchDocument.mockResolvedValue('# Fix\nDocument body');
		mocks.importPlaybook.mockResolvedValue({ success: true });
		mocks.selectFolder.mockResolvedValue('/chosen/folder');

		window.maestro = {
			...window.maestro,
			shell: { ...window.maestro?.shell, openExternal: mocks.openExternal },
			dialog: { ...window.maestro?.dialog, selectFolder: mocks.selectFolder },
		};

		Element.prototype.scrollIntoView = vi.fn();
	});

	afterEach(() => {
		cleanup();
		window.maestro = originalMaestro;
		Element.prototype.scrollIntoView = originalScrollIntoView;
		vi.restoreAllMocks();
	});

	it('returns null when closed and registers the modal layer when open', () => {
		const { rerender } = renderMarketplace({ isOpen: false });

		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		expect(mocks.registerLayer).not.toHaveBeenCalled();

		rerender(
			<MarketplaceModal
				theme={theme}
				isOpen
				onClose={vi.fn()}
				autoRunFolderPath="/autorun"
				sessionId="session-1"
				onImportComplete={vi.fn()}
			/>
		);

		expect(screen.getByRole('dialog', { name: 'Playbook Exchange' })).toBeInTheDocument();
		expect(mocks.registerLayer).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'modal',
				ariaLabel: 'Playbook Exchange',
				blocksLowerLayers: true,
			})
		);
	});

	it('shows list controls, filters, refresh, help, and external links', async () => {
		renderMarketplace();

		expect(screen.getByText('Cached 2h ago')).toBeInTheDocument();
		expect(screen.getAllByText('Development').length).toBeGreaterThan(0);
		expect(screen.getByText('Security Review')).toBeInTheDocument();
		expect(screen.getByText('Local Helper')).toBeInTheDocument();

		fireEvent.click(screen.getAllByRole('button', { name: /Development/i })[0]);
		expect(mocks.setSelectedCategory).toHaveBeenCalledWith('Development');

		fireEvent.change(screen.getByPlaceholderText('Search playbooks...'), {
			target: { value: 'security' },
		});
		expect(mocks.setSearchQuery).toHaveBeenCalledWith('security');

		fireEvent.click(screen.getByRole('button', { name: 'Refresh marketplace' }));
		expect(mocks.refresh).toHaveBeenCalledOnce();

		fireEvent.click(screen.getByRole('button', { name: 'Help' }));
		expect(screen.getByText('About the Playbook Exchange')).toBeInTheDocument();

		fireEvent.click(screen.getByText('github.com/RunMaestro/Maestro-Playbooks'));
		expect(mocks.openExternal).toHaveBeenCalledWith(
			'https://github.com/RunMaestro/Maestro-Playbooks'
		);

		await waitFor(() => {
			expect(screen.queryByText('About the Playbook Exchange')).not.toBeInTheDocument();
		});
	});

	it('closes help locally, opens the submit link, retries errors, and returns focus from search', () => {
		renderMarketplace();

		fireEvent.click(screen.getByRole('button', { name: 'Help' }));
		expect(screen.getByText('About the Playbook Exchange')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		expect(screen.queryByText('About the Playbook Exchange')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Submit Playbook via GitHub/i }));
		expect(mocks.openExternal).toHaveBeenCalledWith(
			'https://github.com/RunMaestro/Maestro-Playbooks'
		);

		const searchInput = screen.getByPlaceholderText('Search playbooks...');
		searchInput.focus();
		fireEvent.keyDown(searchInput, { key: 'Escape' });
		expect(document.activeElement).not.toBe(searchInput);

		cleanup();
		marketplaceState = defaultState({ error: 'Network down' });
		renderMarketplace();

		fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
		expect(mocks.refresh).toHaveBeenCalled();
	});

	it('renders cache age variants, live state, refresh state, and empty category counts', () => {
		const { rerender } = renderMarketplace();

		expect(screen.getByText('Cached 2h ago')).toBeInTheDocument();

		marketplaceState = defaultState({ cacheAge: null });
		rerender(marketplaceElement());
		expect(screen.getByText('Cached just now')).toBeInTheDocument();

		marketplaceState = defaultState({ cacheAge: 30_000 });
		rerender(marketplaceElement());
		expect(screen.getByText('Cached just now')).toBeInTheDocument();

		marketplaceState = defaultState({ cacheAge: 5 * 60 * 1000 });
		rerender(marketplaceElement());
		expect(screen.getByText('Cached 5m ago')).toBeInTheDocument();

		marketplaceState = defaultState({ fromCache: false, isRefreshing: true });
		rerender(marketplaceElement());
		const refreshButton = screen.getByRole('button', { name: 'Refresh marketplace' });
		expect(screen.getByText('Live')).toBeInTheDocument();
		expect(refreshButton).toHaveAttribute('aria-busy', 'true');
		expect(refreshButton.querySelector('.animate-spin')).toBeInTheDocument();

		marketplaceState = defaultState({
			manifest: null,
			categories: ['All', 'Development'],
		});
		rerender(marketplaceElement());
		expect(screen.getByRole('button', { name: /All\s*\(0\)/ })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Development\s*\(0\)/ })).toBeInTheDocument();
	});

	it('renders loading, error, and empty states', () => {
		const { rerender } = renderMarketplace();

		marketplaceState = defaultState({ isLoading: true });
		rerender(
			<MarketplaceModal
				theme={theme}
				isOpen
				onClose={vi.fn()}
				autoRunFolderPath="/autorun"
				sessionId="session-1"
				onImportComplete={vi.fn()}
			/>
		);
		expect(document.querySelectorAll('.animate-pulse')).toHaveLength(6);

		marketplaceState = defaultState({ isLoading: false, error: 'Network down' });
		rerender(
			<MarketplaceModal
				theme={theme}
				isOpen
				onClose={vi.fn()}
				autoRunFolderPath="/autorun"
				sessionId="session-1"
				onImportComplete={vi.fn()}
			/>
		);
		expect(screen.getByText('Failed to load marketplace')).toBeInTheDocument();
		expect(screen.getByText('Network down')).toBeInTheDocument();

		marketplaceState = defaultState({ error: null, filteredPlaybooks: [], searchQuery: 'missing' });
		rerender(
			<MarketplaceModal
				theme={theme}
				isOpen
				onClose={vi.fn()}
				autoRunFolderPath="/autorun"
				sessionId="session-1"
				onImportComplete={vi.fn()}
			/>
		);
		expect(screen.getByText('No results found')).toBeInTheDocument();

		marketplaceState = defaultState({ filteredPlaybooks: [], searchQuery: '' });
		rerender(
			<MarketplaceModal
				theme={theme}
				isOpen
				onClose={vi.fn()}
				autoRunFolderPath="/autorun"
				sessionId="session-1"
				onImportComplete={vi.fn()}
			/>
		);
		expect(screen.getByText('No playbooks available')).toBeInTheDocument();
	});

	it('opens detail view, loads documents, browses local folders, and imports', async () => {
		const onClose = vi.fn();
		const onImportComplete = vi.fn();
		mocks.fetchReadme.mockResolvedValueOnce(
			'# Security Review\n[Docs](https://example.com/docs)\n[Email](mailto:team@example.com)\n[Local](/local-doc)'
		);
		renderMarketplace({ onClose, onImportComplete });

		fireEvent.click(screen.getByText('Security Review'));

		await waitFor(() => {
			expect(mocks.fetchReadme).toHaveBeenCalledWith('development/security-review');
		});
		expect(await screen.findByText('Import Playbook')).toBeInTheDocument();
		expect(screen.getByDisplayValue('development/security-review')).toBeInTheDocument();
		expect(screen.getByTestId('markdown-preview')).toHaveTextContent('Security Review');

		fireEvent.click(screen.getAllByRole('button', { name: /01-scan\.md/ })[0]);
		await waitFor(() => {
			expect(mocks.fetchDocument).toHaveBeenCalledWith('development/security-review', '01-scan');
		});
		expect(screen.getByTestId('markdown-preview')).toHaveTextContent('Document body');

		fireEvent.click(screen.getByText('Read more...'));
		expect(screen.getByTestId('markdown-preview')).toHaveTextContent('Security Review');

		fireEvent.click(screen.getByText('Docs'));
		fireEvent.click(screen.getByText('Email'));
		fireEvent.click(screen.getByText('Local'));
		expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com/docs');
		expect(mocks.openExternal).toHaveBeenCalledWith('mailto:team@example.com');
		expect(mocks.openExternal).not.toHaveBeenCalledWith('/local-doc');

		fireEvent.click(screen.getByRole('button', { name: /Maestro/i }));
		expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com/maestro');

		fireEvent.change(screen.getByLabelText(/Import to folder/i), {
			target: { value: 'custom/import-folder' },
		});
		expect(screen.getByDisplayValue('custom/import-folder')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Browse for folder'));
		await waitFor(() => {
			expect(mocks.selectFolder).toHaveBeenCalledOnce();
		});
		expect(await screen.findByDisplayValue('/chosen/folder')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Import Playbook/i }));
		await waitFor(() => {
			expect(mocks.importPlaybook).toHaveBeenCalledWith(
				securityPlaybook,
				'/chosen/folder',
				'/autorun',
				'session-1',
				undefined
			);
		});
		expect(onImportComplete).toHaveBeenCalledWith('/chosen/folder');
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('routes Escape through help, detail, and list modal states', async () => {
		const onClose = vi.fn();
		renderMarketplace({ onClose });
		const escapeHandler = mocks.registerLayer.mock.calls[0][0].onEscape;

		fireEvent.click(screen.getByRole('button', { name: 'Help' }));
		expect(screen.getByText('About the Playbook Exchange')).toBeInTheDocument();
		act(() => {
			escapeHandler();
		});
		expect(screen.queryByText('About the Playbook Exchange')).not.toBeInTheDocument();

		fireEvent.click(screen.getByText('Security Review'));
		await screen.findByText('Import Playbook');
		act(() => {
			escapeHandler();
		});
		expect(screen.getByText('Playbook Exchange')).toBeInTheDocument();
		expect(screen.queryByText('Import Playbook')).not.toBeInTheDocument();

		act(() => {
			escapeHandler();
		});
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('handles document dropdown fallbacks and preview scroll shortcuts', async () => {
		mocks.fetchReadme.mockResolvedValueOnce(null);
		mocks.fetchDocument.mockResolvedValueOnce(null);
		renderMarketplace();

		fireEvent.click(screen.getByText('Security Review'));
		expect(await screen.findByText('Import Playbook')).toBeInTheDocument();
		expect(screen.getByTestId('markdown-preview')).toHaveTextContent('No README available');

		const preview = document.querySelector('.marketplace-preview') as HTMLElement;
		const scrollTo = vi.fn();
		const scrollBy = vi.fn();
		preview.scrollTo = scrollTo;
		preview.scrollBy = scrollBy;
		Object.defineProperty(preview, 'clientHeight', { configurable: true, value: 100 });
		Object.defineProperty(preview, 'scrollHeight', { configurable: true, value: 900 });

		fireEvent.keyDown(window, { key: 'ArrowDown', metaKey: true });
		expect(scrollTo).toHaveBeenCalledWith({ top: 900, behavior: 'smooth' });

		fireEvent.keyDown(window, { key: 'ArrowUp', metaKey: true });
		expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });

		fireEvent.keyDown(window, { key: 'ArrowLeft', metaKey: true });
		expect(scrollTo).toHaveBeenCalledTimes(2);

		fireEvent.keyDown(window, { key: 'ArrowDown', altKey: true });
		expect(scrollBy).toHaveBeenCalledWith({ top: 90, behavior: 'smooth' });

		fireEvent.keyDown(window, { key: 'ArrowUp', altKey: true });
		expect(scrollBy).toHaveBeenCalledWith({ top: -90, behavior: 'smooth' });

		fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true });
		expect(scrollBy).toHaveBeenCalledTimes(2);

		scrollBy.mockClear();
		fireEvent.keyDown(screen.getByLabelText(/Import to folder/i), {
			key: 'ArrowDown',
			altKey: true,
		});
		expect(scrollBy).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: 'README.md' }));
		fireEvent.click(screen.getAllByRole('button', { name: '01-scan.md' }).at(-1)!);
		await waitFor(() => {
			expect(mocks.fetchDocument).toHaveBeenCalledWith('development/security-review', '01-scan');
		});
		expect(screen.getByTestId('markdown-preview')).toHaveTextContent('Document not found');

		const dropdownTrigger = document.querySelector('.relative > button') as HTMLButtonElement;
		fireEvent.click(dropdownTrigger);
		expect(screen.getByRole('button', { name: 'README.md' })).toBeInTheDocument();
		fireEvent.mouseDown(screen.getByRole('button', { name: 'README.md' }));
		expect(screen.getByRole('button', { name: 'README.md' })).toBeInTheDocument();
		fireEvent.mouseDown(document.body);
		expect(screen.queryByRole('button', { name: 'README.md' })).not.toBeInTheDocument();

		fireEvent.click(dropdownTrigger);
		fireEvent.click(screen.getAllByRole('button', { name: 'README.md' }).at(-1)!);
		expect(screen.getByTestId('markdown-preview')).toHaveTextContent('No README available');
	});

	it('handles marketplace keyboard shortcuts for search, categories, and documents', async () => {
		const selectInput = vi.spyOn(HTMLInputElement.prototype, 'select').mockImplementation(() => {});
		marketplaceState = defaultState({ selectedCategory: 'Development' });
		renderMarketplace();

		fireEvent.keyDown(window, { key: 'f', metaKey: true });
		const searchInput = screen.getByPlaceholderText('Search playbooks...');
		expect(document.activeElement).toBe(searchInput);
		expect(selectInput).toHaveBeenCalled();

		fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });
		expect(mocks.setSelectedCategory).toHaveBeenCalledWith('Operations');

		fireEvent.keyDown(window, { key: 'p', metaKey: true, shiftKey: true });
		expect(mocks.setSelectedCategory).toHaveBeenCalledTimes(1);

		fireEvent.keyDown(window, { key: '[', metaKey: true, shiftKey: true });
		expect(mocks.setSelectedCategory).toHaveBeenCalledWith('All');

		fireEvent.click(screen.getByText('Security Review'));
		await screen.findByText('Import Playbook');

		fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });
		await waitFor(() => {
			expect(mocks.fetchDocument).toHaveBeenCalledWith('development/security-review', '01-scan');
		});

		fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });
		await waitFor(() => {
			expect(mocks.fetchDocument).toHaveBeenCalledWith('development/security-review', '02-fix');
		});

		fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });
		expect(screen.getByRole('button', { name: 'README.md' })).toBeInTheDocument();

		fireEvent.keyDown(window, { key: '[', metaKey: true, shiftKey: true });
		await waitFor(() => {
			expect(mocks.fetchDocument).toHaveBeenCalledWith('development/security-review', '02-fix');
		});

		fireEvent.keyDown(window, { key: '[', metaKey: true, shiftKey: true });
		await waitFor(() => {
			expect(mocks.fetchDocument).toHaveBeenCalledWith('development/security-review', '01-scan');
		});

		selectInput.mockRestore();
	});

	it('handles tile arrow navigation from empty lists and focused search inputs', () => {
		marketplaceState = defaultState({ filteredPlaybooks: [] });
		renderMarketplace();
		fireEvent.keyDown(window, { key: 'ArrowRight' });
		expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(0);

		cleanup();
		marketplaceState = defaultState({ searchQuery: 'security' });
		renderMarketplace();
		const searchWithText = screen.getByPlaceholderText('Search playbooks...');
		fireEvent.keyDown(searchWithText, { key: 'ArrowRight' });
		expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);

		cleanup();
		marketplaceState = defaultState();
		const blurInput = vi.spyOn(HTMLInputElement.prototype, 'blur');
		renderMarketplace();
		const emptySearch = screen.getByPlaceholderText('Search playbooks...');

		fireEvent.keyDown(emptySearch, { key: 'ArrowRight' });
		expect(blurInput).toHaveBeenCalled();

		fireEvent.keyDown(emptySearch, { key: 'ArrowDown' });
		fireEvent.keyDown(window, { key: 'ArrowDown' });
		fireEvent.keyDown(window, { key: 'ArrowLeft' });
		fireEvent.keyDown(window, { key: 'ArrowUp' });
		expect(Element.prototype.scrollIntoView).toHaveBeenCalled();

		blurInput.mockRestore();
	});

	it('renders local unlimited detail state, importing status, and null folder selections', async () => {
		mocks.selectFolder.mockResolvedValueOnce(null);
		marketplaceState = defaultState({
			manifest: { lastUpdated: '2026-05-01', playbooks: [unlimitedLocalPlaybook] },
			categories: ['All', 'Operations'],
			filteredPlaybooks: [unlimitedLocalPlaybook],
			isImporting: true,
		});

		renderMarketplace();

		fireEvent.click(screen.getByText('Unlimited Local'));
		await screen.findByText('Importing...');

		expect(screen.getAllByText('Local').length).toBeGreaterThan(0);
		expect(screen.getByText(/Loop:/)).toHaveTextContent('Loop: Yes (unlimited)');
		expect(screen.getByText('Local User')).toBeInTheDocument();
		expect(screen.getByTitle('Browse for folder')).toBeEnabled();

		fireEvent.click(screen.getByTitle('Browse for folder'));
		await waitFor(() => {
			expect(mocks.selectFolder).toHaveBeenCalledOnce();
		});
		expect(screen.getByDisplayValue('operations/unlimited-local')).toBeInTheDocument();
	});

	it('renders non-looping local detail metadata', async () => {
		marketplaceState = defaultState({
			manifest: { lastUpdated: '2026-05-01', playbooks: [localPlaybook] },
			categories: ['All', 'Operations'],
			filteredPlaybooks: [localPlaybook],
		});

		renderMarketplace();

		fireEvent.click(screen.getByText('Local Helper'));
		await screen.findByText('Import Playbook');

		expect(screen.getByText(/Loop:/)).toHaveTextContent('Loop: No');
	});

	it('ignores Enter when keyboard selection points past the filtered playbook list', () => {
		const { rerender } = renderMarketplace();

		fireEvent.keyDown(window, { key: 'ArrowRight' });

		marketplaceState = defaultState({ filteredPlaybooks: [securityPlaybook] });
		rerender(marketplaceElement());

		fireEvent.keyDown(window, { key: 'Enter' });

		expect(mocks.fetchReadme).not.toHaveBeenCalled();
		expect(screen.queryByText('Import Playbook')).not.toBeInTheDocument();
	});

	it('disables local browsing for remote sessions and logs import failures', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.importPlaybook.mockResolvedValue({ success: false, error: 'Import failed' });

		renderMarketplace({ sshRemoteId: 'remote-1' });

		fireEvent.keyDown(window, { key: 'Enter' });
		await screen.findByText('Import Playbook');

		const browseButton = screen.getByTitle('Browse is not available for remote sessions');
		expect(browseButton).toBeDisabled();
		fireEvent.click(browseButton);
		expect(mocks.selectFolder).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: /Import Playbook/i }));
		await waitFor(() => {
			expect(mocks.importPlaybook).toHaveBeenCalledWith(
				securityPlaybook,
				'development/security-review',
				'/autorun',
				'session-1',
				'remote-1'
			);
		});
		expect(consoleError).toHaveBeenCalledWith('Import failed:', 'Import failed');
		consoleError.mockRestore();
	});
});
