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
	readSessions: vi.fn(() => []),
}));

import {
	filterPlaybooks,
	marketplaceImport,
	marketplaceLaunch,
	marketplaceList,
	marketplaceShow,
} from '../../../cli/commands/marketplace';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import type { MarketplacePlaybook, PlaybookLaunchSpec } from '../../../shared/marketplace-types';

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

describe('marketplace show and launch', () => {
	let exitSpy: MockInstance;
	let logged: string[];
	let errored: string[];

	const launchSpec: PlaybookLaunchSpec = {
		preconditions: { confirm: 'I understand the risk' },
		inputs: [
			{ name: 'PR_URL', label: 'Pull request', type: 'url', required: true },
			{ name: 'MAX_LOC', label: 'Max LOC', type: 'number', default: 500, min: 100 },
		],
		outro: { summary: 'Done', nextSteps: [] },
	};
	const launchable = pb({ id: 'pr-bot', title: 'PR Bot', launch: launchSpec });
	const launchBridge = (extra: Record<string, unknown> = {}) =>
		mockBridge({
			marketplace_get_manifest: {
				success: true,
				manifest: { lastUpdated: '', playbooks: [launchable, catalog[0]] },
			},
			marketplace_launch: { success: true, launchId: 'l1', folderRelativePath: 'pr-bot-launch-x' },
			...extra,
		});

	beforeEach(() => {
		vi.clearAllMocks();
		logged = [];
		errored = [];
		vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
			logged.push(String(line));
		});
		vi.spyOn(console, 'error').mockImplementation((line?: unknown) => {
			errored.push(String(line));
		});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('show prints the launch inputs, or says the playbook is download only', async () => {
		launchBridge({ marketplace_get_readme: { success: true, content: null } });
		await marketplaceShow('pr-bot', {});
		expect(logged.join('\n')).toContain('PR_URL  (url, required)');

		logged.length = 0;
		await marketplaceShow('security-audit', {});
		expect(logged.join('\n')).toContain('download only');
	});

	it('launch sends the resolved values for the named agent', async () => {
		const sent = launchBridge();
		await marketplaceLaunch('pr-bot', {
			agent: 'a1',
			confirm: true,
			input: ['PR_URL=https://example.com/pr/1'],
			keepPlaybook: true,
		});
		expect(sent[1]).toEqual({
			type: 'marketplace_launch',
			sessionId: 'a1',
			playbookId: 'pr-bot',
			values: { PR_URL: 'https://example.com/pr/1', MAX_LOC: 500 },
			keepSavedPlaybook: true,
		});
		expect(logged.join('\n')).toContain('Launched pr-bot on a1 (launch l1)');
	});

	it('launch lists every refused field and sends nothing', async () => {
		const sent = launchBridge();
		await expect(
			marketplaceLaunch('pr-bot', { agent: 'a1', confirm: true, input: ['MAX_LOC=5'] })
		).rejects.toThrow('__exit__');
		const message = errored.join('\n');
		expect(message).toContain('PR_URL: This field is required');
		expect(message).toContain('MAX_LOC: Must be at least 100');
		expect(sent.map((m) => m.type)).toEqual(['marketplace_get_manifest']);
	});

	it('launch reports field errors as JSON', async () => {
		launchBridge();
		await expect(marketplaceLaunch('pr-bot', { agent: 'a1', json: true })).rejects.toThrow(
			'__exit__'
		);
		expect(JSON.parse(logged[0])).toMatchObject({
			success: false,
			fieldErrors: { PR_URL: 'This field is required' },
		});
	});

	it('launch refuses without --confirm when the playbook asks for it', async () => {
		const sent = launchBridge();
		await expect(
			marketplaceLaunch('pr-bot', { agent: 'a1', input: ['PR_URL=https://example.com/pr/1'] })
		).rejects.toThrow('__exit__');
		expect(errored.join('\n')).toContain('I understand the risk');
		expect(sent).toHaveLength(1);
	});

	it('launch refuses a download-only playbook', async () => {
		launchBridge();
		await expect(marketplaceLaunch('security-audit', { agent: 'a1' })).rejects.toThrow('__exit__');
		expect(errored.join('\n')).toContain('download only');
		expect(exitSpy).toHaveBeenCalled();
	});

	it('launch takes the calling agent from the environment when --agent is absent', async () => {
		vi.stubEnv('MAESTRO_CALLER_AGENT_ID', 'caller-1');
		const sent = launchBridge();
		await marketplaceLaunch('pr-bot', {
			confirm: true,
			input: ['PR_URL=https://example.com/pr/1'],
		});
		vi.unstubAllEnvs();
		expect(sent[1]).toMatchObject({ sessionId: 'caller-1' });
	});

	it('launch needs an agent when none is given and none is calling', async () => {
		vi.stubEnv('MAESTRO_CALLER_AGENT_ID', '');
		launchBridge();
		await expect(
			marketplaceLaunch('pr-bot', { confirm: true, input: ['PR_URL=https://example.com/pr/1'] })
		).rejects.toThrow('__exit__');
		vi.unstubAllEnvs();
		expect(errored.join('\n')).toContain('Pass --agent');
	});
});
