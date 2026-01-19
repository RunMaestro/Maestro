/**
 * @fileoverview Tests for useMarketplace hook
 *
 * Tests the marketplace hook including:
 * - Initial manifest loading on mount
 * - Category extraction from playbooks
 * - Search and filter functionality
 * - Refresh functionality (bypass cache)
 * - Import playbook functionality
 * - Document fetching (README, individual documents)
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useMarketplace, type UseMarketplaceReturn } from '../../../renderer/hooks';
import type { MarketplaceManifest, MarketplacePlaybook } from '../../../shared/marketplace-types';

// Sample test data
const createPlaybook = (overrides: Partial<MarketplacePlaybook> = {}): MarketplacePlaybook => ({
	id: 'test-playbook',
	title: 'Test Playbook',
	description: 'A test playbook for testing',
	category: 'Testing',
	author: 'Test Author',
	lastUpdated: '2025-01-01',
	path: 'playbooks/testing',
	documents: [{ filename: 'phase-1', resetOnCompletion: true }],
	loopEnabled: false,
	prompt: null,
	...overrides,
});

const createManifest = (playbooks: MarketplacePlaybook[] = []): MarketplaceManifest => ({
	lastUpdated: '2025-01-01',
	playbooks,
});

// Use the global window.maestro mock from setup.ts
beforeEach(() => {
	vi.clearAllMocks();
});

describe('useMarketplace', () => {
	describe('hook initialization and shape', () => {
		it('returns correct shape', async () => {
			const { result } = renderHook(() => useMarketplace());

			await waitFor(() => {
				expect(result.current.isLoading).toBe(false);
			});

			// Data properties
			expect(result.current).toHaveProperty('manifest');
			expect(result.current).toHaveProperty('playbooks');
			expect(result.current).toHaveProperty('categories');

			// Loading states
			expect(result.current).toHaveProperty('isLoading');
			expect(result.current).toHaveProperty('isRefreshing');
			expect(result.current).toHaveProperty('isImporting');

			// Cache info
			expect(result.current).toHaveProperty('fromCache');
			expect(result.current).toHaveProperty('cacheAge');

			// Error state
			expect(result.current).toHaveProperty('error');

			// Filter state
			expect(result.current).toHaveProperty('selectedCategory');
			expect(result.current).toHaveProperty('searchQuery');
			expect(result.current).toHaveProperty('filteredPlaybooks');

			// Actions
			expect(typeof result.current.setSelectedCategory).toBe('function');
			expect(typeof result.current.setSearchQuery).toBe('function');
			expect(typeof result.current.refresh).toBe('function');
			expect(typeof result.current.importPlaybook).toBe('function');

			// Document preview
			expect(typeof result.current.fetchReadme).toBe('function');
			expect(typeof result.current.fetchDocument).toBe('function');
		});

		it('starts with loading state true', () => {
			const { result } = renderHook(() => useMarketplace());
			expect(result.current.isLoading).toBe(true);
		});

		it('defaults selectedCategory to "All"', async () => {
			const { result } = renderHook(() => useMarketplace());

			await waitFor(() => {
				expect(result.current.isLoading).toBe(false);
			});

			expect(result.current.selectedCategory).toBe('All');
		});

		it('defaults searchQuery to empty string', async () => {
			const { result } = renderHook(() => useMarketplace());

			await waitFor(() => {
				expect(result.current.isLoading).toBe(false);
			});

			expect(result.current.searchQuery).toBe('');
		});
	});

	describe('initial manifest loading', () => {
		it('loads manifest on mount', async () => {
			const testManifest = createManifest([createPlaybook()]);
			vi.mocked(window.maestro.marketplace.getManifest).mockResolvedValue({
				success: true,
				manifest: testManifest,
				fromCache: false,
			});

			const { result } = renderHook(() => useMarketplace());

			await waitFor(() => {
				expect(result.current.isLoading).toBe(false);
			});

			expect(window.maestro.marketplace.getManifest).toHaveBeenCalledTimes(1);
			expect(result.current.manifest).toEqual(testManifest);
			expect(result.current.playbooks).toHaveLength(1);
		});

		it('sets fromCache correctly when data is cached', async () => {
			vi.mocked(window.maestro.marketplace.getManifest).mockResolvedValue({
				success: true,
				manifest: createManifest([]),
				fromCache: true,
				cacheAge: 60000, // 1 minute
			});

			const { result } = renderHook(() => useMarketplace());

			await waitFor(() => {
				expect(result.current.isLoading).toBe(false);
			});

			expect(result.current.fromCache).toBe(true);
			expect(result.current.cacheAge).toBe(60000);
		});

		it('sets error when manifest loading fails', async () => {
			vi.mocked(window.maestro.marketplace.getManifest).mockResolvedValue({
				success: false,
				error: 'Network error',
			});

			const { result } = renderHook(() => useMarketplace());

			await waitFor(() => {
				expect(result.current.isLoading).toBe(false);
			});

			expect(result.current.error).toBe('Network error');
			expect(result.current.manifest).toBeNull();
		});

		it('handles thrown exceptions gracefully', async () => {
			vi.mocked(window.maestro.marketplace.getManifest).mockRejectedValue(
				new Error('Unexpected error')
			);

			const { result } = renderHook(() => useMarketplace());

			await waitFor(() => {
				expect(result.current.isLoading).toBe(false);
			});

			expect(result.current.error).toBe('Failed to load marketplace data');
		});
	});

	describe('category extraction', () => {
		it('returns ["All"] when manifest is null', async () => {
			vi.mocked(window.maestro.marketplace.getManifest).mockResolvedValue({
				success: false,
				error: 'Error',
			});

			const { result } = renderHook(() => useMarketplace());

			await waitFor(() => {
				expect(result.current.isLoading).toBe(false);
			});

			expect(result.current.categories).toEqual(['All']);
		});

		it('extracts unique categories sorted alphabetically', async () => {
			const testManifest = createManifest([
				createPlaybook({ id: '1', category: 'Security' }),
				createPlaybook({ id: '2', category: 'Development' }),
				createPlaybook({ id: '3', category: 'Testing' }),
				createPlaybook({ id: '4', category: 'Security' }), // Duplicate
			]);

			vi.mocked(window.maestro.marketplace.getManifest).mockResolvedValue({
				success: true,
				manifest: testManifest,
				fromCache: false,
			});

			const { result } = renderHook(() => useMarketplace());

			await waitFor(() => {
				expect(result.current.isLoading).toBe(false);
			});

			expect(result.current.categories).toEqual(['All', 'Development', 'Security', 'Testing']);
		});

		it('always includes "All" as first category', async () => {
			const testManifest = createManifest([createPlaybook({ category: 'Zebra' })]);

			vi.mocked(window.maestro.marketplace.getManifest).mockResolvedValue({
				success: true,
				manifest: testManifest,
				fromCache: false,
			});

			const { result } = renderHook(() => useMarketplace());

			await waitFor(() => {
				expect(result.current.isLoading).toBe(false);
			});

			expect(result.current.categories[0]).toBe('All');
		});
	});

	describe('search and filter', () => {
		const setupPlaybooks = async () => {
			const testManifest = createManifest([
				createPlaybook({
					id: 'security-1',
					title: 'Security Audit',
					description: 'Audit your security',
					category: 'Security',
					tags: ['audit', 'security'],
				}),
				createPlaybook({
					id: 'dev-1',
					title: 'Code Review',
					description: 'Review code changes',
					category: 'Development',
					tags: ['review', 'code'],
				}),
				createPlaybook({
					id: 'security-2',
					title: 'Penetration Testing',
					description: 'Test for vulnerabilities',
					category: 'Security',
					tags: ['pentest', 'vulnerabilities'],
				}),
			]);

			vi.mocked(window.maestro.marketplace.getManifest).mockResolvedValue({
				success: true,
				manifest: testManifest,
				fromCache: false,
			});

			const { result } = renderHook(() => useMarketplace());

			await waitFor(() => {
				expect(result.current.isLoading).toBe(false);
			});

			return result;
		};

		it('shows all playbooks when category is "All" and no search query', async () => {
			const result = await setupPlaybooks();
			expect(result.current.filteredPlaybooks).toHaveLength(3);
		});

		it('filters by category', async () => {
			const result = await setupPlaybooks();

			act(() => {
				result.current.setSelectedCategory('Security');
			});

			expect(result.current.filteredPlaybooks).toHaveLength(2);
			expect(result.current.filteredPlaybooks.every((p) => p.category === 'Security')).toBe(true);
		});

		it('filters by search query in title', async () => {
			const result = await setupPlaybooks();

			act(() => {
				result.current.setSearchQuery('audit');
			});

			expect(result.current.filteredPlaybooks).toHaveLength(1);
			expect(result.current.filteredPlaybooks[0].id).toBe('security-1');
		});

		it('filters by search query in description', async () => {
			const result = await setupPlaybooks();

			act(() => {
				result.current.setSearchQuery('vulnerabilities');
			});

			expect(result.current.filteredPlaybooks).toHaveLength(1);
			expect(result.current.filteredPlaybooks[0].id).toBe('security-2');
		});

		it('filters by search query in tags', async () => {
			const result = await setupPlaybooks();

			act(() => {
				result.current.setSearchQuery('pentest');
			});

			expect(result.current.filteredPlaybooks).toHaveLength(1);
			expect(result.current.filteredPlaybooks[0].id).toBe('security-2');
		});

		it('search is case-insensitive', async () => {
			const result = await setupPlaybooks();

			act(() => {
				result.current.setSearchQuery('SECURITY');
			});

			// Matches 'Security Audit' and 'security' tag
			expect(result.current.filteredPlaybooks).toHaveLength(1);
			expect(result.current.filteredPlaybooks[0].id).toBe('security-1');
		});

		it('combines category and search filters', async () => {
			const result = await setupPlaybooks();

			act(() => {
				result.current.setSelectedCategory('Security');
				result.current.setSearchQuery('audit');
			});

			expect(result.current.filteredPlaybooks).toHaveLength(1);
			expect(result.current.filteredPlaybooks[0].id).toBe('security-1');
		});

		it('trims search query whitespace', async () => {
			const result = await setupPlaybooks();

			act(() => {
				result.current.setSearchQuery('  audit  ');
			});

			expect(result.current.filteredPlaybooks).toHaveLength(1);
		});

		it('returns empty array for search with no matches', async () => {
			const result = await setupPlaybooks();

			act(() => {
				result.current.setSearchQuery('nonexistent');
			});

			expect(result.current.filteredPlaybooks).toHaveLength(0);
		});
	});

	describe('refresh functionality', () => {
		it('sets isRefreshing while refreshing', async () => {
			vi.mocked(window.maestro.marketplace.refreshManifest).mockImplementation(
				() =>
					new Promise((resolve) => {
						setTimeout(
							() => resolve({ success: true, manifest: createManifest([]), fromCache: false }),
							100
						);
					})
			);

			const { result } = renderHook(() => useMarketplace());

			await waitFor(() => {
				expect(result.current.isLoading).toBe(false);
			});

			expect(result.current.isRefreshing).toBe(false);

			act(() => {
				result.current.refresh();
			});

			expect(result.current.isRefreshing).toBe(true);

			await waitFor(() => {
				expect(result.current.isRefreshing).toBe(false);
			});
		});

		it('calls refreshManifest API', async () => {
			vi.mocked(window.maestro.marketplace.refreshManifest).mockResolvedValue({
				success: true,
				manifest: createManifest([createPlaybook()]),
				fromCache: false,
			});

			const { result } = renderHook(() => useMarketplace());

			await waitFor(() => {
				expect(result.current.isLoading).toBe(false);
			});

			await act(async () => {
				await result.current.refresh();
			});

			expect(window.maestro.marketplace.refreshManifest).toHaveBeenCalledTimes(1);
		});

		it('updates manifest after refresh', async () => {
			const initialManifest = createManifest([createPlaybook({ id: 'old' })]);
			const refreshedManifest = createManifest([createPlaybook({ id: 'new' })]);

			vi.mocked(window.maestro.marketplace.getManifest).mockResolvedValue({
				success: true,
				manifest: initialManifest,
				fromCache: true,
			});

			vi.mocked(window.maestro.marketplace.refreshManifest).mockResolvedValue({
				success: true,
				manifest: refreshedManifest,
				fromCache: false,
			});

			const { result } = renderHook(() => useMarketplace());

			await waitFor(() => {
				expect(result.current.isLoading).toBe(false);
			});

			expect(result.current.playbooks[0].id).toBe('old');

			await act(async () => {
				await result.current.refresh();
			});

			expect(result.current.playbooks[0].id).toBe('new');
			expect(result.current.fromCache).toBe(false);
			expect(result.current.cacheAge).toBe(0);
		});

		it('sets error on refresh failure', async () => {
			vi.mocked(window.maestro.marketplace.refreshManifest).mockResolvedValue({
				success: false,
				error: 'Refresh failed',
			});

			const { result } = renderHook(() => useMarketplace());

			await waitFor(() => {
				expect(result.current.isLoading).toBe(false);
			});

			await act(async () => {
				await result.current.refresh();
			});

			expect(result.current.error).toBe('Refresh failed');
		});
	});

	describe('import playbook functionality', () => {
		it('sets isImporting while importing', async () => {
			vi.mocked(window.maestro.marketplace.importPlaybook).mockImplementation(
				() =>
					new Promise((resolve) => {
						setTimeout(
							() =>
								resolve({
									success: true,
									playbook: { id: 'new', name: 'Test' },
									importedDocs: ['phase-1'],
								}),
							100
						);
					})
			);

			const { result } = renderHook(() => useMarketplace());

			await waitFor(() => {
				expect(result.current.isLoading).toBe(false);
			});

			expect(result.current.isImporting).toBe(false);

			const playbook = createPlaybook();
			act(() => {
				result.current.importPlaybook(playbook, 'my-folder', '/path/to/autorun', 'session-1');
			});

			expect(result.current.isImporting).toBe(true);

			await waitFor(() => {
				expect(result.current.isImporting).toBe(false);
			});
		});

		it('calls importPlaybook API with correct arguments', async () => {
			vi.mocked(window.maestro.marketplace.importPlaybook).mockResolvedValue({
				success: true,
				playbook: { id: 'new', name: 'Test' },
				importedDocs: ['phase-1'],
			});

			const { result } = renderHook(() => useMarketplace());

			await waitFor(() => {
				expect(result.current.isLoading).toBe(false);
			});

			const playbook = createPlaybook({ id: 'test-id' });
			await act(async () => {
				await result.current.importPlaybook(playbook, 'my-folder', '/path/to/autorun', 'session-1');
			});

			expect(window.maestro.marketplace.importPlaybook).toHaveBeenCalledWith(
				'test-id',
				'my-folder',
				'/path/to/autorun',
				'session-1',
				undefined // sshRemoteId - not provided in this test
			);
		});

		it('returns success result from importPlaybook', async () => {
			vi.mocked(window.maestro.marketplace.importPlaybook).mockResolvedValue({
				success: true,
				playbook: { id: 'new', name: 'Test' },
				importedDocs: ['phase-1'],
			});

			const { result } = renderHook(() => useMarketplace());

			await waitFor(() => {
				expect(result.current.isLoading).toBe(false);
			});

			const playbook = createPlaybook();
			let importResult: { success: boolean; error?: string };
			await act(async () => {
				importResult = await result.current.importPlaybook(playbook, 'folder', '/path', 'session');
			});

			expect(importResult!.success).toBe(true);
		});

		it('returns error result when import fails', async () => {
			vi.mocked(window.maestro.marketplace.importPlaybook).mockResolvedValue({
				success: false,
				error: 'Import failed',
			});

			const { result } = renderHook(() => useMarketplace());

			await waitFor(() => {
				expect(result.current.isLoading).toBe(false);
			});

			const playbook = createPlaybook();
			let importResult: { success: boolean; error?: string };
			await act(async () => {
				importResult = await result.current.importPlaybook(playbook, 'folder', '/path', 'session');
			});

			expect(importResult!.success).toBe(false);
			expect(importResult!.error).toBe('Import failed');
		});

		it('handles thrown exceptions during import', async () => {
			vi.mocked(window.maestro.marketplace.importPlaybook).mockRejectedValue(
				new Error('Network error')
			);

			const { result } = renderHook(() => useMarketplace());

			await waitFor(() => {
				expect(result.current.isLoading).toBe(false);
			});

			const playbook = createPlaybook();
			let importResult: { success: boolean; error?: string };
			await act(async () => {
				importResult = await result.current.importPlaybook(playbook, 'folder', '/path', 'session');
			});

			expect(importResult!.success).toBe(false);
			expect(importResult!.error).toBe('Import failed');
		});
	});

	describe('document fetching', () => {
		describe('fetchReadme', () => {
			it('returns content when successful', async () => {
				vi.mocked(window.maestro.marketplace.getReadme).mockResolvedValue({
					success: true,
					content: '# Test README',
				});

				const { result } = renderHook(() => useMarketplace());

				await waitFor(() => {
					expect(result.current.isLoading).toBe(false);
				});

				let content: string | null;
				await act(async () => {
					content = await result.current.fetchReadme('playbooks/test');
				});

				expect(content!).toBe('# Test README');
				expect(window.maestro.marketplace.getReadme).toHaveBeenCalledWith('playbooks/test');
			});

			it('returns null when README not found', async () => {
				vi.mocked(window.maestro.marketplace.getReadme).mockResolvedValue({
					success: true,
					content: null,
				});

				const { result } = renderHook(() => useMarketplace());

				await waitFor(() => {
					expect(result.current.isLoading).toBe(false);
				});

				let content: string | null;
				await act(async () => {
					content = await result.current.fetchReadme('playbooks/test');
				});

				expect(content!).toBeNull();
			});

			it('returns null on failure', async () => {
				vi.mocked(window.maestro.marketplace.getReadme).mockResolvedValue({
					success: false,
					error: 'Fetch failed',
				});

				const { result } = renderHook(() => useMarketplace());

				await waitFor(() => {
					expect(result.current.isLoading).toBe(false);
				});

				let content: string | null;
				await act(async () => {
					content = await result.current.fetchReadme('playbooks/test');
				});

				expect(content!).toBeNull();
			});

			it('returns null on exception', async () => {
				vi.mocked(window.maestro.marketplace.getReadme).mockRejectedValue(
					new Error('Network error')
				);

				const { result } = renderHook(() => useMarketplace());

				await waitFor(() => {
					expect(result.current.isLoading).toBe(false);
				});

				let content: string | null;
				await act(async () => {
					content = await result.current.fetchReadme('playbooks/test');
				});

				expect(content!).toBeNull();
			});
		});

		describe('fetchDocument', () => {
			it('returns content when successful', async () => {
				vi.mocked(window.maestro.marketplace.getDocument).mockResolvedValue({
					success: true,
					content: '# Phase 1 Content',
				});

				const { result } = renderHook(() => useMarketplace());

				await waitFor(() => {
					expect(result.current.isLoading).toBe(false);
				});

				let content: string | null;
				await act(async () => {
					content = await result.current.fetchDocument('playbooks/test', 'phase-1');
				});

				expect(content!).toBe('# Phase 1 Content');
				expect(window.maestro.marketplace.getDocument).toHaveBeenCalledWith(
					'playbooks/test',
					'phase-1'
				);
			});

			it('returns null on failure', async () => {
				vi.mocked(window.maestro.marketplace.getDocument).mockResolvedValue({
					success: false,
					error: 'Document not found',
				});

				const { result } = renderHook(() => useMarketplace());

				await waitFor(() => {
					expect(result.current.isLoading).toBe(false);
				});

				let content: string | null;
				await act(async () => {
					content = await result.current.fetchDocument('playbooks/test', 'phase-1');
				});

				expect(content!).toBeNull();
			});

			it('returns null on exception', async () => {
				vi.mocked(window.maestro.marketplace.getDocument).mockRejectedValue(
					new Error('Network error')
				);

				const { result } = renderHook(() => useMarketplace());

				await waitFor(() => {
					expect(result.current.isLoading).toBe(false);
				});

				let content: string | null;
				await act(async () => {
					content = await result.current.fetchDocument('playbooks/test', 'phase-1');
				});

				expect(content!).toBeNull();
			});
		});
	});

	describe('type exports', () => {
		it('UseMarketplaceReturn type matches hook return', async () => {
			const { result } = renderHook(() => useMarketplace());

			await waitFor(() => {
				expect(result.current.isLoading).toBe(false);
			});

			const hookReturn: UseMarketplaceReturn = result.current;

			expect(hookReturn.manifest).toBeDefined();
			expect(hookReturn.playbooks).toBeDefined();
			expect(hookReturn.categories).toBeDefined();
			expect(hookReturn.isLoading).toBeDefined();
			expect(hookReturn.setSelectedCategory).toBeDefined();
			expect(hookReturn.refresh).toBeDefined();
			expect(hookReturn.importPlaybook).toBeDefined();
		});
	});
});
