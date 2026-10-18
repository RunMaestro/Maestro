/**
 * @file marketplace.test.ts
 * @description Tests for `marketplace list|show|import`: catalog filtering,
 * the modal's default folder name, and failure reporting.
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
	marketplaceImport,
	marketplaceList,
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
});
