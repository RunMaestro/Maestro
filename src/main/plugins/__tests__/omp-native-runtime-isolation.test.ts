import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

import { OmpRuntimeProfileService } from '../omp-runtime-profile';

const nativeOmp =
	process.env.OMP_NATIVE_BINARY ?? join(process.env.LOCALAPPDATA ?? '', 'omp', 'omp.exe');

/**
 * This is intentionally a real 16.4.8 smoke test, not a mock protocol test.
 * It is skipped only where the managed/native binary is unavailable.
 */
describe('native OMP sterile RPC startup', () => {
	it.runIf(existsSync(nativeOmp))(
		'reaches ready without a workspace, prompt, or inherited profile',
		async () => {
			const profile = await new OmpRuntimeProfileService().prepareForLaunch();
			const child = spawn(
				nativeOmp,
				[
					'--mode',
					'rpc',
					'--profile',
					profile.profile,
					'--cwd',
					profile.sterileCwd,
					'--config',
					profile.config,
					'--no-session',
					'--no-tools',
					'--no-extensions',
					'--no-skills',
					'--no-rules',
					'--no-lsp',
					'--no-pty',
					'--no-title',
					'--model',
					profile.model,
				],
				{ cwd: profile.sterileCwd, env: profile.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }
			);
			let output = '';
			child.stdout.on('data', (chunk: Uint8Array) => {
				output += Buffer.from(chunk).toString('utf8');
			});
			// External native-process readiness is inherently clock-bound; the timeout prevents a hung binary from blocking CI.
			const ready = new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error('native OMP RPC did not reach ready')),
					25_000
				);
				child.once('error', reject);
				const onData = () => {
					if (!output.includes('{"type":"ready"}')) return;
					clearTimeout(timeout);
					child.stdout.off('data', onData);
					resolve();
				};
				child.stdout.on('data', onData);
			});
			try {
				await ready;
				expect(output).toContain('{"type":"ready"}');
			} finally {
				child.kill();
				await once(child, 'exit').catch(() => undefined);
			}
		},
		30_000
	);
});
