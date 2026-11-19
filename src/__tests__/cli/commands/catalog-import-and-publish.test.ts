// Source: src/__tests__/cli/commands/gist.test.ts
// Source: src/__tests__/cli/commands/marketplace.test.ts
import { describe as describeSourceSuite, afterEach as cleanupAfterEach } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { gistCreate } from '../../../cli/commands/gist';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { filterPlaybooks } from '../../../cli/commands/marketplace';
import { marketplaceImport } from '../../../cli/commands/marketplace';
import { marketplaceList } from '../../../cli/commands/marketplace';
import type { MarketplacePlaybook } from '../../../shared/marketplace-types';
import { resolveAgentId } from '../../../cli/services/storage';
vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => id),
	readActiveAgentId: vi.fn(),
}));
beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(resolveAgentId).mockImplementation((id: string) => id);
});
cleanupAfterEach(() => vi.restoreAllMocks());
describeSourceSuite('gist', () => {
	describe('gist create command', () => {
		let consoleSpy: MockInstance;
		let processExitSpy: MockInstance;

		/** Capture the message sent to the desktop and reply with a successful gist. */
		function captureMessage(): Record<string, unknown> {
			const captured: Record<string, unknown> = {};
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockImplementation((msg) => {
						Object.assign(captured, msg);
						return Promise.resolve({ success: true, gistUrl: 'https://gist.github.com/abc' });
					}),
				};
				return action(mockClient as never);
			});
			return captured;
		}

		beforeEach(() => {
			vi.clearAllMocks();
			consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
			processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		});

		it('omits agentSessionId when no session is requested', async () => {
			const msg = captureMessage();

			await gistCreate('agent-1', {});

			expect(msg.sessionId).toBe('agent-1');
			expect(msg.agentSessionId).toBeUndefined();
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('sends the requested provider session id', async () => {
			const msg = captureMessage();

			await gistCreate('agent-1', { session: 'provider-session-9' });

			expect(msg.sessionId).toBe('agent-1');
			expect(msg.agentSessionId).toBe('provider-session-9');

			const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
			expect(output.success).toBe(true);
			expect(output.agentSessionId).toBe('provider-session-9');
		});

		// A blank `--session` must not degrade into "publish the open tabs" - that is
		// the exact substitution this option exists to prevent. `process.exit` really
		// does end the process here, so the spy throws rather than returning: a spy
		// that returns lets the function run on and publish the very gist the guard
		// just refused.
		it('rejects a blank --session instead of publishing the open tabs', async () => {
			const msg = captureMessage();
			processExitSpy.mockImplementation((code?: number) => {
				throw new Error(`process.exit(${code})`);
			});

			await expect(gistCreate('agent-1', { session: '   ' })).rejects.toThrow('process.exit(1)');

			expect(msg.sessionId).toBeUndefined();
			const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
			expect(output.success).toBe(false);
			expect(output.code).toBe('INVALID_SESSION');
		});

		it('reports the desktop failure rather than claiming success', async () => {
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi
						.fn()
						.mockResolvedValue({ success: false, error: 'No transcript found for session x' }),
				};
				return action(mockClient as never);
			});

			await gistCreate('agent-1', { session: 'x' });

			const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
			expect(output.success).toBe(false);
			expect(output.code).toBe('GIST_CREATE_FAILED');
			expect(output.error).toContain('No transcript found');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});
});
describeSourceSuite('marketplace', () => {
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
			expect(filterPlaybooks(catalog, { search: 'readme' }).map((p) => p.id)).toEqual([
				'docs-pass',
			]);
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
});
