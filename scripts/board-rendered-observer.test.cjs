const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startRenderedObserver } = require('./board-rendered-observer.cjs');
const fixtureParent = path.join(__dirname, '../isolated');
fs.mkdirSync(fixtureParent, { recursive: true, mode: 0o700 });

test('controls host samples in order and closes the owned observer', async (t) => {
	const root = fs.mkdtempSync(path.join(fixtureParent, 'board-observer-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	let active = false;
	let exit;
	const stop = startRenderedObserver(
		root,
		{
			begin() {
				assert.equal(active, false);
				active = true;
			},
			end() {
				assert.equal(active, true);
				active = false;
				return [{ name: 'board:query', ms: 4 }];
			},
		},
		(code, error) => {
			exit = { code, error };
		}
	);
	t.after(stop);
	for (const [id, action] of [
		[1, 'begin'],
		[2, 'end'],
		[3, 'finish'],
	]) {
		fs.writeFileSync(path.join(root, 'observer-request.json'), JSON.stringify({ id, action }));
		const deadline = Date.now() + 2000;
		let result;
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			if (fs.existsSync(path.join(root, 'observer-response.json'))) {
				result = JSON.parse(fs.readFileSync(path.join(root, 'observer-response.json')));
				if (result.id === id) break;
			}
		}
		assert.equal(result?.id, id);
		if (action === 'end') assert.deepEqual(result.records, [{ name: 'board:query', ms: 4 }]);
	}
	assert.equal(exit.code, 0);
});

test('rejects an unrecognised command without invoking the observer', async (t) => {
	const root = fs.mkdtempSync(path.join(fixtureParent, 'board-observer-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const result = new Promise((resolve) => {
		const stop = startRenderedObserver(
			root,
			{
				begin() {
					throw Error('unexpected');
				},
			},
			(code, error) => resolve({ code, error })
		);
		t.after(stop);
	});
	fs.writeFileSync(
		path.join(root, 'observer-request.json'),
		JSON.stringify({ id: 1, action: 'execute' })
	);
	const { code, error } = await result;
	assert.equal(code, 1);
	assert.match(error.message, /Invalid observer action/);
});
