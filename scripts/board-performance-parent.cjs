// Create only the fixture parent; callers still create their own exclusive roots.
const fs = require('node:fs');

function ensurePerformanceParent(parent) {
	fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
}

module.exports = { ensurePerformanceParent };
