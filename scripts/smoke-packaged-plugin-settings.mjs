/**
 * Check the actual packaged Extensions UI with an isolated disabled Relay copy.
 * Usage: xvfb-run -a node scripts/smoke-packaged-plugin-settings.mjs release/linux-unpacked /path/to/relay/install
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { _electron as electron } from '@playwright/test';

if (!process.argv[2] || !process.argv[3]) {
	console.error(
		'Usage: node scripts/smoke-packaged-plugin-settings.mjs <package-root> <relay-install-dir>'
	);
	process.exit(2);
}
const packageRoot = path.resolve(process.argv[2]);
const relaySource = path.resolve(process.argv[3]);
const executablePath = path.join(packageRoot, 'maestro');
if (
	!fs.existsSync(executablePath) ||
	!fs.existsSync(path.join(packageRoot, 'resources', 'app.asar'))
) {
	throw new Error('Expected an unpacked Linux Maestro package');
}
const manifest = JSON.parse(fs.readFileSync(path.join(relaySource, 'plugin.json'), 'utf8'));
const signature = JSON.parse(fs.readFileSync(path.join(relaySource, 'signature.json'), 'utf8'));
assert.equal(manifest.id, 'sh.maestro.relay');

// Keep every app store and browser cache under this checkout. The installed
// production plugin and authorization ledger are never opened by this test.
const demoDir = fs.mkdtempSync(path.join(process.cwd(), '.packaged-plugin-settings-'));
const pluginDir = path.join(demoDir, 'plugins', manifest.id);
fs.mkdirSync(path.dirname(pluginDir), { recursive: true });
fs.cpSync(relaySource, pluginDir, { recursive: true });
fs.writeFileSync(
	path.join(demoDir, 'maestro-settings.json'),
	JSON.stringify({
		encoreFeatures: { plugins: true },
		pluginTrustedKeys: [signature.publicKey],
		suppressWindowsWarning: true,
		typographyPromptSeen: true,
		themePromptSeen: true,
		updatesPromptSeen: true,
		agentPowersPromptSeen: true,
	})
);
fs.writeFileSync(
	path.join(demoDir, 'pianola-plugins.json'),
	JSON.stringify({ schemaVersion: 1, plugins: { [manifest.id]: { enabled: false } } })
);
const plainDir = path.join(demoDir, 'plugins', 'maestro.e2e.plain');
fs.mkdirSync(plainDir);
fs.writeFileSync(
	path.join(plainDir, 'plugin.json'),
	JSON.stringify({
		id: 'maestro.e2e.plain',
		name: 'Plain Test Plugin',
		version: '1.0.0',
		tier: 0,
		maestro: { minHostApi: '1.0.0' },
	})
);
const invalidDir = path.join(demoDir, 'plugins', 'maestro.e2e.invalid');
fs.mkdirSync(invalidDir);
fs.writeFileSync(
	path.join(invalidDir, 'plugin.json'),
	JSON.stringify({
		id: 'maestro.e2e.invalid',
		name: 'Invalid Test Plugin',
		version: '1.0.0',
		tier: 1,
		maestro: { minHostApi: '1.0.0' },
		entry: '../outside.js',
		contributes: {
			panels: [
				{ id: 'config', title: 'Invalid panel', entry: 'panel.html', placement: 'settings' },
			],
		},
	})
);

let app;
let page;
try {
	app = await electron.launch({
		executablePath,
		args: ['--no-sandbox'],
		env: {
			...process.env,
			MAESTRO_DEMO_DIR: demoDir,
			MAESTRO_DATA_DIR: demoDir,
			XDG_CONFIG_HOME: demoDir,
			XDG_CACHE_HOME: demoDir,
			ELECTRON_DISABLE_GPU: '1',
			NODE_ENV: 'test',
			MAESTRO_E2E_TEST: 'true',
		},
		timeout: 60_000,
	});
	page = await app.firstWindow();
	await page.waitForLoadState('domcontentloaded');
	const relay = await page.evaluate(async (id) => {
		const snapshot = await window.maestro.plugins.list();
		return snapshot.plugins.find((plugin) => plugin.id === id);
	}, manifest.id);
	assert.equal(relay?.loadStatus, 'ok');
	assert.equal(relay?.enabled, false);
	assert.equal(relay?.signature?.status, 'trusted');

	for (let attempt = 0; attempt < 20; attempt++) {
		await page.evaluate(() => {
			window.dispatchEvent(
				new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true })
			);
		});
		if ((await page.locator('[aria-label="Settings"]').count()) > 0) break;
		await page.waitForTimeout(250);
	}
	await page.locator('button[title="Plugins"]').click();
	const view = page.locator('[data-testid="extensions-view"]');
	await view.locator(`[data-testid="extension-card"][data-extension-id="${manifest.id}"]`).click();
	const details = view.locator('[data-testid="extension-details"]');
	await details.locator('[data-testid="extension-subtab-settings"]').waitFor();
	assert.match(
		await details.locator('[data-testid="extension-plugin-settings-status"]').innerText(),
		/Select Enable to review permissions for this version/
	);
	assert.equal(await details.locator('webview').count(), 0);
	assert.equal(await page.locator('webview').count(), 0);

	await view.locator('[data-testid="extensions-back"]').click();
	await view
		.locator('[data-testid="extension-card"][data-extension-id="maestro.e2e.plain"]')
		.click();
	assert.equal(await view.locator('[data-testid="extension-subtab-settings"]').count(), 0);
	assert.equal(await page.locator('webview').count(), 0);
	await view.locator('[data-testid="extensions-back"]').click();
	await view
		.locator('[data-testid="extension-card"][data-extension-id="maestro.e2e.invalid"]')
		.click();
	assert.equal(await view.locator('[data-testid="extension-subtab-settings"]').count(), 0);
	assert.equal(await page.locator('webview').count(), 0);
	console.log(
		'PASS: packaged UI shows disabled trusted Relay Settings/status, mounts no panel, and hides Settings for settings-less and invalid plugins'
	);
} catch (error) {
	if (page) {
		console.error('Visible text:', (await page.locator('body').innerText()).slice(0, 1200));
		console.error(
			'Button titles:',
			await page.locator('button').evaluateAll((buttons) =>
				buttons
					.map((button) => button.title)
					.filter(Boolean)
					.slice(0, 30)
			)
		);
	}
	throw error;
} finally {
	await app?.close();
	fs.rmSync(demoDir, { recursive: true, force: true });
}
