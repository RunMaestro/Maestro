import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { createProductionOmpBootstrap } from '../src/main/plugins/production-omp-bootstrap';
import { parsePluginArtifact } from '../src/main/omp-distribution/plugin-artifact';
import {
	createOmpFixture,
	installOmpFixture,
	readFixtureJsonl,
	verifyOmpFixtureArtifact,
	runOmpFixtureProtocol,
} from './fixtures/omp-fixture';
test.describe('OMP signed fixture artifact', () => {
	test('creates a deterministic signed 16.4.8 artifact whose installed files match its archive bytes', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-omp-e2e-artifact-'));
		try {
			const fixture = createOmpFixture(root);
			const archive = fs.readFileSync(fixture.artifactPath);

			expect(fixture.sha256).toBe(createHash('sha256').update(archive).digest('hex'));
			expect(verifyOmpFixtureArtifact(fixture)).toEqual({ valid: true });
			const installedPlugin = installOmpFixture(fixture);
			expect(readFixtureJsonl(fixture.logPath)).toEqual([]);
			expect(fs.readFileSync(fixture.runtimePath, 'utf8')).toContain('ready');
			expect(fs.readFileSync(path.join(installedPlugin, 'index.js'), 'utf8')).toBe(
				"export const fixtureRuntime = '16.4.8';\n"
			);
			for (const file of parsePluginArtifact(archive, fixture.trustRoot).files) {
				expect(fs.readFileSync(path.join(installedPlugin, ...file.path.split('/')))).toEqual(
					Buffer.from(file.content, 'base64')
				);
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('scripts ready state models prompt approval steering abort retry and crash over JSONL', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-omp-e2e-runtime-'));
		try {
			const fixture = createOmpFixture(root);
			const normal = await runOmpFixtureProtocol(fixture, [
				{ command: 'get_state' },
				{ command: 'prompt', attachments: [{ name: 'fixture.txt' }] },
				{ command: 'approve', id: 'fixture-approval' },
				{ command: 'steer', prompt: 'stay focused' },
				{ command: 'abort' },
				{ command: 'retry' },
			]);
			expect(normal.exitCode).toBe(0);
			expect(normal.messages.map((message) => message.type)).toEqual(
				expect.arrayContaining([
					'ready',
					'state',
					'models',
					'stream',
					'tool',
					'approval',
					'complete',
					'aborted',
					'retry',
				])
			);
			expect(normal.messages.find((message) => message.type === 'tool')).toMatchObject({
				input: { attachmentCount: 1 },
			});

			const crashed = await runOmpFixtureProtocol(fixture, [{ command: 'crash' }]);
			expect(crashed.exitCode).toBe(86);
			expect(crashed.messages.at(-1)).toMatchObject({ type: 'crash', code: 'fixture_crash' });
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('rejects its fixture trust root from production bootstrap configuration', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-omp-e2e-production-rejection-'));
		try {
			const fixture = createOmpFixture(root);
			expect(() =>
				createProductionOmpBootstrap({
					pluginsDir: path.join(root, 'fixture-plugins'),
					archivePath: fixture.artifactPath,
					expectedArchiveSha256: fixture.sha256,
					trustRoot: fixture.trustRoot,
					verifySignature: () => true,
					pinnedRelease: Object.freeze({
						packageName: '@oh-my-pi/pi-coding-agent',
						version: '16.4.8',
						registryOrigin: 'https://registry.npmjs.org',
						npmKeyIds: Object.freeze(['fixture-npm-key']),
					}),
					resolver: {
						resolveSystem: async () => null,
						managedInstallAllowed: () => false,
						resolveManaged: async () => {
							throw new Error('not invoked');
						},
					},
					activation: () => null,
					chooseDirectory: async () => null,
				})
			).toThrow('production OMP trust root is invalid');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
