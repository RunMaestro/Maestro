import { _electron as electron } from '@playwright/test';
import fs from 'fs/promises';
import path from 'path';

const repoRoot = process.cwd();
const outputDir = path.join(repoRoot, 'dogfood-output/remote-session-mobile-20260312');
const screenshotDir = path.join(outputDir, 'screenshots');
const runtimeDataDir = path.join(outputDir, 'runtime-data');
const statePath = path.join(outputDir, 'desktop-runtime.json');
const screenshotPath = path.join(screenshotDir, 'desktop-live-overlay.png');
const appPath = path.join(repoRoot, 'dist/main/index.js');
const workingDir = process.env.MAESTRO_WORKDIR || repoRoot;
const agentName = process.env.MAESTRO_AGENT_NAME || `Remote UX Audit ${Date.now()}`;

let app;

async function ensureDirs() {
	await fs.mkdir(screenshotDir, { recursive: true });
	await fs.mkdir(runtimeDataDir, { recursive: true });
}

async function writeState(patch) {
	let current = {};
	try {
		current = JSON.parse(await fs.readFile(statePath, 'utf8'));
	} catch {
		current = {};
	}

	const next = {
		...current,
		...patch,
		updatedAt: new Date().toISOString(),
	};

	await fs.writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

async function closeInterstitials(page) {
	const dismissButtons = [
		page.getByRole('button', { name: /^Skip$/i }),
		page.getByRole('button', { name: /^Close$/i }),
		page.getByRole('button', { name: /^Got it$/i }),
	];

	for (const button of dismissButtons) {
		if (await button.isVisible().catch(() => false)) {
			await button.click().catch(() => {});
		}
	}
}

async function launchApp() {
	app = await electron.launch({
		args: [appPath],
		env: {
			...process.env,
			MAESTRO_DATA_DIR: runtimeDataDir,
			ELECTRON_DISABLE_GPU: '1',
		},
		timeout: 60000,
	});

	const page = await app.firstWindow();
	await page.waitForLoadState('domcontentloaded');
	await page.waitForTimeout(2000);
	await closeInterstitials(page);

	return page;
}

async function openNewAgentModal(page) {
	await page.keyboard.press('Meta+N');
	const heading = page.getByText('Create New Agent', { exact: true });
	await heading.waitFor({ state: 'visible', timeout: 15000 });
	return heading;
}

async function createCodexAgent(page) {
	await openNewAgentModal(page);

	const nameInput = page.getByLabel('Agent Name');
	await nameInput.fill(agentName);

	const codexOption = page.getByRole('option', { name: /Codex/i }).first();
	await codexOption.waitFor({ state: 'visible', timeout: 15000 });
	await codexOption.click();

	const dirInput = page.getByLabel('Working Directory');
	await dirInput.fill(workingDir);

	const riskCheckbox = page.getByLabel('I understand the risk and want to proceed');
	if (await riskCheckbox.isVisible().catch(() => false)) {
		await riskCheckbox.check();
	}

	const createButton = page.getByRole('button', { name: 'Create Agent' }).last();
	await createButton.waitFor({ state: 'visible', timeout: 15000 });
	await createButton.click();

	await page.getByText('Create New Agent', { exact: true }).waitFor({
		state: 'hidden',
		timeout: 30000,
	});

	await page.getByText(agentName, { exact: false }).first().waitFor({
		state: 'visible',
		timeout: 30000,
	});
}

async function openLiveOverlay(page) {
	const toggle = page.getByRole('button', { name: /^(LIVE|OFFLINE)$/i }).first();
	await toggle.waitFor({ state: 'visible', timeout: 20000 });
	await toggle.click();
	await page.getByText('Remote Control', { exact: true }).waitFor({
		state: 'visible',
		timeout: 20000,
	});
}

async function enableRemoteControl(page) {
	const remoteToggle = page.locator(
		'button[title="Enable remote control"], button[title="Disable remote control"]'
	);
	await remoteToggle.first().waitFor({ state: 'visible', timeout: 20000 });
	const title = await remoteToggle.first().getAttribute('title');
	if (title === 'Enable remote control') {
		await remoteToggle.first().click();
	}

	// Required by the user: wait 30 seconds after enabling remote access.
	await page.waitForTimeout(30000);

	await page
		.locator('[title*="trycloudflare.com"]')
		.first()
		.waitFor({ state: 'visible', timeout: 30000 });
}

async function readUrls(page) {
	const localUrl = await page.evaluate(() => window.maestro.live.getDashboardUrl());
	const remoteUrl = await page
		.locator('[title*="trycloudflare.com"]')
		.first()
		.getAttribute('title');
	return { localUrl, remoteUrl };
}

async function heartbeat(page) {
	while (true) {
		const url = page.url();
		await writeState({ heartbeatUrl: url, heartbeatAt: new Date().toISOString() });
		await new Promise((resolve) => setTimeout(resolve, 5000));
	}
}

async function main() {
	await ensureDirs();
	await writeState({
		status: 'starting',
		agentName,
		workingDir,
		appPath,
		runtimeDataDir,
	});

	const page = await launchApp();
	await writeState({ status: 'app-launched' });

	await createCodexAgent(page);
	await writeState({ status: 'agent-created' });

	await openLiveOverlay(page);
	await writeState({ status: 'live-overlay-open' });

	await enableRemoteControl(page);
	const { localUrl, remoteUrl } = await readUrls(page);

	await page.screenshot({ path: screenshotPath, fullPage: true });

	await writeState({
		status: 'ready',
		localUrl,
		remoteUrl,
		screenshotPath,
	});

	console.log(`[desktop-setup] agentName=${agentName}`);
	console.log(`[desktop-setup] localUrl=${localUrl}`);
	console.log(`[desktop-setup] remoteUrl=${remoteUrl}`);
	console.log(`[desktop-setup] screenshot=${screenshotPath}`);

	await heartbeat(page);
}

async function cleanup(exitCode = 0) {
	if (app) {
		await app.close().catch(() => {});
	}
	process.exit(exitCode);
}

process.on('SIGINT', () => void cleanup(0));
process.on('SIGTERM', () => void cleanup(0));

main().catch(async (error) => {
	await writeState({
		status: 'error',
		error: error instanceof Error ? error.stack || error.message : String(error),
	});
	console.error('[desktop-setup] failed', error);
	await cleanup(1);
});
