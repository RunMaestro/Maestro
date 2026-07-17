import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchNativeOmpRegularSessionHarness } from './fixtures/omp-native-regular-session-harness';

test.describe('first-party OMP regular session', () => {
	test('renders first-party OMP presence inline and preserves one RPC session through delivery modes', async ({
		browserName: _browserName,
	}, testInfo) => {
		void _browserName;
		test.setTimeout(180_000);
		const harness = await launchNativeOmpRegularSessionHarness();
		const { launched } = harness;
		try {
			await launched.window.getByRole('button', { name: 'New Agent' }).click();
			await launched.window.getByText('Manual Setup', { exact: true }).click();
			await launched.window.getByText('Oh My Pi', { exact: true }).click();
			await launched.window.locator('input').first().fill('Native OMP fixture');
			await launched.window.locator('input[placeholder="Select directory..."]').fill(process.cwd());
			await launched.window.getByRole('button', { name: 'Create Agent' }).click();

			const composer = launched.window.locator('textarea').last();
			const frameLogPath = path.join(path.dirname(harness.fixture.runtimePath), 'frames.jsonl');
			await composer.fill('show ordinary native transcript');
			await composer.press('Enter');
			const turnFabric = launched.window.getByTestId('omp-turn-fabric');
			await expect(turnFabric).toBeVisible({ timeout: 30_000 });
			await expect(turnFabric.getByRole('region', { name: 'Active OMP turn' })).toHaveCount(0);
			await expect(launched.window.getByRole('group', { name: 'Native OMP approval' })).toBeVisible(
				{
					timeout: 30_000,
				}
			);
			await expect(
				launched.window.getByRole('button', { name: 'Native', exact: true })
			).toHaveCount(0);

			await composer.fill('queue this native follow-up');
			await composer.press('Control+Enter');
			await expect(
				launched.window.getByRole('group', { name: 'OMP delivery controls' })
			).toBeVisible();
			const deliveryCaret = launched.window.getByRole('button', {
				name: 'Choose OMP delivery mode',
			});
			await deliveryCaret.click();
			const deliveryMenu = launched.window.getByRole('menu', { name: 'OMP delivery mode' });
			await expect(deliveryMenu.getByRole('menuitem', { name: /Steer now/ })).toBeVisible();
			await expect(deliveryMenu.getByRole('menuitem', { name: /Queue follow-up/ })).toBeVisible();
			await expect(
				deliveryMenu.getByRole('menuitem', { name: /Interrupt & replace/ })
			).toBeVisible();
			await launched.window.keyboard.press('Escape');
			await expect(deliveryMenu).toHaveCount(0);

			await launched.window
				.getByRole('group', { name: 'Native OMP approval' })
				.getByRole('button', {
					name: 'Approve',
					exact: true,
				})
				.click();
			await expect(turnFabric.getByRole('region', { name: 'Completed OMP turn' })).toBeVisible({
				timeout: 30_000,
			});
			await expect(
				launched.window.getByText('fixture:expanded-16.4.8', { exact: true })
			).toBeVisible();
			await expect(launched.window.getByTestId('header-context-widget')).toContainText(
				'200k context'
			);
			await expect(launched.window.getByTestId('omp-queued-follow-ups')).toHaveCount(0);

			await expect
				.poll(() => fs.readFileSync(frameLogPath, 'utf8'), { timeout: 30_000 })
				.toContain('"streamingBehavior":"follow_up"');
			const frames = fs.readFileSync(frameLogPath, 'utf8');
			expect((frames.match(/"type":"agent_start"/g) ?? []).length).toBeGreaterThanOrEqual(1);
			expect(frames).not.toMatch(/"type":"(?:login|open_url|open_external_url)"/);
			expect(launched.output()).not.toMatch(/legacy.*fallback|fallback.*legacy/i);
			fs.writeFileSync(testInfo.outputPath('omp-native-frames.jsonl'), frames, 'utf8');
		} finally {
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
				.locator('[role="group"]')
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
				.locator('[role="group"]')
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
