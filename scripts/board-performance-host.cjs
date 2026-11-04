// Passive timing of registered Board IPC handlers. Install only in an isolated host.
function installBoardHostMeasurement(ipcMain, now) {
	if (!(ipcMain?._invokeHandlers instanceof Map) || typeof now !== 'function') {
		throw new Error('Expected Electron invoke handlers and a monotonic clock');
	}
	const installed = [];
	let current = null;
	for (const [name, original] of ipcMain._invokeHandlers) {
		if (!name.startsWith('board:')) continue;
		const wrapped = async (...args) => {
			const sample = current;
			const start = now();
			try {
				return await original(...args);
			} finally {
				if (sample) sample.push({ name, ms: now() - start });
			}
		};
		ipcMain._invokeHandlers.set(name, wrapped);
		installed.push({ name, original, wrapped });
	}
	if (!installed.length) throw new Error('No Board IPC handlers registered');
	return {
		begin() {
			if (current) throw new Error('Measurement already active');
			current = [];
		},
		end() {
			if (!current) throw new Error('No active measurement');
			const records = current;
			current = null;
			return records;
		},
		dispose() {
			for (const { name, original, wrapped } of installed) {
				if (ipcMain._invokeHandlers.get(name) !== wrapped) {
					throw new Error(`Board handler changed while measured: ${name}`);
				}
			}
			for (const { name, original } of installed) ipcMain._invokeHandlers.set(name, original);
			current = null;
		},
	};
}
module.exports = { installBoardHostMeasurement };
