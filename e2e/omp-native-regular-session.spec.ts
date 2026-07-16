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
			await expect(approvalDialog).toHaveCount(0);
			await expect(
				launched.window.getByText('Native OMP fixture canvas', { exact: true }).first()
			).toBeVisible();
			await expect(composer).toHaveValue('native composer text');
			await expect(
				launched.window.getByText('Native OMP fixture ready', { exact: true })
			).toBeVisible();
			await expect(
				launched.window.getByText('fixture:expanded-16.4.8', { exact: true })
			).toBeVisible();
			await launched.window.getByRole('button', { name: 'Native', exact: true }).click();
			const runtimePanel = launched.window.getByTestId('native-runtime-panel');
			await expect(runtimePanel).toBeVisible();
			await expect(
				runtimePanel.getByText('Native fixture: Render ordinary session (in_progress)')
			).toBeVisible();
			await expect(runtimePanel.getByText('Native helper: running')).toBeVisible();
			await expect(runtimePanel.getByText('inputTokens: 21')).toBeVisible();
			await runtimePanel.getByRole('button', { name: 'View messages for Native helper' }).click();
			await expect(runtimePanel.getByText('Native helper detail', { exact: true })).toBeVisible();
			await runtimePanel
				.getByRole('button', { name: 'View branch messages for native expanded transcript' })
				.click();
			await expect(runtimePanel.getByText('Native branch detail', { exact: true })).toBeVisible();
			await runtimePanel
				.getByRole('button', { name: 'Branch from native expanded transcript' })
				.click();
			await runtimePanel
				.getByPlaceholder('OMP session file path')
				.fill('/fixture/resumed-native.jsonl');
			await runtimePanel.getByRole('button', { name: 'Resume', exact: true }).click();
			await runtimePanel.getByPlaceholder('Run OMP shell command').fill('echo native shell');
			await runtimePanel.getByRole('button', { name: 'Run', exact: true }).click();
			await launched.window
				.locator('select[aria-label="OMP login provider"]')
				.selectOption('fixture-login');
			await runtimePanel.getByRole('button', { name: 'Login', exact: true }).click();
			await launched.window.locator('select[aria-label="Thinking level"]').selectOption('max');
			await launched.window
				.locator('select[aria-label="Steering mode"]')
				.selectOption('one-at-a-time');
			await launched.window
				.locator('select[aria-label="Follow-up mode"]')
				.selectOption('one-at-a-time');
			await launched.window.locator('select[aria-label="Interrupt mode"]').selectOption('wait');
			const runtimeControls = launched.window.getByLabel('Native runtime controls');
			const compact = runtimeControls.getByRole('button', { name: 'Compact', exact: true });
			await compact.focus();
			await compact.press('Enter');
			const exportHtml = runtimeControls.getByRole('button', { name: 'Export HTML', exact: true });
			await exportHtml.focus();
			await exportHtml.press('Enter');
			const abortBash = runtimeControls.getByRole('button', {
				name: 'Abort shell command',
				exact: true,
			});
			await abortBash.focus();
			await abortBash.press('Enter');
			await expect
				.poll(
					() => {
						const frameText = fs.readFileSync(frameLogPath, 'utf8');
						return [
							'"type":"branch"',
							'"type":"switch_session"',
							'"type":"bash"',
							'"type":"login"',
							'"type":"get_subagent_messages","subagentId":"native-subagent"',
							'"type":"get_branch_messages","entryId":"native-message"',
							'"type":"set_thinking_level","level":"max"',
							'"type":"set_steering_mode","mode":"one-at-a-time"',
							'"type":"set_follow_up_mode","mode":"one-at-a-time"',
							'"type":"set_interrupt_mode","mode":"wait"',
							'"type":"compact"',
							'"type":"export_html"',
							'"type":"abort_bash"',
						].every((frame) => frameText.includes(frame));
					},
					{ timeout: 30_000 }
				)
				.toBe(true);
			await expect(launched.window.getByText('Session Resume Failed', { exact: true })).toHaveCount(
				0
			);
			await expect(composer).toBeEditable({ timeout: 30_000 });
			await composer.fill('second native prompt after agent_end no-approval');
			await composer.press('Enter');
			await expect(
				launched.window.getByText('native text: second native prompt after agent_end no-approval', {
					exact: true,
				})
			).toBeVisible({ timeout: 30_000 });
			await expect(
				launched.window.getByText('native expanded complete', { exact: true })
			).toHaveCount(0);
			await expect
				.poll(
					() =>
						fs
							.readFileSync(frameLogPath, 'utf8')
							.includes('"message":"second native prompt after agent_end no-approval"'),
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

	test('settles a local-only native prompt without synthetic agent terminal events', async ({
		browserName: _browserName,
	}) => {
		void _browserName;
		test.setTimeout(120_000);
		const harness = await launchNativeOmpRegularSessionHarness();
		const { launched } = harness;
		try {
			await launched.window.getByRole('button', { name: 'New Agent' }).click();
			await launched.window.getByText('Manual Setup', { exact: true }).click();
			await launched.window.getByText('Oh My Pi', { exact: true }).click();
			await launched.window.locator('input').first().fill('Native OMP local-only');
			await launched.window.locator('input[placeholder="Select directory..."]').fill(process.cwd());
			await launched.window.getByRole('button', { name: 'Create Agent' }).click();
			const composer = launched.window.locator('textarea').last();
			const frameLogPath = path.join(path.dirname(harness.fixture.runtimePath), 'frames.jsonl');
			await composer.fill('local-only native prompt');
			await composer.press('Enter');
			await expect(
				launched.window.getByText('native local-only output', { exact: true })
			).toBeVisible({ timeout: 30_000 });
			await expect(composer).toBeEditable({ timeout: 30_000 });
			await expect
				.poll(
					() => {
						const frames = fs.readFileSync(frameLogPath, 'utf8');
						return (
							frames.includes('"agentInvoked":false') &&
							(frames.match(/"type":"turn_end"/g) ?? []).length === 0 &&
							(frames.match(/"type":"agent_end"/g) ?? []).length === 0
						);
					},
					{ timeout: 10_000 }
				)
				.toBe(true);
		} finally {
			await harness.close();
		}
	});
	test('renders select and input native approval requests', async ({
		browserName: _browserName,
	}) => {
		void _browserName;
		test.setTimeout(180_000);
		const harness = await launchNativeOmpRegularSessionHarness();
		const { launched } = harness;
		try {
			await launched.window.getByRole('button', { name: 'New Agent' }).click();
			await launched.window.getByText('Manual Setup', { exact: true }).click();
			await launched.window.getByText('Oh My Pi', { exact: true }).click();
			await launched.window.locator('input').first().fill('Native OMP approvals');
			await launched.window.locator('input[placeholder="Select directory..."]').fill(process.cwd());
			await launched.window.getByRole('button', { name: 'Create Agent' }).click();
			const composer = launched.window.locator('textarea').last();
			const approvalDialog = launched.window
				.locator('[role="dialog"]')
				.filter({ hasText: 'Native OMP approval' });
			const frameLogPath = path.join(path.dirname(harness.fixture.runtimePath), 'frames.jsonl');

			await composer.fill('select-approval');
			await composer.press('Enter');
			await expect(approvalDialog.getByRole('button', { name: 'safe', exact: true })).toBeVisible({
				timeout: 30_000,
			});
			await approvalDialog.getByRole('button', { name: 'safe', exact: true }).click();
			await expect(approvalDialog).toHaveCount(0);
			await expect
				.poll(
					() => (fs.readFileSync(frameLogPath, 'utf8').match(/"type":"agent_end"/g) ?? []).length
				)
				.toBe(1);
			await expect(composer).toBeEditable({ timeout: 30_000 });

			await composer.fill('input-approval');
			await composer.press('Enter');
			await expect(
				approvalDialog.locator('input[placeholder="Write the native response"]')
			).toBeVisible({
				timeout: 30_000,
			});
			await approvalDialog.getByPlaceholder('Write the native response').fill('typed native input');
			await approvalDialog.getByRole('button', { name: 'Submit', exact: true }).click();
			await expect(approvalDialog).toHaveCount(0);
			await expect(composer).toBeEditable({ timeout: 30_000 });
			await expect
				.poll(
					() => {
						const frames = fs.readFileSync(frameLogPath, 'utf8');
						return ['"value":"typed native input"'].every((frame) => frames.includes(frame));
					},
					{ timeout: 30_000 }
				)
				.toBe(true);
			await expect
				.poll(
					() => (fs.readFileSync(frameLogPath, 'utf8').match(/"type":"agent_end"/g) ?? []).length
				)
				.toBe(2);
		} finally {
			await harness.close();
		}
	});
	test('renders an editor native approval request', async ({ browserName: _browserName }) => {
		void _browserName;
		test.setTimeout(120_000);
		const harness = await launchNativeOmpRegularSessionHarness();
		const { launched } = harness;
		try {
			await launched.window.getByRole('button', { name: 'New Agent' }).click();
			await launched.window.getByText('Manual Setup', { exact: true }).click();
			await launched.window.getByText('Oh My Pi', { exact: true }).click();
			await launched.window.locator('input').first().fill('Native OMP editor');
			await launched.window.locator('input[placeholder="Select directory..."]').fill(process.cwd());
			await launched.window.getByRole('button', { name: 'Create Agent' }).click();
			const composer = launched.window.locator('textarea').last();
			const approvalDialog = launched.window
				.locator('[role="dialog"]')
				.filter({ hasText: 'Native OMP approval' });
			const frameLogPath = path.join(path.dirname(harness.fixture.runtimePath), 'frames.jsonl');

			await composer.fill('editor-approval');
			await composer.press('Enter');
			await expect(approvalDialog).toHaveCount(1, { timeout: 60_000 });
			const editor = approvalDialog.locator('textarea');
			await expect(editor).toBeVisible({ timeout: 60_000 });
			await editor.fill('typed native editor');
			await approvalDialog.getByRole('button', { name: 'Submit', exact: true }).click();
			await expect(approvalDialog).toHaveCount(0);
			await expect(composer).toBeEditable({ timeout: 30_000 });
			await expect
				.poll(
					() => {
						const frames = fs.readFileSync(frameLogPath, 'utf8');
						return (
							frames.includes('"id":"editor-approval-1"') &&
							frames.includes('"value":"typed native editor"')
						);
					},
					{ timeout: 30_000 }
				)
				.toBe(true);
		} finally {
			await harness.close();
		}
	});
	test('surfaces a native crash then reconnect frame without losing the composer', async ({
		browserName: _browserName,
	}) => {
		void _browserName;
		test.setTimeout(120_000);
		const harness = await launchNativeOmpRegularSessionHarness();
		const { launched } = harness;
		try {
			await launched.window.getByRole('button', { name: 'New Agent' }).click();
			await launched.window.getByText('Manual Setup', { exact: true }).click();
			await launched.window.getByText('Oh My Pi', { exact: true }).click();
			await launched.window.locator('input').first().fill('Native OMP reconnect');
			await launched.window.locator('input[placeholder="Select directory..."]').fill(process.cwd());
			await launched.window.getByRole('button', { name: 'Create Agent' }).click();
			const composer = launched.window.locator('textarea').last();
			const frameLogPath = path.join(path.dirname(harness.fixture.runtimePath), 'frames.jsonl');

			await composer.fill('crash-reconnect no-approval');
			await composer.press('Enter');
			await expect(composer).toBeEditable({ timeout: 30_000 });
			await expect(launched.window.getByText(/OMP Requested fixture crash/)).toBeVisible({
				timeout: 30_000,
			});
			await expect
				.poll(
					() => {
						const frames = fs.readFileSync(frameLogPath, 'utf8');
						return (
							frames.includes('"type":"extension_error","code":"fixture_crash"') &&
							frames.includes('"type":"ready","version":"16.4.8","reconnected":true')
						);
					},
					{ timeout: 30_000 }
				)
				.toBe(true);
		} finally {
			await harness.close();
		}
	});
});
