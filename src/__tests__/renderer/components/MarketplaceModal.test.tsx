import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MarketplaceManifest, MarketplacePlaybook } from '../../../shared/marketplace-types';
import { MarketplaceModal } from '../../../renderer/components/MarketplaceModal';
import { makeManifest, makePlaybook, mockTheme } from './MarketplaceModal/_fixtures';

const mocks = vi.hoisted(() => ({
	marketplaceState: null as any,
	useModalLayer: vi.fn(),
	escapeHandler: null as null | (() => void),
	notifyToast: vi.fn(),
	loggerError: vi.fn(),
}));

vi.mock('../../../renderer/hooks/batch/useMarketplace', () => ({
	useMarketplace: () => mocks.marketplaceState,
}));

vi.mock('../../../renderer/hooks/ui/useModalLayer', () => ({
	useModalLayer: (...args: any[]) => {
		mocks.escapeHandler = args[2];
		mocks.useModalLayer(...args);
	},
}));

vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: (...args: unknown[]) => mocks.notifyToast(...args),
}));

vi.mock('../../../renderer/utils/logger', () => ({
	logger: {
		error: (...args: unknown[]) => mocks.loggerError(...args),
	},
}));

vi.mock('../../../renderer/utils/markdownConfig', () => ({
	REMARK_GFM_PLUGINS: [],
	generateProseStyles: () => '.marketplace-preview{}',
	createMarkdownComponents: () => ({}),
}));

vi.mock('react-markdown', () => ({
	default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

function createMarketplaceState(overrides: Partial<typeof mocks.marketplaceState> = {}) {
	const compatible = makePlaybook({ id: 'alpha', title: 'Alpha Playbook' });
	const incompatible = makePlaybook({
		id: 'future',
		title: 'Future Playbook',
		minMaestroVersion: '99.0.0',
	});
	const manifest: MarketplaceManifest = makeManifest([compatible, incompatible]);

	return {
		manifest,
		playbooks: manifest.playbooks,
		categories: ['All', 'Development'],
		isLoading: false,
		isRefreshing: false,
		isImporting: false,
		fromCache: true,
		cacheAge: 60_000,
		error: null,
		selectedCategory: 'All',
		searchQuery: '',
		filteredPlaybooks: manifest.playbooks,
		setSelectedCategory: vi.fn(),
		setSearchQuery: vi.fn(),
		refresh: vi.fn().mockResolvedValue(undefined),
		importPlaybook: vi.fn().mockResolvedValue({ success: true }),
		fetchReadme: vi.fn().mockResolvedValue('# README'),
		fetchDocument: vi.fn().mockResolvedValue('# Phase'),
		...overrides,
	};
}

function renderMarketplace(
	props: Partial<React.ComponentProps<typeof MarketplaceModal>> = {},
	stateOverrides: Partial<typeof mocks.marketplaceState> = {}
) {
	mocks.marketplaceState = createMarketplaceState(stateOverrides);
	const onClose = vi.fn();
	const onImportComplete = vi.fn();
	const renderResult = render(
		<MarketplaceModal
			theme={mockTheme}
			isOpen={true}
			onClose={onClose}
			autoRunFolderPath="/autorun"
			sessionId="session-1"
			onImportComplete={onImportComplete}
			{...props}
		/>
	);

	return {
		...renderResult,
		onClose,
		onImportComplete,
		state: mocks.marketplaceState,
	};
}

describe('MarketplaceModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.escapeHandler = null;
		vi.stubGlobal('__APP_VERSION__', '1.0.0');
		vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue('/picked/folder');
	});

	it('does not render content when closed but registers the disabled layer', () => {
		mocks.marketplaceState = createMarketplaceState();

		render(
			<MarketplaceModal
				theme={mockTheme}
				isOpen={false}
				onClose={vi.fn()}
				autoRunFolderPath="/autorun"
				sessionId="session-1"
				onImportComplete={vi.fn()}
			/>
		);

		expect(screen.queryByText('Playbook Exchange')).toBeNull();
		expect(mocks.useModalLayer).toHaveBeenCalledWith(
			expect.any(Number),
			'Playbook Exchange',
			expect.any(Function),
			{ enabled: false }
		);
	});

	it('renders list view, cache status, and layer registration when open', () => {
		renderMarketplace();

		expect(screen.getByText('Playbook Exchange')).toBeTruthy();
		expect(screen.getByText('Cached 1m ago')).toBeTruthy();
		expect(screen.getByText('Alpha Playbook')).toBeTruthy();
		expect(screen.getByText('Future Playbook')).toBeTruthy();
		expect(screen.getByText('Requires a newer Maestro')).toBeTruthy();
		expect(mocks.useModalLayer).toHaveBeenCalledWith(
			expect.any(Number),
			'Playbook Exchange',
			expect.any(Function),
			{ enabled: true }
		);
	});

	it('wires refresh, category, search, and close actions', () => {
		const { onClose, state } = renderMarketplace();

		fireEvent.click(screen.getByTitle('Refresh marketplace data'));
		expect(state.refresh).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole('button', { name: /Development\s*\(2\)/ }));
		expect(state.setSelectedCategory).toHaveBeenCalledWith('Development');

		fireEvent.change(screen.getByPlaceholderText('Search playbooks...'), {
			target: { value: 'alpha' },
		});
		expect(state.setSearchQuery).toHaveBeenCalledWith('alpha');

		fireEvent.click(screen.getByTitle('Close (Esc)'));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('renders loading, error, and empty states', () => {
		const { rerender } = renderMarketplace({}, { isLoading: true });
		expect(document.querySelectorAll('.animate-pulse')).toHaveLength(6);

		mocks.marketplaceState = createMarketplaceState({ isLoading: false, error: 'Network down' });
		rerender(
			<MarketplaceModal
				theme={mockTheme}
				isOpen={true}
				onClose={vi.fn()}
				autoRunFolderPath="/autorun"
				sessionId="session-1"
				onImportComplete={vi.fn()}
			/>
		);
		expect(screen.getByText('Failed to load marketplace')).toBeTruthy();
		expect(screen.getByText('Network down')).toBeTruthy();

		mocks.marketplaceState = createMarketplaceState({
			error: null,
			filteredPlaybooks: [],
			searchQuery: 'missing',
		});
		rerender(
			<MarketplaceModal
				theme={mockTheme}
				isOpen={true}
				onClose={vi.fn()}
				autoRunFolderPath="/autorun"
				sessionId="session-1"
				onImportComplete={vi.fn()}
			/>
		);
		expect(screen.getByText('No results found')).toBeTruthy();
	});

	it('opens and closes the help popover before closing the modal on Escape', async () => {
		const { onClose } = renderMarketplace();

		fireEvent.click(screen.getByTitle('About the Playbook Exchange'));
		expect(screen.getByText('Submit Your Playbook')).toBeTruthy();

		await act(async () => {
			mocks.escapeHandler?.();
		});
		expect(screen.queryByText('Submit Your Playbook')).toBeNull();
		expect(onClose).not.toHaveBeenCalled();

		await act(async () => {
			mocks.escapeHandler?.();
		});
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('opens detail view, loads README, selects documents, and returns to list on Escape', async () => {
		const { state } = renderMarketplace();

		fireEvent.click(screen.getByText('Alpha Playbook'));

		await waitFor(() => {
			expect(state.fetchReadme).toHaveBeenCalledWith('playbooks/test-playbook');
			expect(screen.getByDisplayValue('alpha-playbook')).toBeTruthy();
			expect(screen.getByTestId('markdown').textContent).toBe('# README');
		});

		fireEvent.click(screen.getByRole('button', { name: /1\.\s*phase-1\.md/ }));
		fireEvent.click(screen.getByRole('button', { name: /2\.\s*phase-2\.md/ }));

		await waitFor(() => {
			expect(state.fetchDocument).toHaveBeenCalledWith('playbooks/test-playbook', 'phase-2');
			expect(screen.getByTestId('markdown').textContent).toBe('# Phase');
		});

		await act(async () => {
			mocks.escapeHandler?.();
		});
		expect(screen.getByText('Alpha Playbook')).toBeTruthy();
		expect(screen.queryByDisplayValue('alpha-playbook')).toBeNull();
	});

	it('supports keyboard document cycling in detail view', async () => {
		const { state } = renderMarketplace();

		fireEvent.click(screen.getByText('Alpha Playbook'));
		await waitFor(() => expect(screen.getByDisplayValue('alpha-playbook')).toBeTruthy());

		window.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: ']',
				metaKey: true,
				shiftKey: true,
				bubbles: true,
				cancelable: true,
			})
		);

		await waitFor(() => {
			expect(state.fetchDocument).toHaveBeenCalledWith('playbooks/test-playbook', 'phase-1');
		});
	});

	it('imports successfully and closes the modal', async () => {
		const { state, onClose, onImportComplete } = renderMarketplace();

		fireEvent.click(screen.getByText('Alpha Playbook'));
		await waitFor(() => expect(screen.getByDisplayValue('alpha-playbook')).toBeTruthy());
		fireEvent.click(screen.getByText('Import Playbook'));

		await waitFor(() => {
			expect(state.importPlaybook).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'alpha' }),
				'alpha-playbook',
				'/autorun',
				'session-1',
				undefined
			);
			expect(onImportComplete).toHaveBeenCalledWith('alpha-playbook');
			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});

	it('shows a sticky toast when import fails', async () => {
		const importPlaybook = vi.fn().mockResolvedValue({ success: false, error: 'Bad folder' });
		renderMarketplace({}, { importPlaybook });

		fireEvent.click(screen.getByText('Alpha Playbook'));
		await waitFor(() => expect(screen.getByDisplayValue('alpha-playbook')).toBeTruthy());
		fireEvent.click(screen.getByText('Import Playbook'));

		await waitFor(() => {
			expect(mocks.notifyToast).toHaveBeenCalledWith({
				color: 'red',
				title: 'Import failed',
				message: 'Bad folder',
				dismissible: true,
			});
		});
	});

	it('browses local folders but disables browse for remote sessions and forwards sshRemoteId', async () => {
		const importPlaybook = vi.fn().mockResolvedValue({ success: true });
		renderMarketplace({ sshRemoteId: 'remote-1' }, { importPlaybook });

		fireEvent.click(screen.getByText('Alpha Playbook'));
		await waitFor(() => expect(screen.getByDisplayValue('alpha-playbook')).toBeTruthy());

		expect(screen.getByTitle('Browse is not available for remote sessions')).toBeDisabled();
		fireEvent.click(screen.getByText('Import Playbook'));

		await waitFor(() => {
			expect(importPlaybook).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'alpha' }),
				'alpha-playbook',
				'/autorun',
				'session-1',
				'remote-1'
			);
		});
	});
});
