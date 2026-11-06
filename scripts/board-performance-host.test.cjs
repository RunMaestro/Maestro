const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installBoardHostMeasurement } = require('./board-performance-host.cjs');

test('records successful and failed Board calls without changing their outcomes', async () => {
	let clock = 0;
	const handlers = new Map([
		[
			'board:queryWorkspace',
			async (value) => {
				clock += 4;
				return value;
			},
		],
		[
			'board:deleteCard',
			async () => {
				clock += 3;
				throw new Error('denied');
			},
		],
		['other:query', () => 'untouched'],
	]);
	const original = new Map(handlers);
	const measurement = installBoardHostMeasurement({ _invokeHandlers: handlers }, () => clock);
	measurement.begin();
	assert.equal(await handlers.get('board:queryWorkspace')('result'), 'result');
	await assert.rejects(handlers.get('board:deleteCard')(), /denied/);
	assert.deepEqual(measurement.end(), [
		{ name: 'board:queryWorkspace', ms: 4 },
		{ name: 'board:deleteCard', ms: 3 },
	]);
	measurement.dispose();
	assert.deepEqual(handlers, original);
});

test('fails closed on missing or replaced handlers', () => {
	assert.throws(
		() => installBoardHostMeasurement({ _invokeHandlers: new Map() }, () => 0),
		/No Board/
	);
	const handlers = new Map([['board:query', () => 1]]);
	const measurement = installBoardHostMeasurement({ _invokeHandlers: handlers }, () => 0);
	handlers.set('board:query', () => 2);
	assert.throws(() => measurement.dispose(), /changed while measured/);
});
