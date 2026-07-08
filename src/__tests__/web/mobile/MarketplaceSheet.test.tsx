import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MarketplaceSheet } from '../../../web/mobile/MarketplaceSheet';
import type { MarketplaceManifest } from '../../../shared/marketplace-types';

const mockColors = {
	bgMain: '#0b0b0d',
	bgSidebar: '#111113',
	bgActivity: '#1c1c1f',
	border: '#27272a',
	textMain: '#e4e4e7',
	textDim: '#a1a1aa',
	accent: '#6366f1',
	accentDim: 'rgba(99, 102, 241, 0.2)',
	accentText: '#a5b4fc',
	success: '#22c55e',
	warning: '#eab308',
	error: '#ef4444',
};

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
}));

vi.mock('../../../web/mobile/constants', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../web/mobile/constants')>();
	return {
		...actual,
		triggerHaptic: vi.fn(),
		HAPTIC_PATTERNS: { tap: [10], success: [10, 30, 60], error: [60, 30, 10] },
	};
});

vi.mock('../../../web/mobile/MobileMarkdownRenderer', () => ({
	MobileMarkdownRenderer: ({ content }: { content: string }) => (
		<div data-testid="markdown-preview">{content}</div>
	),
}));

const manifest: MarketplaceManifest = {
	lastUpdated: '2026-06-18',
	playbooks: [
		{
			id: 'security-review',
			title: 'Security Review',
			description: 'Review code for risky behavior',
			category: 'Quality',
			author: 'Maestro',
			tags: ['security', 'review'],
			lastUpdated: '2026-06-18',
			path: 'quality/security-review',
			documents: [{ filename: 'checklist', resetOnCompletion: true }],
			loopEnabled: false,
			prompt: null,
		},
		{
			id: 'docs-sweep',
			title: 'Docs Sweep',
			description: 'Refresh documentation',
			category: 'Docs',
			author: 'Maestro',
			tags: ['docs'],
			lastUpdated: '2026-06-17',
			path: 'docs/sweep',
			documents: [],
			loopEnabled: true,
			maxLoops: 2,
			prompt: 'Update docs',
		},
	],
};

function renderMarketplace(overrides: Partial<Parameters<typeof MarketplaceSheet>[0]> = {}) {
	const sendRequest = vi.fn(async (type: string) => {
		if (type === 'marketplace_get_manifest') return { success: true, manifest };
		if (type === 'marketplace_get_readme') return { success: true, content: '# Security Review' };
		if (type === 'marketplace_get_document') return { success: true, content: '# Checklist' };
		if (type === 'marketplace_import_playbook') return { success: true };
		return { success: true };
	});
	const props = {
		sessionId: 'session-1',
		sendRequest,
		onImported: vi.fn(),
		onClose: vi.fn(),
		...overrides,
	};

	render(<MarketplaceSheet {...props} />);

	return props;
}

describe('MarketplaceSheet', () => {
	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('loads, filters, previews, and imports a marketplace playbook', async () => {
		const { sendRequest, onImported, onClose } = renderMarketplace();

		expect(await screen.findByText('Security Review')).toBeInTheDocument();
		expect(sendRequest).toHaveBeenCalledWith('marketplace_get_manifest');

		fireEvent.change(screen.getByPlaceholderText('Search playbooks...'), {
			target: { value: 'security' },
		});
		expect(screen.getByText('Security Review')).toBeInTheDocument();
		expect(screen.queryByText('Docs Sweep')).not.toBeInTheDocument();

		fireEvent.click(screen.getByText('Security Review'));
		expect(await screen.findByTestId('markdown-preview')).toHaveTextContent('# Security Review');
		expect(sendRequest).toHaveBeenCalledWith('marketplace_get_readme', {
			playbookPath: 'quality/security-review',
		});

		fireEvent.click(screen.getByRole('button', { name: /checklist/ }));
		await waitFor(() =>
			expect(sendRequest).toHaveBeenCalledWith('marketplace_get_document', {
				playbookPath: 'quality/security-review',
				filename: 'checklist',
			})
		);
		expect(await screen.findByTestId('markdown-preview')).toHaveTextContent('# Checklist');

		const folderInput = screen.getByPlaceholderText('folder-name');
		expect(folderInput).toHaveValue('security-review');
		fireEvent.change(folderInput, { target: { value: 'custom-folder' } });
		fireEvent.click(screen.getByRole('button', { name: 'Import Playbook' }));

		await waitFor(() =>
			expect(sendRequest).toHaveBeenCalledWith(
				'marketplace_import_playbook',
				{
					sessionId: 'session-1',
					playbookId: 'security-review',
					targetFolderName: 'custom-folder',
				},
				30000
			)
		);
		expect(onImported).toHaveBeenCalledWith('custom-folder');
		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
	});

	it('shows manifest and import failures', async () => {
		const sendRequest = vi.fn().mockResolvedValueOnce({
			success: false,
			error: 'Manifest unavailable',
		});
		renderMarketplace({ sendRequest: sendRequest as any });

		expect(await screen.findByText('Manifest unavailable')).toBeInTheDocument();

		const failingImport = vi.fn(async (type: string) => {
			if (type === 'marketplace_get_manifest') return { success: true, manifest };
			if (type === 'marketplace_get_readme') return { success: true, content: '# Readme' };
			if (type === 'marketplace_import_playbook')
				return { success: false, error: 'Already exists' };
			return { success: true };
		});
		renderMarketplace({ sendRequest: failingImport as any });

		fireEvent.click(await screen.findByText('Security Review'));
		fireEvent.click(await screen.findByRole('button', { name: 'Import Playbook' }));
		expect(await screen.findByText('Already exists')).toBeInTheDocument();
	});
});
