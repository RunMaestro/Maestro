#!/usr/bin/env node

/**
 * Showcase Mode capture driver.
 *
 * Shoots every entry in `shots.js`, in every requested theme, without a human
 * clicking through them. One launch PER THEME: the theme is applied by seeding
 * `maestro-settings.json` before the app starts, which is the only way to be
 * sure every surface has painted in that theme by the time the shutter opens.
 * Switching live would leave a repaint race on exactly the surfaces (charts,
 * the Cue canvas) that are slowest and most worth photographing.
 *
 * Two channels, deliberately:
 *   - The WS bridge opens each surface, because that is the same `open_modal`
 *     path `maestro-cli open` uses. It honors Encore gating and the modal layer
 *     stack, so a shot can never capture a state a user could not reach.
 *   - CDP only takes the picture (`Page.captureScreenshot`). It never drives
 *     navigation, so this script cannot drift from what the app supports.
 *
 * Usage:
 *   node scripts/showcase/capture.js [--themes a,b,c] [--size WxH]
 *                                    [--only name,name] [--out <dir>]
 *                                    [--cwd <path>] [--typography <id>]
 *                                    [--keep]
 *
 * Output lands at `<out>/<shot name>.<theme id>.png`, so a docs page or the
 * website gallery can swap themes by substituting one path segment.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const WebSocket = require('ws');

const { SHOWCASE_DIR } = require('./showcase-dir');
const { SHOTS, SETTLE_MS } = require('./shots');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_THEMES = ['dracula', 'catppuccin-latte', 'pedurple'];
/**
 * Logical window size for the published set, 4960x2800 at 2x.
 *
 * Sized so the main window still has room after the side panels are given the
 * width their own layout gates ask for (see the seed's `leftSidebarWidth` /
 * `rightPanelWidth`) and the interface is zoomed. Those two take about 260
 * logical pixels out of the middle between them, which is most of a code
 * column.
 *
 * It must fit on the operator's display: the shot is the real window, so a
 * window bigger than the screen is silently clamped by the window manager and
 * the whole set comes out small. `assertViewport` below turns that into an
 * error rather than a surprise.
 */
const DEFAULT_SIZE = '2480x1400';
const DEFAULT_OUT = path.join(ROOT, 'docs', 'screenshots');
const CDP_PORT = process.env.MAESTRO_CDP_PORT || '17399';
/** How long to wait for the app to boot far enough to answer CDP. */
const BOOT_TIMEOUT_MS = 120000;
/**
 * How long to wait for the shell to PAINT after it answers, which is a longer
 * and separate budget: the first theme of a run pays for a cold
 * `tsc -p tsconfig.main.json` before Electron even starts, and the splash is
 * already serving CDP throughout that compile.
 */
const PAINT_TIMEOUT_MS = 240000;
/** How long to wait for a signalled app to stop answering CDP before giving up. */
const SHUTDOWN_TIMEOUT_MS = 30000;
/**
 * How long the shell may be rendered with the splash still up before the driver
 * dismisses it itself. Long enough that a genuinely slow load finishes on its
 * own and is photographed through the normal path.
 */
const SPLASH_GRACE_MS = 20000;

// --- CLI args ---------------------------------------------------------------

function argValue(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

const themes = argValue('themes', DEFAULT_THEMES.join(',')).split(',').filter(Boolean);
const size = argValue('size', DEFAULT_SIZE);
const sizeParts = size.match(/^(\d+)x(\d+)$/);
if (!sizeParts) {
	console.error(`[capture] FAILED: invalid --size "${size}". Use WxH (e.g. ${DEFAULT_SIZE}).`);
	process.exit(1);
}
const width = Number(sizeParts[1]);
const height = Number(sizeParts[2]);
const outDir = path.resolve(argValue('out', DEFAULT_OUT));
const only = argValue('only', '').split(',').filter(Boolean);
const keepRunning = hasFlag('keep');
/** Forwarded to setup.js: the working directory the shots publish. See setup.js. */
const demoCwd = argValue('cwd', '');
/**
 * Which typography preset the set is shot in. Defaults to `default`, the
 * proportional look a new install is steered toward, rather than the store
 * default (`hacker`), which exists to leave a returning user's app alone.
 */
const typography = argValue('typography', 'default');

const shots = only.length ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS;
if (!shots.length) {
	console.error(`[capture] No shots matched --only ${only.join(',')}`);
	process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- WS bridge (opens surfaces) ---------------------------------------------

/**
 * Read the running app's CLI discovery file. Written into the app's OWN
 * userData dir, which in showcase mode is SHOWCASE_DIR, so this reaches the
 * showcase instance rather than whatever production app is also running.
 */
function readBridgeInfo() {
	const file = path.join(SHOWCASE_DIR, 'cli-server.json');
	if (!fs.existsSync(file)) return null;
	try {
		const info = JSON.parse(fs.readFileSync(file, 'utf8'));
		return info && info.port && info.token ? info : null;
	} catch {
		return null; // half-written file; the caller retries
	}
}

class Bridge {
	constructor(info) {
		this.url = `ws://127.0.0.1:${info.port}/${info.token}/ws`;
		this.pending = new Map();
		this.seq = 0;
	}

	connect() {
		return new Promise((resolve, reject) => {
			this.ws = new WebSocket(this.url, { perMessageDeflate: false });
			this.ws.on('open', () => resolve());
			this.ws.on('error', reject);
			this.ws.on('message', (raw) => {
				let msg;
				try {
					msg = JSON.parse(raw.toString());
				} catch {
					return;
				}
				const pending = msg.requestId && this.pending.get(msg.requestId);
				if (pending) {
					this.pending.delete(msg.requestId);
					pending(msg);
				}
			});
		});
	}

	send(message, expectType, timeoutMs = 15000) {
		const requestId = `cap_${++this.seq}_${Date.now()}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(requestId);
				reject(new Error(`timed out waiting for ${expectType}`));
			}, timeoutMs);
			this.pending.set(requestId, (msg) => {
				clearTimeout(timer);
				resolve(msg);
			});
			this.ws.send(JSON.stringify({ ...message, requestId }));
		});
	}

	close() {
		try {
			this.ws && this.ws.close();
		} catch {
			/* already gone */
		}
	}
}

// --- CDP (takes the picture) ------------------------------------------------

class Cdp {
	constructor(port) {
		this.port = port;
		this.id = 0;
		this.pending = new Map();
	}

	async connect() {
		const list = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json();
		const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
		if (!page) throw new Error('no CDP page target');
		await new Promise((resolve, reject) => {
			this.ws = new WebSocket(page.webSocketDebuggerUrl, {
				perMessageDeflate: false,
				maxPayload: 256 * 1024 * 1024,
			});
			this.ws.on('open', resolve);
			this.ws.on('error', reject);
			this.ws.on('message', (raw) => {
				const msg = JSON.parse(raw.toString());
				const pending = msg.id && this.pending.get(msg.id);
				if (pending) {
					this.pending.delete(msg.id);
					pending(msg);
				}
			});
		});
	}

	send(method, params) {
		const id = ++this.id;
		return new Promise((resolve) => {
			this.pending.set(id, resolve);
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}

	async evaluate(expression) {
		const res = await this.send('Runtime.evaluate', {
			expression,
			returnByValue: true,
			awaitPromise: true,
		});
		return res.result && res.result.result ? res.result.result.value : undefined;
	}

	/**
	 * Wait until the app has actually PAINTED, not merely until it answers.
	 *
	 * The bridge file and the CDP page target both exist while `index.html` is
	 * still showing its splash, so a readiness check built on those alone shoots
	 * the "Tuning instruments..." screen and files it as the hero. Two conditions
	 * have to hold: the splash is gone or hidden, and the Left Bar header has
	 * rendered (the last thing to arrive, since it waits on the session load).
	 */
	/**
	 * Put the app's window in front, and keep it there.
	 *
	 * Not cosmetic: Chromium suspends `requestAnimationFrame` in a window it
	 * considers hidden or fully occluded, and the splash is dismissed from
	 * INSIDE a double rAF (`useAppInitialization`). The first launch of a run
	 * comes to the front on its own; the second and third open behind the
	 * terminal, so their rAF never fires, the splash never lifts, and the driver
	 * times out with the app fully loaded underneath it. This is also why a
	 * single-theme run always looked healthy.
	 */
	async bringToFront() {
		await this.send('Page.bringToFront');
	}

	async awaitRendered(timeoutMs) {
		const deadline = Date.now() + timeoutMs;
		let shellSince = 0;
		while (Date.now() < deadline) {
			// Re-asserted every pass rather than once: the window can be occluded
			// again at any point by anything else on the desktop, and a single call
			// at connect time only covers the instant it was made.
			await this.bringToFront().catch(() => {});
			const state = await this.evaluate(
				`(() => {
				const splash = document.querySelector('#initial-splash');
				const splashGone = !splash || splash.classList.contains('hidden');
				const shell = document.querySelector('[data-testid="sidebar-header-indicators"]');
				return JSON.stringify({ splashGone, shell: Boolean(shell) });
			})()`
			).catch(() => null);
			const { splashGone = false, shell = false } = state ? JSON.parse(state) : {};
			if (splashGone && shell) return;

			// The shell is up but the splash has not lifted. That is the rAF
			// throttle, not a slow load: Maestro dismisses its splash from inside
			// a DOUBLE requestAnimationFrame (`useAppInitialization`), and Chromium
			// suspends rAF in a window it considers occluded - so the app is fully
			// loaded, sitting behind a curtain nothing will ever raise.
			// `Page.bringToFront` above fixes this most of the time and cannot be
			// relied on: whether macOS actually raises the window depends on what
			// else is grabbing focus while a 20-minute run is going.
			//
			// So after a grace period, call the app's OWN dismissal function. It is
			// what the rAF callback would have called, and its internals
			// (`document.fonts.ready`, `setTimeout`) are not rAF-driven, so it
			// completes under throttling. This reveals the shell that already
			// rendered; it never fabricates one, which is why the `shell` half of
			// the predicate is still required before it fires.
			if (shell) {
				if (!shellSince) shellSince = Date.now();
				else if (Date.now() - shellSince > SPLASH_GRACE_MS) {
					await this.evaluate('window.__hideSplash && window.__hideSplash()').catch(() => {});
				}
			} else {
				shellSince = 0;
			}
			await new Promise((r) => setTimeout(r, 1000));
		}
		// Say what was actually on screen. "Still on the splash" and "painted but
		// the Left Bar never arrived" have different causes, and a bare timeout
		// sends the next person to look in the wrong place.
		//
		// `status` is the splash's own progress line, and it is the most useful
		// field here: the app writes a different string at each initialization
		// gate ("Warming up the ensemble..." = sessions, "Indexing the score..."
		// = file tree), and its error handler REPLACES it with the exception
		// text, so a stall and a crash are told apart by reading one string.
		const seen = await this.evaluate(
			`(() => {
				const splash = document.querySelector('#initial-splash');
				const status = document.querySelector('#splash-text');
				return JSON.stringify({
					splash: splash ? (splash.classList.contains('hidden') ? 'hidden' : 'visible') : 'absent',
					status: status ? status.textContent : null,
					shell: Boolean(document.querySelector('[data-testid="sidebar-header-indicators"]')),
					title: document.title,
				});
			})()`
		).catch(() => '<could not evaluate>');
		throw new Error(`app never painted after ${timeoutMs / 1000}s: ${seen}`);
	}

	/**
	 * Refuse to shoot a window that is not the size that was asked for.
	 *
	 * The set is captured from a REAL window, so its size is subject to the
	 * window manager: a window larger than the operator's display is clamped
	 * silently, and the run then completes, reports every shot captured, and
	 * publishes a set at whatever size that machine happened to allow. That is
	 * the worst failure shape here, because nothing about it looks wrong until
	 * the images are already in the docs.
	 *
	 * The tolerance covers the window manager rounding and any chrome the
	 * platform insists on; anything beyond it is a clamp, not a rounding.
	 */
	async assertViewport(width, height) {
		const seen = await this.evaluate(
			'JSON.stringify({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })'
		);
		const { w, h, dpr } = JSON.parse(seen);
		const slack = 24;
		if (Math.abs(w - width) > slack || Math.abs(h - height) > slack) {
			throw new Error(
				`window is ${w}x${h}, not the requested ${width}x${height} - it does not fit this display, so every shot would be undersized`
			);
		}
		return { w, h, dpr };
	}

	async screenshot(file) {
		const res = await this.send('Page.captureScreenshot', { format: 'png' });
		if (!res.result || !res.result.data) throw new Error('empty screenshot');
		fs.writeFileSync(file, Buffer.from(res.result.data, 'base64'));
	}

	/**
	 * Press Escape until nothing is left open. There is no `close_modals` bridge
	 * verb, and there should not be one: Escape is how a user leaves a layer, so
	 * pressing it exercises the same layer-stack path rather than a back door
	 * that could drift from it.
	 *
	 * `times` is the depth to clear, not a retry count. Only the full-window
	 * DESTINATION modals close each other on open; every other surface LAYERS,
	 * so a run that opens one surface per shot without closing the last one
	 * accumulates a stack, and each shot photographs whichever modal happens to
	 * sit on top. That is not a crash - the bridge answers `success: true` for
	 * every one of them - so the run reports a full set while filing the same
	 * picture under several names.
	 */
	async escape(times = 6) {
		for (let i = 0; i < times; i++) {
			await this.send('Input.dispatchKeyEvent', {
				type: 'keyDown',
				key: 'Escape',
				code: 'Escape',
				windowsVirtualKeyCode: 27,
				nativeVirtualKeyCode: 27,
			});
			await this.send('Input.dispatchKeyEvent', {
				type: 'keyUp',
				key: 'Escape',
				code: 'Escape',
				windowsVirtualKeyCode: 27,
				nativeVirtualKeyCode: 27,
			});
			await new Promise((r) => setTimeout(r, 200));
		}
	}

	close() {
		try {
			this.ws && this.ws.close();
		} catch {
			/* already gone */
		}
	}
}

// --- app lifecycle ----------------------------------------------------------

function seedFor(theme) {
	console.log(`[capture] Seeding ${theme}...`);
	const args = [path.join(__dirname, 'setup.js'), '--theme', theme, '--size', size];
	args.push('--typography', typography);
	if (demoCwd) args.push('--cwd', demoCwd);
	execFileSync(process.execPath, args, { stdio: 'inherit', cwd: ROOT });
}

function launchApp() {
	const child = spawn('npm', ['run', 'dev'], {
		cwd: ROOT,
		env: { ...process.env, MAESTRO_DEMO_DIR: SHOWCASE_DIR, MAESTRO_CDP_PORT: CDP_PORT },
		stdio: ['ignore', 'pipe', 'pipe'],
		shell: true,
		detached: true,
	});
	// Keep the pipes drained; a full buffer would stall the dev server.
	child.stdout.on('data', () => {});
	child.stderr.on('data', () => {});
	return child;
}

/** Wait for BOTH channels: the app answers CDP and has written its bridge file. */
async function waitForApp() {
	const deadline = Date.now() + BOOT_TIMEOUT_MS;
	let lastErr = 'not started';
	while (Date.now() < deadline) {
		await sleep(2000);
		try {
			const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
			const list = await res.json();
			if (!list.some((t) => t.type === 'page')) {
				lastErr = 'no page target yet';
				continue;
			}
		} catch (e) {
			lastErr = `CDP not up (${e.message})`;
			continue;
		}
		if (!readBridgeInfo()) {
			lastErr = 'bridge file not written yet';
			continue;
		}
		return;
	}
	throw new Error(`app did not come up within ${BOOT_TIMEOUT_MS / 1000}s: ${lastErr}`);
}

function signalApp(child, signal) {
	if (!child) return;
	try {
		// Negative pid kills the whole process group: `npm run dev` spawns vite
		// and electron as children, and killing only npm orphans both.
		process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			/* already gone */
		}
	}
}

/** True while something is still answering CDP on our port. */
async function cdpAlive() {
	try {
		const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
		await res.text();
		return true;
	} catch {
		return false;
	}
}

/**
 * Stop the app and WAIT for it to actually be gone.
 *
 * A blind sleep here is the wrong shape: Electron keeps answering CDP for a
 * moment after SIGTERM, so the next theme's `waitForApp` can attach to the
 * DYING instance, which then exits underneath the driver - and a fixed delay is
 * simultaneously too short on a loaded machine and wasted time on an idle one.
 * The port going quiet is the real signal, so poll for it and escalate to
 * SIGKILL rather than guessing.
 */
async function killApp(child) {
	if (!child) return;
	signalApp(child, 'SIGTERM');
	const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
	let escalated = false;
	while (Date.now() < deadline) {
		await sleep(500);
		if (!(await cdpAlive())) {
			// The port closing is Electron letting go; give the rest of the group
			// (vite, tsc) the same beat to release their own ports.
			await sleep(1500);
			return;
		}
		if (!escalated && Date.now() > deadline - SHUTDOWN_TIMEOUT_MS / 2) {
			console.log('[capture] App ignored SIGTERM; escalating to SIGKILL.');
			signalApp(child, 'SIGKILL');
			escalated = true;
		}
	}
	console.log('[capture] WARNING: app still answering CDP after shutdown timeout.');
}

// --- capture ----------------------------------------------------------------

async function captureTheme(theme) {
	// Nothing may be on the CDP port when we launch. `waitForApp` cannot tell a
	// leftover instance from the one it is about to start, so it would attach to
	// the leftover, photograph the PREVIOUS theme under this theme's name, and
	// report a clean run. A `--keep` run from earlier is the usual culprit.
	if (await cdpAlive()) {
		throw new Error(
			`something is already answering CDP on port ${CDP_PORT} - close the app left over from a --keep run first`
		);
	}
	seedFor(theme);
	const app = launchApp();
	let bridge = null;
	let cdp = null;
	const failures = [];

	try {
		console.log('[capture] Waiting for the app...');
		await waitForApp();

		bridge = new Bridge(readBridgeInfo());
		await bridge.connect();
		cdp = new Cdp(CDP_PORT);
		await cdp.connect();
		await cdp.send('Runtime.enable');
		console.log('[capture] Waiting for first paint...');
		await cdp.awaitRendered(PAINT_TIMEOUT_MS);
		// Checked once the shell has painted rather than at connect time: the
		// window is still being sized while the splash is up, so an early read
		// reports a size nobody will be photographed at.
		const seen = await cdp.assertViewport(width, height);
		console.log(`[capture] Viewport: ${seen.w}x${seen.h} at ${seen.dpr}x`);
		// Past the splash, give the fleet and the transcript a beat to fill in.
		await sleep(2500);

		for (const shot of shots) {
			const file = path.join(outDir, `${shot.name}.${theme}.png`);
			try {
				// Same reason as in `awaitRendered`: an occluded window throttles
				// rAF and CSS transitions, so a modal's open animation would still
				// be mid-flight when the shutter fires.
				await cdp.bringToFront().catch(() => {});
				// EVERY shot starts from a clean window, including the ones that
				// open a surface. Layering is the default for anything that is not
				// a full-window destination, so without this each shot is taken
				// through whatever the previous shots left stacked on screen.
				await cdp.escape();
				if (shot.surface) {
					const res = await bridge.send(
						{ type: 'open_modal', surface: shot.surface, tab: shot.tab },
						'open_modal_result'
					);
					// The handler answers with success:false for a surface behind a
					// disabled Encore Feature. Shooting anyway would file the screen
					// BEHIND the modal under the modal's name, which is worse than a gap.
					if (res && res.success === false) {
						throw new Error(res.error || `refused: ${shot.surface}`);
					}
				}
				await sleep(shot.settleMs || SETTLE_MS);
				await cdp.screenshot(file);
				console.log(`[capture]   ${path.basename(file)}`);
			} catch (e) {
				failures.push({ shot: shot.name, error: e.message });
				console.error(`[capture]   SKIPPED ${shot.name}: ${e.message}`);
			}
		}
	} finally {
		bridge && bridge.close();
		cdp && cdp.close();
		if (!keepRunning) await killApp(app);
	}
	return failures;
}

async function main() {
	fs.mkdirSync(outDir, { recursive: true });
	console.log(`[capture] Themes:  ${themes.join(', ')}`);
	console.log(`[capture] Shots:   ${shots.length}`);
	console.log(`[capture] Size:    ${size}`);
	console.log(`[capture] Out:     ${outDir}`);

	const allFailures = [];
	for (const theme of themes) {
		console.log(`\n[capture] === ${theme} ===`);
		try {
			const failures = await captureTheme(theme);
			allFailures.push(...failures.map((f) => ({ ...f, theme })));
		} catch (e) {
			// A theme that never came up must not cost the themes after it. Each
			// launch is independent, so record the whole theme as failed and keep
			// going rather than throwing away a run that is most of the way done.
			console.error(`[capture] ${theme} FAILED to start: ${e.message}`);
			allFailures.push(...shots.map((s) => ({ theme, shot: s.name, error: e.message })));
		}
	}

	const expected = themes.length * shots.length;
	console.log(`\n[capture] Captured ${expected - allFailures.length} of ${expected}.`);
	if (allFailures.length) {
		console.log('[capture] Skipped:');
		for (const f of allFailures) console.log(`  ${f.theme}/${f.shot}: ${f.error}`);
		process.exit(1);
	}
}

main().catch((e) => {
	console.error(`[capture] FAILED: ${e.message}`);
	process.exit(1);
});
