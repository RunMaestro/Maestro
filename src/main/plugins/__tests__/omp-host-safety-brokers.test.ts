import { describe, expect, it } from 'vitest';
import * as path from 'node:path';

const testWorkspace = path.resolve('workspace');
const testExports = path.resolve('exports');
import type { WorkspaceRootCapability } from '../../../shared/plugins/interactive-runtime';
import {
	OmpAuthCallbackPkceRouter,
	OmpNativeExportBroker,
	OmpRootToolPolicyBroker,
	OmpUriBroker,
	type OmpExportFilesystem,
	type OmpToolFilesystem,
} from '../omp-host-safety-brokers';
import { NativeWorkspaceRootService } from '../native-workspace-root-service';

const activation = () => ({
	ownerPluginId: 'com.maestro.omp',
	generation: 7n,
	authorization: {
		signatureTrusted: true,
		enabled: true,
		hostCompatible: true,
		userConsented: true,
		workspaceRootCurrent: true,
		grants: [{ capability: 'process:interactive' as const, scope: 'omp', grantedAt: 1 }],
	},
});

function roots(reparse = () => false): NativeWorkspaceRootService {
	return new NativeWorkspaceRootService({
		chooseDirectory: async () => testWorkspace,
		activation,
		filesystem: {
			resolve: (value) => value,
			isAbsolute: () => true,
			realpath: (value) => value,
			lstat: () => ({ isDirectory: () => true, isSymbolicLink: reparse }),
			sep: '/',
		},
	});
}

function toolFilesystem(contents = new Map<string, string>()): OmpToolFilesystem {
	return {
		lstat: async (value) => {
			if (value === testWorkspace || value === path.join(testWorkspace, 'docs')) {
				return { isDirectory: () => true, isSymbolicLink: () => false };
			}
			if (!contents.has(value)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
			return { isDirectory: () => false, isSymbolicLink: () => false };
		},
		realpath: async (value) => value,
		readFileNoFollow: async (value) => Buffer.from(contents.get(value) ?? ''),
		writeFileNoFollow: async (value, content) => {
			contents.set(value, content.toString());
		},
	};
}

async function toolBroker(files = new Map<string, string>()) {
	const rootService = roots();
	const root = (await rootService.requestWorkspaceRoot()) as WorkspaceRootCapability;
	return {
		broker: new OmpRootToolPolicyBroker({
			roots: rootService,
			workspaceRoot: () => root,
			activation,
			filesystem: toolFilesystem(files),
			approve: async () => true,
			clock: () => 1_000,
		}),
		files,
	};
}

describe('OMP host safety brokers', () => {
	it('permits only approved bounded root-relative workspace tools and never returns a raw path', async () => {
		const { broker, files } = await toolBroker(
			new Map([[path.join(testWorkspace, 'docs', 'a.txt'), 'hello']])
		);
		await expect(broker.invoke('maestro.workspace.read', { path: 'docs/a.txt' })).resolves.toEqual({
			text: 'hello',
		});
		await expect(
			broker.invoke('maestro.workspace.write', { path: 'docs/b.txt', text: 'updated' })
		).resolves.toEqual({ phase: 'completed' });
		expect(files.get(path.join(testWorkspace, 'docs', 'b.txt'))).toBe('updated');
		await expect(broker.invoke('bash', { command: 'whoami' })).rejects.toThrow('unavailable');
	});

	it('rejects a concurrent call and rejects the pending call once after revocation', async () => {
		const rootService = roots();
		const root = (await rootService.requestWorkspaceRoot()) as WorkspaceRootCapability;
		let releaseApproval: () => void = () => undefined;
		const approval = new Promise<void>((resolve) => {
			releaseApproval = resolve;
		});
		const broker = new OmpRootToolPolicyBroker({
			roots: rootService,
			workspaceRoot: () => root,
			activation,
			filesystem: toolFilesystem(new Map([[path.join(testWorkspace, 'docs', 'a.txt'), 'ok']])),
			approve: async () => {
				await approval;
				return true;
			},
		});
		const pending = broker.invoke('maestro.workspace.read', { path: 'docs/a.txt' });
		await expect(broker.invoke('maestro.workspace.read', { path: 'docs/a.txt' })).rejects.toThrow(
			'unavailable'
		);
		broker.revoke();
		releaseApproval();
		await expect(pending).rejects.toThrow('unavailable');
	});

	it('enforces the per-minute workspace tool rate limit', async () => {
		const { broker } = await toolBroker(
			new Map([[path.join(testWorkspace, 'docs', 'a.txt'), 'ok']])
		);
		for (let call = 0; call < 30; call += 1) {
			await expect(
				broker.invoke('maestro.workspace.read', { path: 'docs/a.txt' })
			).resolves.toEqual({ text: 'ok' });
		}
		await expect(broker.invoke('maestro.workspace.read', { path: 'docs/a.txt' })).rejects.toThrow(
			'rate limit'
		);
	});

	it('rejects traversal, reparse paths, over-limit output, and concurrent/rate-raced calls', async () => {
		const { broker } = await toolBroker(
			new Map([[path.join(testWorkspace, 'docs', 'a.txt'), 'x'.repeat(256 * 1024 + 1)]])
		);
		await expect(broker.invoke('maestro.workspace.read', { path: '../secret' })).rejects.toThrow(
			'unavailable'
		);
		await expect(broker.invoke('maestro.workspace.read', { path: 'docs/a.txt' })).rejects.toThrow(
			'limit'
		);
		let reparse = false;
		const reparseRoots = roots(() => reparse);
		await reparseRoots.requestWorkspaceRoot();
		reparse = true;
		await expect(reparseRoots.requestWorkspaceRoot()).rejects.toThrow('reparse point');
	});

	it('uses opaque single-use PKCE transactions and rejects foreign origin, callback, state, replay, and revocation', async () => {
		const opened: string[] = [];
		const exchanged: Array<{ verifier: string; code: string }> = [];
		const router = new OmpAuthCallbackPkceRouter({
			providers: [{ id: 'github', authorizationEndpoint: 'https://login.example.test/authorize' }],
			allowedOrigins: new Set(['https://login.example.test']),
			openAuthorization: async (url) => {
				opened.push(url);
			},
			exchangeCode: async (_provider, code, verifier) => {
				exchanged.push({ code, verifier });
			},
			random: (() => {
				let index = 0;
				const values = ['t'.repeat(64), 's'.repeat(64), 'v'.repeat(64)];
				return () => values[index++] ?? 'z'.repeat(64);
			})(),
			clock: () => 1_000,
		});
		const begun = await router.begin('github');
		expect(begun).toEqual({ transactionId: expect.any(String), phase: 'pending' });
		expect(opened[0]).toContain('code_challenge=');
		const state = new URL(opened[0]).searchParams.get('state');
		if (!state) throw new Error('native authorization URL is missing state');
		await expect(
			router.handleCallback(`maestro://wrong/callback/${begun.transactionId}?code=x&state=${state}`)
		).rejects.toThrow('unavailable');
		await expect(
			router.handleCallback(`maestro://omp-auth/callback/${begun.transactionId}?code=x&state=wrong`)
		).rejects.toThrow('unavailable');
		await expect(
			router.handleCallback(
				`maestro://omp-auth/callback/${begun.transactionId}?code=x&state=${state}`
			)
		).resolves.toEqual({ transactionId: begun.transactionId, phase: 'completed' });
		expect(exchanged).toHaveLength(1);
		expect(JSON.stringify(begun)).not.toContain(state);
		await expect(
			router.handleCallback(
				`maestro://omp-auth/callback/${begun.transactionId}?code=x&state=${state}`
			)
		).rejects.toThrow('unavailable');
		router.revoke();
	});

	it('keeps URI catalog empty and makes every URI request unavailable', async () => {
		const broker = new OmpUriBroker();
		expect(broker.catalog()).toEqual([]);
		await expect(broker.resolve('https://example.test')).rejects.toThrow('unavailable');
	});

	it('exports only host-owned opaque HTML through native directory selection without paths, HTML, overwrite, or traversal', async () => {
		const writes: Record<string, string> = {};
		const filesystem: OmpExportFilesystem = {
			lstat: async (value) => {
				if (value === testExports) return { isDirectory: () => true, isSymbolicLink: () => false };
				throw Object.assign(new Error('missing'), { code: 'ENOENT' });
			},
			realpath: async (value) => value,
			writeFile: async (value, content) => {
				writes[value] = content.toString();
			},
			link: async (from, to) => {
				if (writes[to] !== undefined) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
				writes[to] = writes[from];
			},
			unlink: async (value) => {
				delete writes[value];
			},
		};
		const broker = new OmpNativeExportBroker({
			chooseDirectory: async () => testExports,
			filesystem,
			random: () => 'temp',
		});
		const handle = broker.registerHtml('<main>secret HTML</main>');
		expect(Object.keys(handle as object)).toEqual([]);
		await expect(broker.export(handle, '../../report')).resolves.toEqual({ phase: 'completed' });
		expect(writes[path.join(testExports, 'report.html')]).toBe('<main>secret HTML</main>');
		await expect(broker.export(handle, 'report')).resolves.toEqual({ phase: 'failed' });
		expect(JSON.stringify(await broker.export(handle, 'other'))).not.toContain('secret HTML');
		const cancelling = new OmpNativeExportBroker({
			chooseDirectory: async () => null,
			filesystem,
			random: () => 'temp',
		});
		await expect(
			cancelling.export(cancelling.registerHtml('private'), 'cancelled')
		).resolves.toEqual({
			phase: 'cancelled',
		});
		broker.revoke();
		await expect(broker.export(handle, 'again')).rejects.toThrow('unavailable');
	});
});
