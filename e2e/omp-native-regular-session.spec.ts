import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchNativeOmpRegularSessionHarness } from './fixtures/omp-native-regular-session-harness';

test.describe('first-party OMP regular session', () => {
	test('starts through the injected verified native gate while plugins are disabled', async ({
		browserName: _browserName,
	}, testInfo) => {
		void _browserName;
		test.setTimeout(180_000);
		const harness = await launchNativeOmpRegularSessionHarness();
		const { launched } = harness;
		try {
			await expect(launched.window.getByRole('button', { name: 'New Agent' })).toBeVisible({
				timeout: 45_000,
			});
			await launched.window.getByRole('button', { name: 'New Agent' }).click();
			await expect(launched.window.getByRole('dialog')).toBeVisible();
			await launched.window.getByText('Manual Setup', { exact: true }).click();
			await launched.window.getByText('Oh My Pi', { exact: true }).click();
			await launched.window.locator('input').first().fill('Native OMP fixture');
			await launched.window.locator('input[placeholder="Select directory..."]').fill(process.cwd());
			await launched.window.getByRole('button', { name: 'Create Agent' }).click();
			await expect(
				launched.window.getByText('Native OMP fixture', { exact: true }).first()
			).toBeVisible({ timeout: 30_000 });
			await expect(launched.window.getByRole('dialog')).toHaveCount(0);
			const composer = launched.window.locator('textarea').last();
			await expect(composer).toBeVisible();
			await composer.fill('show ordinary native transcript');
			await composer.press('Enter');
			await expect(launched.window.getByText(/native text:/).first()).toBeVisible({
				timeout: 30_000,
			});
			const approvalDialog = launched.window
				.locator('[role="dialog"]')
				.filter({ hasText: 'Native OMP approval' });
			await expect(approvalDialog).toHaveCount(1, { timeout: 30_000 });
			await expect(approvalDialog).toBeVisible({ timeout: 30_000 });
			await expect(approvalDialog).toContainText('omp', { timeout: 30_000 });
			const approvalButton = approvalDialog.getByRole('button', {
				name: 'Approve',
				exact: true,
			});
			await approvalButton.click();
			const frameLogPath = path.join(path.dirname(harness.fixture.runtimePath), 'frames.jsonl');
			const artifactPrefix = testInfo.outputPath('omp-native-before-close');
			fs.writeFileSync(`${artifactPrefix}.dom.html`, await launched.window.content(), 'utf8');
			fs.writeFileSync(
				`${artifactPrefix}.frames.jsonl`,
				fs.readFileSync(frameLogPath, 'utf8'),
				'utf8'
			);
			fs.writeFileSync(`${artifactPrefix}.main.txt`, launched.output(), 'utf8');
			await expect
				.poll(
					() => fs.readFileSync(frameLogPath, 'utf8').includes('"type":"extension_ui_response"'),
					{
						timeout: 10_000,
					}
				)
				.toBe(true);
			await expect(launched.window.getByText('native expanded complete')).toBeVisible();
			await expect(approvalDialog).toHaveCount(0);
			await expect(composer).toBeEditable({ timeout: 30_000 });
			await composer.fill('second native prompt after agent_end');
			await composer.press('Enter');
			await expect(approvalDialog).toBeVisible({ timeout: 30_000 });
			await approvalDialog.getByRole('button', { name: 'Approve', exact: true }).click();
			await expect(
				launched.window.getByText(
					/native text: second native prompt after agent_endnative expanded complete/
				)
			).toBeVisible({ timeout: 30_000 });
			await expect(composer).toBeEditable({ timeout: 30_000 });
			await expect
				.poll(
					() =>
						fs
							.readFileSync(frameLogPath, 'utf8')
							.includes('"message":"second native prompt after agent_end"'),
					{ timeout: 10_000 }
				)
				.toBe(true);
			const frames = fs.readFileSync(frameLogPath, 'utf8');
			expect(frames).toContain('"type":"message_update"');
			expect(frames).toContain('"type":"turn_end"');
			expect(frames).toContain('"type":"agent_end"');
			await expect(launched.window.locator('webview')).toHaveCount(0);
			expect(launched.output()).not.toMatch(/legacy.*fallback|fallback.*legacy/i);
			await launched.window.screenshot({
				path: testInfo.outputPath('omp-native-regular-session.png'),
			});
		} finally {
			const mainOutput = launched.output();
			fs.writeFileSync(testInfo.outputPath('omp-native-main-output.txt'), mainOutput);
			await testInfo.attach('omp-native-main-output.txt', {
				body: mainOutput,
				contentType: 'text/plain',
			});
			const rendererDom = await launched.window
				.locator('body')
				.innerText({ timeout: 1_000 })
				.catch((error) => `renderer DOM unavailable: ${String(error)}`);
			fs.writeFileSync(testInfo.outputPath('omp-native-renderer-dom.txt'), rendererDom);
			const frameLogPath = path.join(path.dirname(harness.fixture.runtimePath), 'frames.jsonl');
			const fixtureFrames = fs.existsSync(frameLogPath)
				? fs.readFileSync(frameLogPath, 'utf8')
				: '(fixture did not start)';
			fs.writeFileSync(testInfo.outputPath('omp-native-frames.jsonl'), fixtureFrames);
			await testInfo.attach('omp-native-frames.jsonl', {
				body: fixtureFrames,
				contentType: 'application/x-ndjson',
			});
			await harness.close();
		}
	});
});
