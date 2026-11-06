// Owned native bulk scenario. Evidence stays under the launcher-created isolated root.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { chromium } = require('playwright');
const { launchRendered } = require('./board-rendered-launch.cjs');
const [mode, addon, qualificationPath] = process.argv.slice(2);
assert.ok(
	['commit', 'stale'].includes(mode) && process.argv.length === 5,
	'Usage: node scripts/board-rendered-bulk-scenario.cjs commit|stale ELECTRON_SQLITE.node QUALIFICATION.json'
);
const outcome = '{"result":"fixture historical result","history":["preserve bytes"]}';
const sql = (root, code, ...args) =>
	JSON.parse(
		cp.execFileSync('python3', ['-c', code, path.join(root, 'db/board.sqlite'), ...args], {
			encoding: 'utf8',
		})
	);
launchRendered({
	count: 100,
	addon: path.resolve(addon),
	qualificationPath: path.resolve(qualificationPath),
	timeoutMs: 180000,
	exercise: async ({ root, cdpUrl, observe }) => {
		const result = { mode };
		try {
			const browser = await chromium.connectOverCDP(cdpUrl);
			const page = browser.contexts()[0].pages()[0];
			await page.waitForSelector('html[data-board-fixture="ready"]');
			sql(
				root,
				`import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1]); k=c.execute("select collection_key from cards where id='fixture-card-0'").fetchone()[0]; c.execute("insert into runs(run_id,collection_key,card_id,attempt,specification_json,outcome_json) values(?,?,?,?,?,?)",('fixture-history',k,'fixture-card-0',1,'{}',sys.argv[2])); c.execute("update cards set payload_json=json_set(payload_json,'$.status','running') where id='fixture-card-2'"); c.commit(); print(json.dumps(True))`,
				outcome
			);
			await observe('begin');
			await page.getByRole('button', { name: 'Open Board' }).click();
			await page.getByText('Fixture card 0', { exact: true }).first().waitFor({ timeout: 20000 });
			assert.equal(await page.getByRole('checkbox', { name: 'Running: excluded' }).count(), 1);
			const choices = page.getByRole('checkbox', { name: 'Select for deletion' });
			await choices.nth(0).check();
			await choices.nth(1).check();
			await page.getByRole('button', { name: 'Review 2 selected' }).click();
			const preview = page.getByRole('region', { name: 'Delete selected cards preview' });
			result.preview = await preview.innerText();
			assert.match(result.preview, /Fixture card 0/);
			assert.match(result.preview, /Fixture card 1/);
			if (mode === 'stale') {
				result.changed = await page.evaluate(async () => {
					const q = await window.maestro.board.queryWorkspace();
					const c = q.value.collections.find((x) =>
						x.board.cards.some((y) => y.id === 'fixture-card-0')
					);
					const card = c.board.cards.find((x) => x.id === 'fixture-card-3');
					return window.maestro.board.deleteCard(
						'maestro-board-source:' + c.sourceKey,
						c.board.id,
						card.id,
						{
							sourceKey: c.sourceKey,
							collectionKey: c.collectionKey,
							revision: c.revision,
							cardRevision: card.storageRevision,
						}
					);
				});
			}
			result.themes = {};
			for (const theme of ['dracula', 'github-light', 'nord']) {
				await page.getByLabel('Fixture theme').selectOption(theme, { force: true });
				result.themes[theme] = {
					preview: await preview.evaluate((el) => {
						const samples = [el, ...el.querySelectorAll('button,label,p')]
							.filter((x) => x.textContent.trim())
							.slice(0, 12);
						return samples.map((x) => ({
							text: x.textContent.trim().slice(0, 80),
							foreground: getComputedStyle(x).color,
							background: getComputedStyle(x).backgroundColor,
						}));
					}),
				};
				await page.screenshot({ path: path.join(root, `bulk-preview-${theme}.png`) });
			}
			await page.screenshot({ path: path.join(root, 'bulk-preview.png') });
			await page.getByRole('button', { name: 'Delete selected', exact: true }).click();
			const receipt = page
				.getByText(mode === 'commit' ? /deleted 2 cards:/ : /no cards deleted.*board changed/)
				.first();
			await receipt.waitFor({ timeout: 20000 });
			result.receipt = await receipt.innerText();
			if (mode === 'commit') {
				assert.match(result.receipt, /Fixture card 0/);
				assert.match(result.receipt, /Fixture card 1/);
			}
			result.cards = await page.evaluate(async () => {
				const q = await window.maestro.board.queryWorkspace();
				return q.value.collections
					.flatMap((c) => c.board.cards)
					.filter((c) =>
						['fixture-card-0', 'fixture-card-1', 'fixture-card-2', 'fixture-card-4'].includes(c.id)
					)
					.map((c) => ({ id: c.id, status: c.status }));
			});
			const ids = result.cards.map((c) => c.id);
			for (const id of ['fixture-card-0', 'fixture-card-1'])
				assert.equal(ids.includes(id), mode === 'stale');
			for (const id of ['fixture-card-2', 'fixture-card-4']) assert.ok(ids.includes(id));
			assert.equal(result.cards.find((c) => c.id === 'fixture-card-2').status, 'running');
			result.db = sql(
				root,
				`import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1]); print(json.dumps({'outcome':c.execute("select outcome_json from runs where run_id='fixture-history'").fetchone()[0], 'archived':c.execute("select card_id from card_archives where card_id in ('fixture-card-0','fixture-card-1') order by card_id").fetchall()}))`
			);
			assert.equal(result.db.outcome, outcome);
			assert.equal(result.db.archived.length, mode === 'commit' ? 2 : 0);
			for (const theme of ['dracula', 'github-light', 'nord']) {
				await page.getByLabel('Fixture theme').selectOption(theme, { force: true });
				result.themes[theme].result = await receipt.evaluate((el) => ({
					foreground: getComputedStyle(el).color,
					background: getComputedStyle(el).backgroundColor,
				}));
				await page.screenshot({ path: path.join(root, `bulk-result-${theme}.png`) });
			}
			for (const [theme, colors] of Object.entries(result.themes)) {
				const rgb = (value) => value.match(/\d+/g).slice(0, 3).map(Number);
				const luminance = (value) =>
					rgb(value)
						.map((v) => {
							v /= 255;
							return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
						})
						.reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
				const bg = luminance(colors.preview[0].background);
				for (const sample of [...colors.preview, colors.result]) {
					const fg = luminance(sample.foreground);
					const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
					assert.ok(ratio >= 4.5, `${theme} text contrast ${ratio}`);
				}
			}
			await page.screenshot({ path: path.join(root, 'bulk-result.png') });
			result.observation = await observe('end');
			assert.equal(
				result.observation.records.filter((x) => x.name === 'board:deleteCards').length,
				1
			);
		} finally {
			fs.writeFileSync(path.join(root, 'bulk-scenario.json'), JSON.stringify(result, null, 2));
		}
	},
})
	.then((r) => {
		assert.ok(r.lifecyclePassed);
		console.log(JSON.stringify({ root: r.contract.root, passed: r.lifecyclePassed }));
	})
	.catch((e) => {
		console.error(e);
		process.exitCode = 1;
	});
