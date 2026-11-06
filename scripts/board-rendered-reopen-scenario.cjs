// Two actual owned launches, one persisted database. No provider or installed desktop.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require('playwright');
const { launchRendered } = require('./board-rendered-launch.cjs');
const binding = require('./board-rendered-contract.cjs');

async function main() {
	assert.equal(
		process.argv.length,
		4,
		'Usage: node scripts/board-rendered-reopen-scenario.cjs ELECTRON_SQLITE.node QUALIFICATION.json'
	);
	const options = {
		addon: path.resolve(process.argv[2]),
		qualificationPath: path.resolve(process.argv[3]),
		timeoutMs: 120000,
	};
	const title = 'Persisted native assignment';
	const outcome = '{"result":"Completed fixture history","history":["retain original bytes"]}';
	let saved;
	const exercise =
		(phase) =>
		async ({ root, contract, cdpUrl, observe }) => {
			let browser;
			const evidence = { phase };
			try {
				browser = await chromium.connectOverCDP(cdpUrl);
				const page = browser.contexts()[0].pages()[0];
				await page.waitForSelector('html[data-board-fixture="ready"]');
				await observe('begin');
				await page.getByRole('button', { name: 'Open Board', exact: true }).click();
				await page.getByRole('button', { name: 'New card', exact: true }).waitFor();
				if (phase === 'write') {
					await page.getByRole('button', { name: 'New card', exact: true }).click();
					await page.getByPlaceholder('e.g. Design the schema').fill(title);
					await page
						.getByPlaceholder('Instructions handed to the assignee agent.')
						.fill('Persist across an owned process restart.');
					await page.getByLabel('Execution scope', { exact: true }).click();
					await page.getByRole('option', { name: 'Agent: Fixture agent 0', exact: true }).click();
					await page.getByRole('button', { name: 'Create card', exact: true }).last().click();
				}
				const tile = page.getByRole('button', { name: `${title}, To Do`, exact: true });
				await tile.waitFor({ timeout: 20000 });
				assert.match(await tile.innerText(), /Fixture agent 0/);
				const query = await page.evaluate(() => window.maestro.board.queryWorkspace());
				assert.equal(query.ok, true);
				const collection = query.value.collections.find((item) =>
					item.board.cards.some((card) => card.title === title)
				);
				assert.ok(collection);
				const card = collection.board.cards.find((item) => item.title === title);
				assert.deepEqual(card.executionScope, { kind: 'agent', agentId: 'fixture-agent-0' });
				const current = {
					sourceKey: collection.sourceKey,
					collectionKey: collection.collectionKey,
					boardId: collection.board.id,
					revision: collection.revision,
					card,
				};
				if (phase === 'write') {
					saved = current;
					// Owned fixture setup: populated completed historical bytes, no runtime execution.
					const db = new DatabaseSync(contract.db);
					try {
						db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
						db.prepare(
							'INSERT INTO runs(run_id,collection_key,card_id,attempt,specification_json,outcome_json) VALUES (?,?,?,?,?,?)'
						).run(
							'fixture-reopen-history',
							collection.collectionKey,
							card.id,
							1,
							'{"fixture":"historical"}',
							outcome
						);
					} finally {
						db.close();
					}
				} else {
					assert.deepEqual(current, saved, 'Saved card identity, assignment or revision changed');
					const db = new DatabaseSync(contract.db, { readOnly: true });
					try {
						assert.equal(
							db
								.prepare("SELECT outcome_json FROM runs WHERE run_id='fixture-reopen-history'")
								.get().outcome_json,
							outcome
						);
						assert.equal(db.prepare('SELECT count(*) AS n FROM cards').get().n, 1);
						assert.equal(db.prepare('SELECT count(*) AS n FROM migrations').get().n, 50);
					} finally {
						db.close();
					}
				}
				evidence.saved = current;
				evidence.observation = await observe('end');
				const captures = evidence.observation.records.filter(
					(item) => item.name === 'board:captureCard'
				);
				assert.equal(captures.length, phase === 'write' ? 1 : 0);
				await page.screenshot({ path: path.join(root, 'persisted-card.png') });
			} catch (error) {
				evidence.error = String(error.stack ?? error);
				throw error;
			} finally {
				fs.writeFileSync(
					path.join(root, 'reopen-scenario.json'),
					JSON.stringify(evidence, null, 2) + '\n'
				);
				if (browser) await browser.close();
			}
		};
	const first = await launchRendered({ ...options, count: 0, exercise: exercise('write') });
	assert.ok(first.lifecyclePassed && first.addonRestored && first.ownedChildrenExited);
	const second = await launchRendered({ ...options, reopen: first, exercise: exercise('reopen') });
	assert.ok(second.lifecyclePassed && second.addonRestored && second.ownedChildrenExited);
	assert.notEqual(second.contract.identity, first.contract.identity);
	assert.deepEqual({ ...second.contract, identity: first.contract.identity }, first.contract);
	const firstHost = JSON.parse(
		fs.readFileSync(path.join(first.contract.root, 'rendered-host.json'))
	);
	const secondHost = JSON.parse(
		fs.readFileSync(
			path.join(
				binding.renderedRunRoot(JSON.parse(fs.readFileSync(second.manifestPath))),
				'rendered-host.json'
			)
		)
	);
	assert.equal(secondHost.persistenceVerified, true);
	assert.deepEqual(secondHost.persistence, firstHost.persistence);
	console.log(
		JSON.stringify({ root: first.contract.root, secondManifest: second.manifestPath, passed: true })
	);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
