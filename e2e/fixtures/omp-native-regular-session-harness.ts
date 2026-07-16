import fs from 'node:fs';
import path from 'node:path';
import {
	cleanup,
	createSeededEnv,
	launch,
	type LaunchedApp,
	type SeededEnv,
} from './plugin-harness';
import { createBundledOmpFixture, type OmpFixture } from './omp-fixture';

const INJECTED_ELECTRON_MAIN = path.join(__dirname, 'omp-native-electron-main.cjs');
export interface NativeOmpRegularSessionHarness {
	readonly seeded: SeededEnv;
	readonly fixture: OmpFixture;
	readonly launched: LaunchedApp;
	close(): Promise<void>;
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
			plugins: false,
		};
		settings.suppressWindowsWarning = true;
		fs.writeFileSync(settingsPath, JSON.stringify(settings, null, '\t'), 'utf8');
		const fixture = await createBundledOmpFixture(seeded.demoDir);
		Object.assign(seeded.env, {
			MAESTRO_E2E_OMP_ARCHIVE_PATH: fixture.artifactPath,
			MAESTRO_E2E_OMP_ARCHIVE_SHA256: fixture.sha256,
			MAESTRO_E2E_OMP_RUNTIME_PATH: fixture.runtimePath,
			MAESTRO_E2E_OMP_BUN_PATH: process.execPath,
			MAESTRO_E2E_OMP_TRUST_ROOT: JSON.stringify(fixture.trustRoot),
		});
		launched = await launch(seeded.env, INJECTED_ELECTRON_MAIN);
		const windowsNotice = launched.window.getByRole('button', { name: 'Got it!' });
		if (await windowsNotice.isVisible().catch(() => false)) await windowsNotice.click();
		return {
			seeded,
			fixture,
			launched,
			close: async () => {
				await launched!.app.close();
				cleanup(seeded);
			},
		};
	} catch (error) {
		if (launched) await launched.app.close();
		cleanup(seeded);
		throw error;
	}
}
