// Controlled replacement for the delivery10 timing probes. Raw evidence belongs
// only in the launcher's fresh private root; this driver contains no profile paths.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { launchRendered } = require('./board-rendered-launch.cjs');
const { installRendererMeasurement } = require('./board-performance-renderer.cjs');

const [label, addon, qualificationPath] = process.argv.slice(2);
assert.equal(
	process.argv.length,
	5,
	'Usage: node scripts/board-rendered-transition-scenario.cjs LABEL ELECTRON_SQLITE.node QUALIFICATION.json'
);

launchRendered({
	count: 500,
	addon: path.resolve(addon),
	qualificationPath: path.resolve(qualificationPath),
	timeoutMs: 180000,
	exercise: async ({ root, cdpUrl, observe }) => {
		const result = { label, count: 500, repetitions: 10, scenarios: [] };
		let browser;
		try {
			browser = await chromium.connectOverCDP(cdpUrl);
			const page = browser.contexts()[0].pages()[0];
			await page.waitForSelector('html[data-board-fixture="ready"]');
			await page.getByRole('button', { name: 'Open Board' }).click();
			await page.waitForFunction(
				() => document.querySelectorAll('input[type=checkbox]').length === 500
			);
			await page.evaluate(installRendererMeasurement);
			for (const selected of [0, 250]) {
				if (selected) {
					await page.evaluate(() => {
						for (const input of [...document.querySelectorAll('input[type=checkbox]')].slice(
							0,
							250
						))
							input.click();
					});
					await page.waitForFunction(
						() => document.querySelectorAll('input[type=checkbox]:checked').length === 250
					);
				}
				for (const transition of ['cards-reentry', 'filter-restore', 'selection']) {
					// One warm-up, then ten samples. Setup, settling and host queries
					// are outside the measured interval. No CPU profiler or concurrent
					// accessibility polling. Each sample measures just ONE transition.
					for (let repetition = -1; repetition < result.repetitions; repetition++) {
						if (transition === 'cards-reentry') {
							await page.getByRole('tab', { name: 'Workers' }).click();
							await page.getByLabel('Search workers and agents').waitFor();
						} else if (transition === 'filter-restore') {
							await page.getByLabel('Filter by status').click();
							await page.getByRole('option', { name: 'Done', exact: true }).click();
							await page.waitForFunction(
								() => document.querySelectorAll('input[type=checkbox]').length === 0
							);
							await page.getByLabel('Filter by status').click();
						}
						await page.evaluate(
							() =>
								new Promise((resolve) =>
									requestAnimationFrame(() => requestAnimationFrame(resolve))
								)
						);
						await observe('begin');
						const sample = await page.evaluate(async (transition) => {
							const inputs = () => document.querySelectorAll('input[type=checkbox]');
							const target =
								transition === 'selection'
									? inputs()[499]
									: [
											...document.querySelectorAll(
												transition === 'cards-reentry' ? '[role=tab]' : '[role=option]'
											),
										].find(
											(el) =>
												el.textContent.trim() ===
												(transition === 'cards-reentry' ? 'Cards' : 'All statuses')
										);
							if (!target) throw Error(`Missing ${transition} target`);
							const checked = transition === 'selection' ? target.checked : null;
							const complete = () =>
								transition === 'selection' ? target.checked !== checked : inputs().length === 500;
							window.__boardMeasurement.begin();
							await new Promise((resolve) => {
								const observer = new MutationObserver(() => {
									if (complete()) {
										observer.disconnect();
										resolve();
									}
								});
								observer.observe(document.body, {
									subtree: true,
									childList: true,
									attributes: true,
								});
								target.click();
								if (complete()) {
									observer.disconnect();
									resolve();
								}
							});
							await new Promise((resolve) =>
								requestAnimationFrame(() => requestAnimationFrame(resolve))
							);
							const renderer = window.__boardMeasurement.end();
							// Longtask delivery may include an earlier setup task. Only
							// attribute entries that started inside this transition.
							renderer.longtasks = renderer.longtasks.filter(
								(entry) => entry.start >= renderer.startedAt && entry.start < renderer.endedAt
							);
							return {
								elapsedMs: renderer.endedAt - renderer.startedAt,
								renderer,
								nodes: document.querySelectorAll('*').length,
								selected: document.querySelectorAll('input[type=checkbox]:checked').length,
							};
						}, transition);
						const host = await observe('end');
						result.scenarios.push({ transition, selected, repetition, ...sample, host });
						// Reset a selection toggle outside the sample, so each repetition
						// starts with the same number of selected cards.
						if (transition === 'selection') {
							await page.evaluate(() =>
								document.querySelectorAll('input[type=checkbox]')[499].click()
							);
							await page.waitForFunction(
								(n) => document.querySelectorAll('input[type=checkbox]:checked').length === n,
								selected
							);
						}
					}
				}
			}
			await page.evaluate(() => window.__boardMeasurement.dispose());
		} catch (error) {
			result.error = String(error.stack ?? error);
			throw error;
		} finally {
			fs.writeFileSync(
				path.join(root, 'transition-scenario.json'),
				JSON.stringify(result, null, 2)
			);
			if (browser) await browser.close();
		}
	},
})
	.then((receipt) => {
		assert.ok(receipt.lifecyclePassed);
		console.log(
			JSON.stringify({ root: receipt.contract.root, lifecyclePassed: receipt.lifecyclePassed })
		);
	})
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
