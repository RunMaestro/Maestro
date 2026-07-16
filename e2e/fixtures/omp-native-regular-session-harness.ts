import { _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
	cleanup,
	createSeededEnv,
	launch,
	type LaunchedApp,
	type SeededEnv,
} from './plugin-harness';
import { createExpandedNativeFixture, type ExpandedFixture } from './omp-native-expanded-fixture';

const INJECTED_ELECTRON_MAIN = path.join(__dirname, 'omp-native-electron-main.cjs');
export interface NativeOmpRegularSessionHarness {
	readonly seeded: SeededEnv;
	readonly fixture: ExpandedFixture;
	readonly launched: LaunchedApp;
	close(): Promise<void>;
}

const MAX_MAIN_OUTPUT_BYTES = 512 * 1024;

function appendMainOutput(current: string, chunk: Buffer): string {
	if (current.length >= MAX_MAIN_OUTPUT_BYTES) return current;
	const text = chunk.toString();
	const bounded =
		text.length > 16 * 1024
			? `${text.slice(0, 16 * 1024)}\n[truncated main-process chunk]\n`
			: text;
	return current + bounded.slice(0, MAX_MAIN_OUTPUT_BYTES - current.length);
}

async function launchNative(env: NodeJS.ProcessEnv): Promise<LaunchedApp> {
	let app: ElectronApplication | undefined;
	let output = '';
	try {
		app = await electron.launch({
			args: [INJECTED_ELECTRON_MAIN],
			env,
			timeout: 60_000,
		});
		app.process().stdout?.on('data', (chunk: Buffer) => {
			output = appendMainOutput(output, chunk);
		});
		app.process().stderr?.on('data', (chunk: Buffer) => {
			output = appendMainOutput(output, chunk);
		});
		const window = await app.firstWindow({ timeout: 30_000 });
		await window.waitForLoadState('domcontentloaded');
		return { app, window, output: () => output };
	} catch (error) {
		await app?.close().catch(() => undefined);
		const detail = output.trim() || '(no Electron main-process output captured)';
		throw new Error(
			`Native OMP Electron startup failed before a window was available:\n${detail}`,
			{ cause: error }
		);
	}
}
/** Test-only composition root: production startup receives a signed, exact 16.4.8
 * fixture and verified RuntimeLaunch via its public dependency seam. */
export async function launchNativeOmpRegularSessionHarness(): Promise<NativeOmpRegularSessionHarness> {
	const seeded = createSeededEnv();
	let launched: LaunchedApp | undefined;
	try {
		const bootstrap = await launch(seeded.env);
		await bootstrap.app.close();
		const settingsPath = path.join(seeded.demoDir, 'maestro-settings.json');
		const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
		settings.encoreFeatures = {
			...(settings.encoreFeatures as Record<string, unknown>),
			plugins: true,
		};
		settings.suppressWindowsWarning = true;
		fs.writeFileSync(settingsPath, JSON.stringify(settings, null, '\t'), 'utf8');
		const fixture = await createExpandedNativeFixture(seeded.demoDir);
		Object.assign(seeded.env, {
			MAESTRO_E2E_OMP_ARCHIVE_PATH: fixture.artifactPath,
			MAESTRO_E2E_OMP_ARCHIVE_SHA256: fixture.sha256,
			MAESTRO_E2E_OMP_RUNTIME_PATH: fixture.runtimePath,
			MAESTRO_E2E_OMP_BUN_PATH: process.execPath,
			MAESTRO_E2E_OMP_TRUST_ROOT: JSON.stringify(fixture.trustRoot),
			OMP_NATIVE_FIXTURE_LOG: path.join(seeded.demoDir, 'native-expanded', 'frames.jsonl'),
		});
		launched = await launchNative(seeded.env);
		const windowsNotice = launched.window.getByRole('button', { name: 'Got it!' });
		await windowsNotice
			.waitFor({ state: 'visible', timeout: 10_000 })
			.then(async () => {
				await windowsNotice.evaluate((button) => (button as HTMLButtonElement).click());
				await windowsNotice.waitFor({ state: 'hidden', timeout: 10_000 });
			})
			.catch(() => undefined);
		await approveOmpConsent(launched);
		await launched.window.waitForFunction(
			() => document.getElementById('initial-splash') === null,
			undefined,
			{ timeout: 20_000 }
		);
		return {
			seeded,
			fixture,
			launched,
			close: async () => {
				try {
					const appProcess = launched!.app.process();
					await Promise.race([
						launched!.app.evaluate(({ app }) => app.quit()).catch(() => undefined),
						new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
					]);
					const closed = await Promise.race([
						launched!.app
							.close()
							.then(() => true)
							.catch(() => false),
						new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
					]);
					if (!closed || !appProcess.killed) appProcess.kill('SIGKILL');
				} finally {
					cleanup(seeded);
				}
			},
		};
	} catch (error) {
		try {
			if (launched) {
				await launched.app.evaluate(({ app }) => app.quit()).catch(() => undefined);
				await launched.app.close();
			}
		} finally {
			cleanup(seeded);
		}
		throw error;
	}
}

async function approveOmpConsent(launched: LaunchedApp): Promise<void> {
	const consentPromise = launched.app.waitForEvent('window', { timeout: 30_000 });
	await launched.window.evaluate(
		(pluginId) => window.maestro.plugins.requestConsent(pluginId),
		'com.maestro.omp'
	);
	const consent = await consentPromise;
	await consent.waitForLoadState('domcontentloaded');
	await consent.locator('button.btn-approve').waitFor({ state: 'visible', timeout: 15_000 });
	await consent.locator('.cap-check-high-risk[data-cap="process:interactive"]').check();
	await consent.locator('button.btn-approve').click();
	await consent.waitForEvent('close', { timeout: 15_000 }).catch(() => undefined);
}
