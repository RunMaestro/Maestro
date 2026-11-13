// Fixture-only, file-backed control of the main-process timing observer.
// The launcher and host share a private 0700 root; no renderer IPC is exposed.
const fs = require('node:fs');
const path = require('node:path');

function startRenderedObserver(root, measurement, finish) {
	const request = path.join(root, 'observer-request.json');
	const response = path.join(root, 'observer-response.json');
	let lastId = 0;
	let active = false;
	const timer = setInterval(() => {
		if (!fs.existsSync(request)) return;
		let command;
		try {
			const stat = fs.lstatSync(request);
			if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024)
				throw new Error('Invalid observer request file');
			command = JSON.parse(fs.readFileSync(request, 'utf8'));
			if (!Number.isSafeInteger(command.id) || command.id !== lastId + 1)
				throw new Error('Invalid observer request id');
			if (
				!['begin', 'end', 'finish'].includes(command.action) ||
				Object.keys(command).sort().join(',') !== 'action,id'
			)
				throw new Error('Invalid observer action');
			let records;
			if (command.action === 'begin') {
				measurement.begin();
				active = true;
			} else if (command.action === 'end') {
				records = measurement.end();
				active = false;
			} else if (active) throw new Error('Measurement is still active');
			lastId = command.id;
			fs.unlinkSync(request);
			const temporary = `${response}.${process.pid}.tmp`;
			fs.writeFileSync(temporary, JSON.stringify({ id: lastId, records }) + '\n', {
				flag: 'wx',
				mode: 0o600,
			});
			fs.renameSync(temporary, response);
			if (command.action === 'finish') finish(0);
		} catch (error) {
			clearInterval(timer);
			finish(1, error);
		}
	}, 20);
	return () => clearInterval(timer);
}

module.exports = { startRenderedObserver };
