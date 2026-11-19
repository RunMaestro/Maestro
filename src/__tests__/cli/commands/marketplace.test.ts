/**
 * @file marketplace.test.ts
 * @description Tests for `marketplace list|show|import|updates`: catalog
 * filtering, the modal's default folder name, updating an installed copy, and
 * failure reporting.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => id),
	readActiveAgentId: vi.fn(),
}));

import {
	filterPlaybooks,
	formatPlaybookUpdateLine,
	marketplaceImport,
	marketplaceList,
	marketplaceUpdates,
	playbookHealthLabels,
} from '../../../cli/commands/marketplace';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import type { MarketplacePlaybook } from '../../../shared/marketplace-types';

const pb = (over: Partial<MarketplacePlaybook>): MarketplacePlaybook =>
	({
		id: 'x',
		title: 'X',
		description: '',
		category: 'Development',
		author: 'a',
		lastUpdated: '2026-01-01',
		path: 'dev/x',
		documents: [{ filename: 'one', resetOnCompletion: false }],
		loopEnabled: false,
		prompt: null,
		...over,
	}) as MarketplacePlaybook;

const catalog = [
	pb({ id: 'security-audit', title: 'Security Audit', category: 'Security', tags: ['owasp'] }),
	pb({ id: 'docs-pass', title: 'Docs Pass', description: 'tighten the README' }),
];

function mockBridge(responses: Record<string, unknown>) {
	const sent: Record<string, unknown>[] = [];
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
				sent.push(payload);
				return Promise.resolve(responses[payload.type as string]);
			}),
		} as never)
	);
	return sent;
}

describe('filterPlaybooks', () => {
	it('filters by category and by a search over id, title, description, and tags', () => {
		expect(filterPlaybooks(catalog, { category: 'security' }).map((p) => p.id)).toEqual([
			'security-audit',
		]);
		expect(filterPlaybooks(catalog, { search: 'OWASP' }).map((p) => p.id)).toEqual([
			'security-audit',
		]);
		expect(filterPlaybooks(catalog, { search: 'readme' }).map((p) => p.id)).toEqual(['docs-pass']);
	});
});

describe('marketplace commands', () => {
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('list passes --refresh through and fails when the catalog does not load', async () => {
		const sent = mockBridge({
			marketplace_get_manifest: {
				success: true,
				manifest: { lastUpdated: '', playbooks: catalog },
			},
		});
		await marketplaceList({ refresh: true });
		expect(sent[0]).toEqual({ type: 'marketplace_get_manifest', refresh: true });

		mockBridge({ marketplace_get_manifest: { success: false, error: 'offline' } });
		await expect(marketplaceList({})).rejects.toThrow('__exit__');
	});

	describe('health figures', () => {
		const health = {
			'docs-pass': { installs_30d: 80, runs_30d: 200, success_rate_30d: 0.95, recent_failures: 0 },
			'security-audit': {
				installs_30d: 5,
				runs_30d: 20,
				success_rate_30d: 0.4,
				recent_failures: 4,
			},
		};
		const logged = () =>
			vi
				.mocked(console.log)
				.mock.calls.map((call) => String(call[0]))
				.join('\n');

		it('--sort popular orders by installs and prints the modal badges', async () => {
			mockBridge({
				marketplace_get_manifest: {
					success: true,
					manifest: { lastUpdated: '', playbooks: catalog },
					health,
				},
			});
			await marketplaceList({ sort: 'popular' });
			const out = logged();
			expect(out.indexOf('docs-pass')).toBeLessThan(out.indexOf('security-audit'));
			expect(out).toContain('docs-pass  (Development, 1 docs, by a)  [Most popular]');
			expect(out).toContain('[Recently broken]');
		});

		it("--json carries each playbook's figures and badges", async () => {
			mockBridge({
				marketplace_get_manifest: {
					success: true,
					manifest: { lastUpdated: '', playbooks: catalog },
					health,
				},
			});
			await marketplaceList({ json: true });
			const rows = JSON.parse(String(vi.mocked(console.log).mock.calls[0][0]));
			expect(rows.map((row: { id: string }) => row.id)).toEqual(['security-audit', 'docs-pass']);
			expect(rows[0].badges).toEqual(['Recently broken']);
			expect(rows[1].health).toEqual(health['docs-pass']);
		});

		it('prints no badges and keeps the catalog order when the app sends no figures', async () => {
			mockBridge({
				marketplace_get_manifest: {
					success: true,
					manifest: { lastUpdated: '', playbooks: catalog },
				},
			});
			await marketplaceList({ sort: 'popular' });
			const out = logged();
			expect(out).not.toContain('[');
			expect(out.indexOf('security-audit')).toBeLessThan(out.indexOf('docs-pass'));
		});

		it('rejects an unknown --sort before asking the app', async () => {
			const sent = mockBridge({});
			await expect(marketplaceList({ sort: 'newest' })).rejects.toThrow('__exit__');
			expect(sent).toHaveLength(0);
		});

		it('playbookHealthLabels follows the shared rules', () => {
			expect(playbookHealthLabels('docs-pass', health, new Set(['docs-pass']))).toEqual([
				'Most popular',
			]);
			expect(playbookHealthLabels('security-audit', health, new Set())).toEqual([
				'Recently broken',
			]);
			expect(playbookHealthLabels('missing', health, new Set())).toEqual([]);
		});
	});

	it('import defaults the folder to the slug the modal proposes', async () => {
		const sent = mockBridge({
			marketplace_get_manifest: {
				success: true,
				manifest: { lastUpdated: '', playbooks: catalog },
			},
			marketplace_import_playbook: { success: true, importedDocs: ['one'] },
		});
		await marketplaceImport('security-audit', { agent: 'a1' });
		expect(sent[1]).toEqual({
			type: 'marketplace_import_playbook',
			sessionId: 'a1',
			playbookId: 'security-audit',
			targetFolderName: 'security-audit',
		});
	});

	it('import points at the saved playbook record, not at the bare documents', async () => {
		mockBridge({
			marketplace_import_playbook: {
				success: true,
				importedDocs: ['one'],
				playbook: { id: 'pb-123', name: 'Docs Pass', documents: [] },
			},
		});
		await marketplaceImport('docs-pass', { agent: 'a1', folder: 'docs-pass' });
		const printed = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
		expect(printed).toContain('Run it with: maestro-cli playbook pb-123');
		expect(printed).toContain('See its parameters with: maestro-cli playbook configure pb-123');
		expect(printed.some((line) => line.includes('auto-run'))).toBe(false);

		vi.mocked(console.log).mockClear();
		await marketplaceImport('docs-pass', { agent: 'a1', folder: 'docs-pass', json: true });
		const json = JSON.parse(String(vi.mocked(console.log).mock.calls[0][0]));
		expect(json).toMatchObject({ success: true, sessionId: 'a1', playbookId: 'pb-123' });
	});

	it('import falls back to the auto-run hint when the app returns no record', async () => {
		mockBridge({ marketplace_import_playbook: { success: true, importedDocs: ['one'] } });
		await marketplaceImport('docs-pass', { agent: 'a1', folder: 'docs-pass' });
		const printed = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
		expect(printed).toContain('Run it with: maestro-cli auto-run <docs...> -a a1');
	});

	it('import honors --folder and reports an app-side failure', async () => {
		const sent = mockBridge({
			marketplace_import_playbook: { success: false, error: 'folder exists' },
		});
		await expect(marketplaceImport('docs-pass', { agent: 'a1', folder: 'mine' })).rejects.toThrow(
			'__exit__'
		);
		expect(sent[0]).toMatchObject({ targetFolderName: 'mine' });
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	describe('updates', () => {
		const status = {
			playbookId: 'pb-123',
			marketplaceId: 'security-audit',
			name: 'Security Audit',
			targetFolderName: 'security-audit',
			state: 'update-available',
			updateAvailable: true,
			installedVersion: '2026-08-01',
			latestVersion: '2026-09-01',
			modifiedDocuments: [],
		} as const;

		it('import --update sends no folder and reports the folder the record lives in', async () => {
			const sent = mockBridge({
				marketplace_import_playbook: {
					success: true,
					importedDocs: ['one'],
					playbook: {
						id: 'pb-123',
						name: 'Security Audit',
						documents: [],
						provenance: { targetFolderName: 'audit' },
					},
				},
			});
			await marketplaceImport('security-audit', { agent: 'a1', update: true });

			// No catalog fetch for a default folder name: the record has its own.
			expect(sent).toEqual([
				{
					type: 'marketplace_import_playbook',
					sessionId: 'a1',
					playbookId: 'security-audit',
					update: true,
				},
			]);
			const printed = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(printed).toContain('Updated security-audit in audit/ on a1 (1 documents).');
		});

		it('import --update refuses --folder before asking the app', async () => {
			const sent = mockBridge({});
			await expect(
				marketplaceImport('security-audit', { agent: 'a1', update: true, folder: 'x' })
			).rejects.toThrow('__exit__');
			expect(sent).toEqual([]);
		});

		it('lists each installed playbook with its state and how to update', async () => {
			const sent = mockBridge({
				marketplace_check_updates: { success: true, updates: { 'pb-123': status } },
			});
			await marketplaceUpdates({ agent: 'a1' });

			expect(sent).toEqual([{ type: 'marketplace_check_updates', sessionId: 'a1' }]);
			const printed = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(printed[0]).toBe(formatPlaybookUpdateLine(status));
			expect(printed[0]).toContain('[update-available]');
			expect(printed).toContain(
				'Update one with: maestro-cli marketplace import <playbook-id> --update -a a1'
			);
		});

		it('prints the statuses as JSON', async () => {
			mockBridge({
				marketplace_check_updates: { success: true, updates: { 'pb-123': status } },
			});
			await marketplaceUpdates({ agent: 'a1', json: true });
			expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0][0]))).toEqual([status]);
		});

		it('says so when nothing from the Exchange is installed', async () => {
			mockBridge({ marketplace_check_updates: { success: true, updates: {} } });
			await marketplaceUpdates({ agent: 'a1' });
			expect(vi.mocked(console.log)).toHaveBeenCalledWith(
				'No Playbook Exchange playbooks are installed on a1.'
			);
		});

		it('fails when the app cannot check', async () => {
			mockBridge({ marketplace_check_updates: { success: false, error: 'SSH remote down' } });
			await expect(marketplaceUpdates({ agent: 'a1' })).rejects.toThrow('__exit__');
			expect(exitSpy).toHaveBeenCalledWith(1);
		});
	});
});
