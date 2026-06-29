/* global console, module */
// Maestro E2E self-test plugin (versioned fixture).
//
// Runs in the tier-1 sandbox; every maestro.* call is a broker-gated RPC
// authorized against the plugin's live grants. It probes a representative
// capability set and logs one line per capability:
//   [e2e-selftest] <cap>: PASS | DENY | INERT | ERROR
// followed by a SUMMARY line. console.* is injected by the sandbox and
// forwarded to the host debug log, so the results are observable from the
// demo `logs/` directory WITHOUT the plugin holding any grant — which is what
// lets the e2e assert the default-deny model (ungranted => DENY) and, after
// consent, the granted model (granted => PASS).
//
// __FS_SCOPE__ is substituted by the e2e harness with a real, forward-slashed
// directory OUTSIDE the Maestro userData tree (the broker structurally denies
// fs access into userData even with a grant).
const SCOPE = '__FS_SCOPE__';
const TAG = '[e2e-selftest:__RUN_ID__]';

function classify(err) {
	const m = String((err && err.message) || err);
	if (/permission denied/i.test(m)) return 'DENY';
	if (/not implemented|unknown host method|is not implemented/i.test(m)) return 'INERT';
	return 'ERROR';
}

async function runSelfTest(maestro) {
	const results = {};
	async function probe(cap, fn) {
		try {
			await fn();
			results[cap] = 'PASS';
		} catch (err) {
			results[cap] = classify(err);
		}
		console.log(TAG + ' ' + cap + ': ' + results[cap]);
	}

	await probe('fs:write', () => maestro.fs.write(SCOPE + '/probe.txt', 'v-' + Date.now()));
	await probe('fs:read', () => maestro.fs.read(SCOPE + '/probe.txt'));
	await probe('net:fetch', () => maestro.net.fetch('https://example.com'));
	const settingsKey = 'plugins.' + maestro.pluginId + '.e2e';
	await probe('settings:write', () => maestro.settings.set(settingsKey, 'v'));
	await probe('settings:read', () => maestro.settings.get(settingsKey));
	await probe('storage:write', () => maestro.storage.set('e2e', 'v'));
	await probe('storage:read', () => maestro.storage.keys());
	await probe('notifications:toast', () => maestro.notifications.toast('e2e self-test'));
	await probe('events:subscribe', () =>
		maestro.events.subscribe(['cue.runStarted', 'cue.runFinished'])
	);
	await probe('ui:command', () => maestro.ui.runCommand('maestro.e2e.noop'));

	console.log(TAG + ' SUMMARY ' + JSON.stringify(results));
	return results;
}

module.exports = {
	async activate(maestro) {
		// Re-runnable on demand via window.maestro.plugins.invokeCommand(
		//   'maestro.e2e.selftest/selftest') so the e2e can force a fresh run
		// after granting consent.
		maestro.commands.register('selftest', async () => {
			const results = await runSelfTest(maestro);
			return { ok: true, results };
		});
		// Also run once at activation so the ungranted (default-deny) smoke test
		// has log output without invoking anything.
		await runSelfTest(maestro);
	},
	deactivate() {},
};
