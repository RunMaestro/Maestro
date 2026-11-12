/**
 * @file marketplace.test.ts
 * @description Tests for `marketplace list|show|import`: catalog filtering,
 * the modal's default folder name, and failure reporting.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

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
	LAUNCH_POLL_INTERVAL_MS,
	marketplaceLaunch,
	marketplaceLaunches,
	marketplaceLaunchStatus,
	marketplaceList,
	marketplaceShow,
} from '../../../cli/commands/marketplace';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import type { MarketplacePlaybook, PlaybookLaunchSpec } from '../../../shared/marketplace-types';
import { createMockLaunchRecord } from '../../helpers';

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

/** A bridge reply, or a function that answers each call in turn (for a poll that changes). */
type BridgeReply = unknown | (() => unknown);

function mockBridge(responses: Record<string, BridgeReply>) {
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

	it('launch reads --input-file and lets --input override it', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-cmd-'));
		const file = path.join(dir, 'answers.json');
		fs.writeFileSync(file, JSON.stringify({ PR_URL: 'https://example.com/pr/9', MAX_LOC: 200 }));
		try {
			const sent = launchBridge();
			await marketplaceLaunch('pr-bot', {
				agent: 'a1',
				confirm: true,
				inputFile: file,
				input: ['MAX_LOC=300'],
			});
			expect(sent[1]).toMatchObject({
				values: { PR_URL: 'https://example.com/pr/9', MAX_LOC: 300 },
			});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('launch prints one JSON object with the launch id and folder', async () => {
		launchBridge();
		await marketplaceLaunch('pr-bot', {
			agent: 'a1',
			confirm: true,
			json: true,
			input: ['PR_URL=https://example.com/pr/1'],
		});
		expect(JSON.parse(logged[0])).toEqual({
			success: true,
			sessionId: 'a1',
			launchId: 'l1',
			folder: 'pr-bot-launch-x',
		});
	});

	it('launch reports an app-side refusal and exits 1', async () => {
		launchBridge({ marketplace_launch: { success: false, error: 'Agent is busy' } });
		await expect(
			marketplaceLaunch('pr-bot', {
				agent: 'a1',
				confirm: true,
				input: ['PR_URL=https://example.com/pr/1'],
			})
		).rejects.toThrow('__exit__');
		expect(errored.join('\n')).toContain('Agent is busy');
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	describe('--new-agent', () => {
		const answers = ['PR_URL=https://example.com/pr/1'];

		it('creates the agent through create_session, then launches on the returned id', async () => {
			const sent = launchBridge({ create_session: { success: true, sessionId: 'new-1' } });
			await marketplaceLaunch('pr-bot', {
				newAgent: true,
				provider: 'codex',
				cwd: '/tmp/work',
				name: 'Bot',
				model: 'm1',
				effort: 'high',
				sshRemote: 'r1',
				confirm: true,
				input: answers,
			});
			expect(sent.map((m) => m.type)).toEqual([
				'marketplace_get_manifest',
				'create_session',
				'marketplace_launch',
			]);
			expect(sent[1]).toMatchObject({
				name: 'Bot',
				toolType: 'codex',
				background: true,
				customModel: 'm1',
				customEffort: 'high',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
			});
			expect(sent[2]).toMatchObject({ sessionId: 'new-1', playbookId: 'pr-bot' });
		});

		it('names the agent after the playbook when --name is absent', async () => {
			const sent = launchBridge({ create_session: { success: true, sessionId: 'new-1' } });
			await marketplaceLaunch('pr-bot', {
				newAgent: true,
				provider: 'codex',
				cwd: '/tmp/work',
				confirm: true,
				input: answers,
			});
			expect(sent[1]).toMatchObject({ name: 'PR Bot' });
		});

		it('creates nothing when the answers are refused or --confirm is missing', async () => {
			let sent = launchBridge();
			await expect(
				marketplaceLaunch('pr-bot', {
					newAgent: true,
					provider: 'codex',
					cwd: '/tmp/work',
					confirm: true,
				})
			).rejects.toThrow('__exit__');
			expect(sent.map((m) => m.type)).toEqual(['marketplace_get_manifest']);

			sent = launchBridge();
			await expect(
				marketplaceLaunch('pr-bot', {
					newAgent: true,
					provider: 'codex',
					cwd: '/tmp/work',
					input: answers,
				})
			).rejects.toThrow('__exit__');
			expect(sent.map((m) => m.type)).toEqual(['marketplace_get_manifest']);
		});

		it('refuses missing or unknown flags, and --agent together with --new-agent', async () => {
			const sent = launchBridge();
			const base = { newAgent: true, confirm: true, input: answers };
			await expect(marketplaceLaunch('pr-bot', { ...base, cwd: '/tmp' })).rejects.toThrow(
				'__exit__'
			);
			expect(errored.join('\n')).toContain('--new-agent needs --provider');
			await expect(
				marketplaceLaunch('pr-bot', { ...base, provider: 'nope', cwd: '/tmp' })
			).rejects.toThrow('__exit__');
			expect(errored.join('\n')).toContain('Invalid provider "nope"');
			await expect(
				marketplaceLaunch('pr-bot', { ...base, provider: 'codex', cwd: '/tmp', agent: 'a1' })
			).rejects.toThrow('__exit__');
			expect(errored.join('\n')).toContain('cannot be used together');
			expect(sent.map((m) => m.type)).not.toContain('create_session');
		});

		it('stops before launching when the agent cannot be created', async () => {
			const sent = launchBridge({ create_session: { success: false, error: 'no such folder' } });
			await expect(
				marketplaceLaunch('pr-bot', {
					newAgent: true,
					provider: 'codex',
					cwd: '/tmp/work',
					confirm: true,
					input: answers,
				})
			).rejects.toThrow('__exit__');
			expect(errored.join('\n')).toContain('no such folder');
			expect(sent.map((m) => m.type)).not.toContain('marketplace_launch');
		});

		it('says the new agent was kept when the launch itself fails', async () => {
			launchBridge({
				create_session: { success: true, sessionId: 'new-1' },
				marketplace_launch: { success: false, error: 'import failed' },
			});
			await expect(
				marketplaceLaunch('pr-bot', {
					newAgent: true,
					provider: 'codex',
					cwd: '/tmp/work',
					confirm: true,
					input: answers,
				})
			).rejects.toThrow('__exit__');
			expect(errored.join('\n')).toContain('import failed');
			expect(errored.join('\n')).toContain('new-1');
		});
	});

	describe('--wait, launches and launch-status', () => {
		const answers = ['PR_URL=https://example.com/pr/1'];
		const finished = createMockLaunchRecord({
			launchId: 'l1',
			playbookId: 'pr-bot',
			sessionId: 'a1',
			status: 'completed',
			cleanup: 'done',
			completion: { completedTasks: 2, totalTasks: 2, elapsedTimeMs: 5_000, wasStopped: false },
			spec: { inputs: [], outro: { summary: 'All reviewed.', nextSteps: ['Merge it'] } },
		});
		const running = { ...finished, status: 'running' as const, completion: undefined };

		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it('polls launch-status until the run is not running, then prints the outro', async () => {
			const replies = [running, running, finished];
			const sent = launchBridge({
				marketplace_get_launch: () => ({ success: true, launch: replies.shift() }),
			});
			const done = marketplaceLaunch('pr-bot', {
				agent: 'a1',
				confirm: true,
				wait: true,
				input: answers,
			});
			await vi.advanceTimersByTimeAsync(LAUNCH_POLL_INTERVAL_MS * 2);
			await done;
			expect(sent.filter((m) => m.type === 'marketplace_get_launch')).toHaveLength(3);
			expect(sent.find((m) => m.type === 'marketplace_get_launch')).toEqual({
				type: 'marketplace_get_launch',
				launchId: 'l1',
			});
			expect(logged.join('\n')).toContain('All reviewed.');
			expect(logged.join('\n')).toContain('Merge it');
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('exits 1 when the waited run does not complete', async () => {
			launchBridge({
				marketplace_get_launch: {
					success: true,
					launch: { ...finished, status: 'failed' },
				},
			});
			await expect(
				marketplaceLaunch('pr-bot', {
					agent: 'a1',
					confirm: true,
					wait: true,
					input: answers,
				})
			).rejects.toThrow('__exit__');
			expect(exitSpy).toHaveBeenCalledWith(1);
		});

		it('--wait --json carries the finished record', async () => {
			launchBridge({ marketplace_get_launch: { success: true, launch: finished } });
			await marketplaceLaunch('pr-bot', {
				agent: 'a1',
				confirm: true,
				wait: true,
				json: true,
				input: answers,
			});
			expect(JSON.parse(logged[0])).toMatchObject({
				success: true,
				launchId: 'l1',
				launch: { status: 'completed' },
			});
		});

		it('launch-status prints the record and the rendered outro', async () => {
			const sent = launchBridge({ marketplace_get_launch: { success: true, launch: finished } });
			await marketplaceLaunchStatus('l1', {});
			expect(sent[0]).toEqual({ type: 'marketplace_get_launch', launchId: 'l1' });
			expect(logged.join('\n')).toContain('Status:   Completed');
			expect(logged.join('\n')).toContain('All reviewed.');
		});

		it('launch-status --json prints the record, and an unknown id fails', async () => {
			launchBridge({ marketplace_get_launch: { success: true, launch: finished } });
			await marketplaceLaunchStatus('l1', { json: true });
			expect(JSON.parse(logged[0])).toMatchObject({ success: true, launch: { launchId: 'l1' } });

			launchBridge({ marketplace_get_launch: { success: false, error: 'No launch "zz"' } });
			await expect(marketplaceLaunchStatus('zz', {})).rejects.toThrow('__exit__');
			expect(errored.join('\n')).toContain('No launch "zz"');
		});

		it('launches lists records, filters by agent, and says when there are none', async () => {
			let sent = launchBridge({
				marketplace_list_launches: { success: true, launches: [finished] },
			});
			await marketplaceLaunches({ agent: 'a1' });
			expect(sent[0]).toEqual({ type: 'marketplace_list_launches', sessionId: 'a1' });
			expect(logged.join('\n')).toContain('l1  completed  pr-bot  agent a1');

			logged.length = 0;
			sent = launchBridge({ marketplace_list_launches: { success: true, launches: [] } });
			await marketplaceLaunches({});
			expect(sent[0]).toEqual({ type: 'marketplace_list_launches' });
			expect(logged).toEqual(['No launches.']);

			logged.length = 0;
			launchBridge({ marketplace_list_launches: { success: true, launches: [finished] } });
			await marketplaceLaunches({ json: true });
			expect(JSON.parse(logged[0])).toHaveLength(1);
		});
	});
});
