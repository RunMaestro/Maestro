import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { test, expect } from './fixtures/electron-app';

function runCli(testDataDir: string, ...args: string[]): string {
	const cliPath = path.join(__dirname, '../dist/cli/maestro-cli.js');
	return execFileSync(process.execPath, [cliPath, ...args], {
		cwd: path.join(__dirname, '..'),
		encoding: 'utf8',
		env: {
			...process.env,
			MAESTRO_DATA_DIR: testDataDir,
			MAESTRO_DEMO_DIR: testDataDir,
			MAESTRO_USER_DATA: testDataDir,
		},
	});
}

test('renders an interactive HTML Movement inside the main window', async ({
	electronApp,
	window,
	testDataDir,
}) => {
	const htmlPath = path.join(testDataDir, 'concerto-smoke.html');
	fs.writeFileSync(
		htmlPath,
		`<!doctype html>
		<html>
			<head><style>body { background: #10131f; color: white; }</style></head>
			<body>
				<button id="increment">Count: <span id="count">0</span></button>
				<script>
					document.querySelector('#increment').addEventListener('click', () => {
						const count = document.querySelector('#count');
						count.textContent = String(Number(count.textContent) + 1);
					});
					console.log('mockup-ready');
				</script>
			</body>
		</html>`,
		'utf8'
	);

	runCli(testDataDir, 'settings', 'set', 'encoreFeatures.concerto', 'true');
	runCli(
		testDataDir,
		'movement',
		'add',
		'concerto-e2e',
		'--title',
		'Concerto E2E',
		'--html-file',
		htmlPath,
		'--width',
		'640',
		'--height',
		'480'
	);

	const iframe = window.getByTestId('concerto-html-iframe');
	await expect(iframe).toBeVisible();
	await expect(iframe).toHaveAttribute('src', /^maestro-concerto:\/\/render\//);

	const mockup = window.frameLocator('[data-testid="concerto-html-iframe"]');
	await expect(mockup.locator('#increment')).toBeVisible();

	const interaction = JSON.parse(
		runCli(testDataDir, 'movement', 'interact', 'concerto-e2e', '--click', '#increment', '--json')
	);
	expect(interaction.success).toBe(true);
	await expect(mockup.locator('#count')).toHaveText('1');

	const previewPath = path.join(testDataDir, 'concerto-preview.png');
	const inspection = JSON.parse(
		runCli(testDataDir, 'movement', 'inspect', 'concerto-e2e', '--output', previewPath, '--json')
	);
	expect(inspection.ready).toBe(true);
	expect(inspection.viewport.width).toBeGreaterThan(500);
	expect(inspection.viewport.height).toBeGreaterThan(300);
	expect(inspection.logs).toEqual(
		expect.arrayContaining([expect.objectContaining({ level: 'log', message: 'mockup-ready' })])
	);
	const png = fs.readFileSync(previewPath);
	expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
	expect(png.length).toBeGreaterThan(1000);
	expect(png.readUInt32BE(16)).toBe(inspection.image.width);
	expect(png.readUInt32BE(20)).toBe(inspection.image.height);
	expect(inspection.image.scaleFactor).toBeGreaterThanOrEqual(1);

	// Movements belong inside the existing Maestro window. Only Cadenza is
	// allowed to create a separate HUD window.
	expect(electronApp.windows()).toHaveLength(1);
});
