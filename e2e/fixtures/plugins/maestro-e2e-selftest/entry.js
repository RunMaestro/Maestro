/* global console, module */
// Maestro E2E self-test plugin (versioned fixture).
//
// Runs in the tier-1 sandbox; every maestro.* call is a broker-gated RPC
// authorized against the plugin's live grants. It probes the full callable
// capability surface and logs one line per capability:
//   [e2e-selftest:<runId>] <cap>: PASS | DENY | INERT | ERROR
// followed by a SUMMARY line, and logs every delivered event as
//   [e2e-selftest:<runId>] EVENT <topic> <json>
// console.* is injected by the sandbox and forwarded to the host debug log,
// so results are observable from the captured main-process output WITHOUT the
// plugin holding any grant. The runId marker prevents stale-log false-passes.
//
// Classification:
//   DENY  = broker refused (ungranted)            -> "permission denied"
//   INERT = granted, but host side is unwired       -> "not implemented" /
//           (agents:dispatch, process:spawn, ui:command) "not a registered palette command"
//   PASS  = granted and the call actually functioned
//   ERROR = anything else (e.g. net:fetch offline)
//
// __FS_SCOPE__ / __RUN_ID__ are substituted by the harness. The fs scope is a
// directory OUTSIDE userData (the broker structurally denies fs into userData).
const SCOPE = '__FS_SCOPE__';
const TAG = '[e2e-selftest:__RUN_ID__]';
const EVENT_TOPICS = ['session.updated', 'session.created', 'cue.runStarted', 'cue.runFinished'];

function classify(err) {
	const m = String((err && err.message) || err);
	if (/permission denied/i.test(m)) return 'DENY';
	if (
		/not implemented|unknown host method|is not implemented|not a registered palette command|no such command/i.test(
			m
		)
	) {
		return 'INERT';
	}
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

	const settingsKey = 'plugins.' + maestro.pluginId + '.e2e';
	await probe('fs:write', () => maestro.fs.write(SCOPE + '/probe.txt', 'v-' + Date.now()));
	await probe('fs:read', () => maestro.fs.read(SCOPE + '/probe.txt'));
	await probe('net:fetch', () => maestro.net.fetch('https://example.com'));
	await probe('agents:read', () => maestro.agents.list());
	await probe('agents:dispatch', () => maestro.agents.dispatch('none', 'hi'));
	await probe('notifications:toast', () => maestro.notifications.toast('e2e self-test'));
	await probe('settings:write', () => maestro.settings.set(settingsKey, 'v'));
	await probe('settings:read', () => maestro.settings.get(settingsKey));
	await probe('sessions:read', () => maestro.sessions.list());
	await probe('transcripts:read', () =>
		maestro.transcripts.read({ sessionId: 'none', fields: ['summary'], projectPath: SCOPE })
	);
	await probe('storage:write', () => maestro.storage.set('e2e', 'v'));
	await probe('storage:read', () => maestro.storage.keys());
	await probe('ui:command', () => maestro.ui.runCommand('maestro.e2e.noop'));
	await probe('events:subscribe', () => maestro.events.subscribe(EVENT_TOPICS));
	await probe('process:spawn', () => maestro.process.spawn('echo hi'));

	console.log(TAG + ' SUMMARY ' + JSON.stringify(results));
	return results;
}

module.exports = {
	async activate(maestro) {
		// Event delivery: log any subscribed event that actually arrives so a test
		// can trigger a host event and assert end-to-end delivery into the sandbox.
		for (const topic of EVENT_TOPICS) {
			maestro.events.on(topic, (evt) => {
				console.log(TAG + ' EVENT ' + topic + ' ' + JSON.stringify(evt || {}));
			});
		}

		// Re-runnable self-test (after granting consent the test re-invokes this).
		maestro.commands.register('selftest', async () => ({
			ok: true,
			results: await runSelfTest(maestro),
		}));

		// Re-subscribe on demand: activation runs before consent, so events.subscribe
		// is denied at first; the test invokes this AFTER granting events:subscribe.
		maestro.commands.register('resubscribe', async () => {
			try {
				await maestro.events.subscribe(EVENT_TOPICS);
				console.log(TAG + ' RESUBSCRIBED');
				return { ok: true };
			} catch (err) {
				console.log(TAG + ' RESUBSCRIBE-FAIL ' + String((err && err.message) || err));
				return { ok: false };
			}
		});

		// Dedicated ui:command probe (WS-ui-command e2e): invoke a REAL registered
		// global command via ui.runCommand and log a distinct, run-scoped marker so
		// a test can assert PASS without disturbing the shared self-test SUMMARY.
		maestro.commands.register('uicmdprobe', async () => {
			let result;
			try {
				await maestro.ui.runCommand('maestro.commandPalette.open');
				result = 'PASS';
			} catch (err) {
				result = classify(err);
			}
			console.log(TAG + ' UICMD ' + result);
			return { ok: result === 'PASS', result };
		});

		// Keybinding dispatch probe (WS-keybindings e2e): a contributed keybinding
		// (Ctrl+Shift+F9 -> this command) is bound by the renderer's
		// usePluginKeybindings hook; firing the chord invokes this, which logs a
		// distinct, run-scoped marker the keybinding test asserts on.
		maestro.commands.register('keybind-probe', async () => {
			console.log(TAG + ' KEYBIND-FIRED');
			return { ok: true };
		});

		await runSelfTest(maestro);
	},
	deactivate() {},
};
