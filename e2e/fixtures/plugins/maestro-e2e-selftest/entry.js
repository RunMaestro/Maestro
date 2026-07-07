/* global console, module, setTimeout */
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
//           "is unavailable" / "not a registered palette command"
//   PASS  = granted and the call actually functioned
//   ERROR = anything else (e.g. net:fetch offline)
//
// __FS_SCOPE__ / __RUN_ID__ are substituted by the harness. The fs scope is a
// directory OUTSIDE userData (the broker structurally denies fs into userData).
// __SEEDED_SESSION__ is a real session pre-seeded into maestro-sessions.json so
// session-addressed probes (sessions:write, tabs:manage, transcripts:*) hit the
// broker check instead of erroring on an unknown session even in DENY runs.
const SCOPE = '__FS_SCOPE__';
const TAG = '[e2e-selftest:__RUN_ID__]';
const SEEDED_SESSION = '__SEEDED_SESSION__';
const EVENT_TOPICS = [
	'session.updated',
	'session.created',
	'cue.runStarted',
	'cue.runFinished',
	'history.entryAdded',
	'agent.completed',
];

function classify(err) {
	const m = String((err && err.message) || err);
	if (/permission denied|not a host-approved binary/i.test(m)) return 'DENY';
	if (
		/not implemented|unknown host method|is not implemented|is unavailable|not a registered palette command|no such command/i.test(
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
			console.log(TAG + ' PROBE-ERR ' + cap + ': ' + String((err && err.message) || err));
		}
		console.log(TAG + ' ' + cap + ': ' + results[cap]);
	}

	const settingsKey = 'plugins.' + maestro.pluginId + '.e2e';
	// Session id used by session-addressed probes: prefer one we created this
	// run (proves sessions:create end-to-end); fall back to the seeded session
	// so DENY runs still reach the broker check.
	let sessionId = SEEDED_SESSION;

	await probe('fs:write', () => maestro.fs.write(SCOPE + '/probe.txt', 'v-' + Date.now()));
	await probe('fs:read', () => maestro.fs.read(SCOPE + '/probe.txt'));
	// fs:watch: register a real watcher on the scope dir, then touch a file
	// inside it. The host pushes `fs.watch:<watchId>` events; log a distinct
	// marker when one arrives so the test can assert real event delivery.
	await probe('fs:watch', async () => {
		const res = await maestro.fs.watch(SCOPE, { once: true });
		if (!res || typeof res.watchId !== 'string') throw new Error('no watchId returned');
		maestro.events.on('fs.watch:' + res.watchId, (payload) => {
			console.log(TAG + ' FSWATCH-EVENT ' + JSON.stringify(payload || {}));
		});
		// Touch a file inside the watched scope to make the watcher fire (only
		// works when fs:write is also granted; the marker assertion is done by
		// the full-matrix test where it is).
		try {
			await maestro.fs.write(SCOPE + '/watch-trigger.txt', 'w-' + Date.now());
		} catch {
			/* ungranted fs:write; watch registration itself already PASSed */
		}
	});
	await probe('net:fetch', () => maestro.net.fetch('https://example.com'));
	await probe('agents:read', () => maestro.agents.list());
	await probe('agents:dispatch', () => maestro.agents.dispatch(SEEDED_SESSION, 'hi'));
	await probe('notifications:toast', () => maestro.notifications.toast('e2e self-test'));
	await probe('settings:write', () => maestro.settings.set(settingsKey, 'v'));
	await probe('settings:read', () => maestro.settings.get(settingsKey));
	await probe('sessions:read', () => maestro.sessions.list());
	await probe('sessions:create', async () => {
		const created = await maestro.sessions.create({
			title: 'e2e-created-session',
			projectPath: SCOPE,
		});
		if (!created || typeof created.id !== 'string') throw new Error('no session id returned');
		sessionId = created.id;
	});
	await probe('sessions:write', async () => {
		const updated = await maestro.sessions.update(sessionId, { title: 'e2e-updated' });
		if (!updated || updated.title !== 'e2e-updated') throw new Error('update not reflected');
	});
	await probe('tabs:manage', async () => {
		const tab = await maestro.tabs.create({ sessionId, title: 'e2e-tab' });
		if (!tab || typeof tab.id !== 'string') throw new Error('no tab id returned');
	});
	// transcripts:write BEFORE transcripts:read + history:read so, when granted,
	// the appended entry is real content those reads can observe.
	await probe('transcripts:write', () =>
		maestro.transcripts.append({
			sessionId,
			projectPath: SCOPE,
			entries: [{ type: 'USER', summary: 'e2e-appended-__RUN_ID__' }],
		})
	);
	await probe('transcripts:read', () =>
		maestro.transcripts.read({ sessionId, fields: ['summary'], projectPath: SCOPE })
	);
	await probe('history:read', async () => {
		const entries = await maestro.history.list({ limit: 50 });
		if (!Array.isArray(entries)) throw new Error('history.list did not return a list');
	});
	await probe('storage:write', () => maestro.storage.set('e2e', 'v'));
	await probe('storage:read', () => maestro.storage.keys());
	// storage:sql: real round-trip through the plugin's private SQLite store.
	await probe('storage:sql', async () => {
		await maestro.storage.sql('CREATE TABLE IF NOT EXISTS e2e (k TEXT PRIMARY KEY, v TEXT)');
		await maestro.storage.sql('INSERT OR REPLACE INTO e2e (k, v) VALUES (?, ?)', [
			'run',
			'__RUN_ID__',
		]);
		const res = await maestro.storage.sql('SELECT v FROM e2e WHERE k = ?', ['run']);
		const v = res && res.rows && res.rows[0] && res.rows[0].v;
		if (v !== '__RUN_ID__') throw new Error('sql round-trip mismatch: ' + JSON.stringify(res));
	});
	await probe('ui:command', () => maestro.ui.runCommand('maestro.e2e.noop'));
	await probe('events:subscribe', () => maestro.events.subscribe(EVENT_TOPICS));
	await probe('shell:openExternal', () => maestro.shell.openExternal('https://example.com/e2e'));
	await probe('process:spawn', () => maestro.process.spawn('e2e-selftest', { args: ['hi'] }));
	await probe('decisions:write', async () => {
		const res = await maestro.decisions.record({ kind: 'e2e', choice: 'yes' });
		if (!res || typeof res.id !== 'string') throw new Error('no decision id returned');
	});
	// power:preventSleep: full acquire -> release round-trip so no wake lock
	// leaks out of the probe.
	await probe('power:preventSleep', async () => {
		const res = await maestro.power.preventSleep('e2e-probe');
		if (!res || typeof res.handleId !== 'string') throw new Error('no sleep handle returned');
		await maestro.power.releaseSleep(res.handleId);
	});
	await probe('background:service', async () => {
		const res = await maestro.background.register({ id: 'e2e-svc', name: 'E2E Service' });
		if (!res || typeof res.serviceId !== 'string') throw new Error('no serviceId returned');
		await maestro.background.unregister(res.serviceId);
	});

	// Act-verb allowlist NEGATIVE rows (Phase-4 contract): a valid dispatch/spawn
	// grant covers ONLY its exact named members — any other target is DENY even
	// while the capability itself is granted. Logged as distinct rows so the
	// matrix asserts them independently of the main cap rows.
	async function offscope(name, fn) {
		let verdict;
		try {
			await fn();
			verdict = 'PASS';
		} catch (err) {
			verdict = classify(err);
		}
		console.log(TAG + ' ACT-OFFSCOPE ' + name + ': ' + verdict);
	}
	await offscope('agents:dispatch', () => maestro.agents.dispatch('some-other-agent', 'hi'));
	await offscope('process:spawn', () => maestro.process.spawn('not-blessed', { args: [] }));

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

		// FC6 (panel render host) bridge probe: the sandboxed panel document
		// posts its in-guest lockdown observations (fetch blocked by CSP,
		// window.open() returning null) through the postMessage bridge into this
		// command, which logs them as one run-scoped JSON marker the panel test
		// parses. Invoking a plugin's OWN command needs no extra grant.
		maestro.commands.register('panelprobe', async (args) => {
			console.log(TAG + ' PANEL-BRIDGE ' + JSON.stringify(args || {}));
			return { ok: true };
		});

		// FC5 (background:service supervision) probes:
		// bgstart registers a LONG-LIVED service (no unregister) and logs its id,
		// so a crash while it is registered exercises supervised crash-restart.
		maestro.commands.register('bgstart', async () => {
			try {
				const res = await maestro.background.register({ id: 'e2e-live-svc', name: 'E2E Live' });
				console.log(TAG + ' BGSTART ' + JSON.stringify(res || {}));
				return { ok: true };
			} catch (err) {
				console.log(TAG + ' BGSTART-FAIL ' + String((err && err.message) || err));
				return { ok: false };
			}
		});
		// bgstat surfaces supervised health (background.list). Guarded: on hosts
		// without the SDK method it logs the failure instead of throwing.
		maestro.commands.register('bgstat', async () => {
			try {
				const list = maestro.background.list ? await maestro.background.list() : null;
				console.log(TAG + ' BGSTAT ' + JSON.stringify(list || {}));
				return { ok: true };
			} catch (err) {
				console.log(TAG + ' BGSTAT-FAIL ' + String((err && err.message) || err));
				return { ok: false };
			}
		});
		// crashprobe: throw from a host-realm timer callback -> uncaught exception
		// in the utilityProcess -> REAL sandbox crash (nonzero exit). Used to prove
		// supervised crash-restart. The marker logs BEFORE the throw is scheduled.
		maestro.commands.register('crashprobe', async () => {
			console.log(TAG + ' CRASHING');
			setTimeout(() => {
				throw new Error('e2e deliberate crash');
			}, 10);
			return { ok: true };
		});

		await runSelfTest(maestro);
	},
	deactivate() {},
};
