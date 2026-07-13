import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
	OmpProviderCredentialStore,
	type OmpCredentialSettingsStore,
	type OmpSafeStorage,
} from '../../../main/plugins/omp-provider-credential-store';

const runFile = promisify(execFile);
const liveSmokeEnabled = process.env.MAESTRO_OMP_LIVE_SMOKE === '1';

class LiveSmokeSettings implements OmpCredentialSettingsStore {
	constructor(private readonly values: Record<string, unknown>) {}

	get<T>(key: string, defaultValue?: T): T {
		return (key in this.values ? this.values[key] : defaultValue) as T;
	}

	set(): void {
		throw new Error('Live smoke does not persist credentials');
	}
}

const passThroughSafeStorage: OmpSafeStorage = {
	isEncryptionAvailable: () => true,
	encryptString: (value) => Buffer.from(value, 'utf8'),
	decryptString: (value) => value.toString('utf8'),
};

describe('real OMP credential smoke', () => {
	it.runIf(liveSmokeEnabled)(
		'runs a sterile real OMP prompt only with a dedicated explicit test key',
		async () => {
			const apiKey = process.env.MAESTRO_OMP_LIVE_SMOKE_API_KEY;
			const provider = process.env.MAESTRO_OMP_LIVE_SMOKE_PROVIDER ?? 'anthropic';
			const model = process.env.MAESTRO_OMP_LIVE_SMOKE_MODEL;
			if (!apiKey)
				throw new Error('MAESTRO_OMP_LIVE_SMOKE_API_KEY is required for the opt-in smoke');

			const auth = new OmpProviderCredentialStore(
				new LiveSmokeSettings({ llmProvider: provider, modelSlug: model, apiKey }),
				passThroughSafeStorage
			).resolveForPrompt(model);
			expect(auth.status).toBe('ready');

			const sterileHome = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-omp-live-smoke-'));
			try {
				await runFile(
					'omp',
					[
						'-p',
						'--mode',
						'json',
						'--tools',
						'read',
						'--',
						'Reply with exactly: maestro-omp-smoke',
					],
					{
						cwd: sterileHome,
						timeout: 60_000,
						maxBuffer: 1024 * 1024,
						windowsHide: true,
						env: {
							PATH: process.env.PATH ?? '',
							HOME: sterileHome,
							USERPROFILE: sterileHome,
							APPDATA: sterileHome,
							LOCALAPPDATA: sterileHome,
							XDG_CONFIG_HOME: sterileHome,
							XDG_DATA_HOME: sterileHome,
							OMP_CONFIG_DIR: sterileHome,
							NO_COLOR: '1',
							...auth.authEnvironment.toChildEnvironment(),
						},
					}
				);
			} catch {
				throw new Error('Dedicated OMP live smoke failed');
			} finally {
				fs.rmSync(sterileHome, { recursive: true, force: true });
			}
		},
		75_000
	);
});
