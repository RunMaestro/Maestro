const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertOutputPaths } = require('./board-rendered-build.cjs');

test('accepts missing output and rejects output aliases without touching real dist', () => {
	const parent = path.join(__dirname, '../isolated');
	fs.mkdirSync(parent, { recursive: true });
	const root = fs.mkdtempSync(path.join(parent, 'board-build-path-'));
	try {
		fs.mkdirSync(path.join(root, 'node_modules'));
		assert.doesNotThrow(() => assertOutputPaths(root));
		fs.symlinkSync('missing', path.join(root, 'dist'));
		assert.throws(() => assertOutputPaths(root));
		fs.unlinkSync(path.join(root, 'dist'));
		fs.mkdirSync(path.join(root, 'dist'));
		fs.symlinkSync('../node_modules', path.join(root, 'dist/main'));
		assert.throws(() => assertOutputPaths(root));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
