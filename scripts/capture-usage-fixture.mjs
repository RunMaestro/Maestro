#!/usr/bin/env node
/**
 * One-off capture script for the maestro-p phase 1 task 9 work: spawn `claude`
 * under a given CLAUDE_CONFIG_DIR, wait for the input prompt, send `/usage`,
 * snapshot the ANSI-stripped panel that renders inline, then `/quit`. Writes
 * the captured panel to a fixture file and prints the path. NOT used at
 * runtime — this is conductor tooling for harvesting real-world `/usage`
 * shapes so the parser fixtures aren't all hand-crafted.
 *
 * Usage:
 *   CLAUDE_CONFIG_DIR=/Users/pedram/.claude-gmail \
 *     node scripts/capture-usage-fixture.mjs <out-path>
 *
 * Mirrors the strip/scan logic in src/maestro-p/tui-driver.ts and the panel
 * extraction approach in src/maestro-p/index.ts (runStatus), but stays a pure
 * JS script so it runs without a TS build step.
 */

import * as pty from 'node-pty';
import * as fs from 'fs';
import * as path from 'path';

const STRIP_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// claude 2.1.141 uses ❯ (U+276F) as the input prompt indicator, NOT ›
// (U+203A) as the original playbook documented. Real-world capture during
// the phase 1 task 9 work — see the matching change in src/maestro-p/
// tui-driver.ts and the captures in src/__tests__/fixtures/maestro-p-usage/
// captured/.
const PROMPT_RE = /^❯\s/m;
const SPINNER_RE = /\(\d+s\s*·\s*[↑↓]\s*\d+\s*tokens\s*·\s*\w+\)/;
const READY_HOLD_MS = 1500;
const PANEL_QUIESCENCE_MS = 2000;
const HARD_TIMEOUT_MS = 30000;

function stripAnsi(text) {
	// /usage panel uses SGR colors and box-drawing — first regex covers it.
	let result = text.replace(STRIP_RE, '');
	result = result.replace(/\x1b[=>]/g, '');
	result = result.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '');
	result = result.replace(/\x07/g, '');
	return result;
}

async function main() {
	const outPath = process.argv[2];
	if (!outPath) {
		console.error('usage: capture-usage-fixture.mjs <out-path>');
		process.exit(1);
	}

	const binPath = process.env.MAESTRO_CLAUDE_BIN ?? 'claude';
	const cwd = process.cwd();

	const cols = Number.parseInt(process.env.MP_CAPTURE_COLS ?? '200', 10);
	const rows = Number.parseInt(process.env.MP_CAPTURE_ROWS ?? '50', 10);
	const child = pty.spawn(binPath, [], {
		name: 'xterm-256color',
		cols,
		rows,
		cwd,
		env: { ...process.env, TERM: 'xterm-256color' },
	});

	// Mirror TuiDriver's chunk-residual handling: split on \n, hold the
	// last partial segment until the next chunk completes it.
	let residual = '';
	let lines = [];
	let usageSent = false;
	let captureStart = 0;
	let resolved = false;

	const hardTimeout = setTimeout(() => {
		if (!resolved) {
			resolved = true;
			console.error('hard timeout reached — killing pty');
			try {
				child.kill('SIGKILL');
			} catch {}
			process.exit(2);
		}
	}, HARD_TIMEOUT_MS);

	let quiescenceTimer = null;
	let readyHoldTimer = null;

	const scheduleQuiescenceCheck = () => {
		if (quiescenceTimer) clearTimeout(quiescenceTimer);
		quiescenceTimer = setTimeout(() => {
			if (resolved) return;
			// Slice the buffer from the moment we sent /usage so we exclude
			// startup chrome (welcome banner, MOTD).
			const captured = lines.slice(captureStart).join('\n');
			fs.mkdirSync(path.dirname(outPath), { recursive: true });
			fs.writeFileSync(outPath, captured + '\n', 'utf-8');
			console.error(`captured ${captured.length} bytes → ${outPath}`);
			resolved = true;
			clearTimeout(hardTimeout);
			try {
				child.write('/quit\r');
			} catch {}
			setTimeout(() => {
				try {
					child.kill('SIGTERM');
				} catch {}
				process.exit(0);
			}, 1500);
		}, PANEL_QUIESCENCE_MS);
	};

	const scheduleUsageSend = () => {
		if (usageSent) return;
		if (readyHoldTimer) clearTimeout(readyHoldTimer);
		readyHoldTimer = setTimeout(() => {
			if (usageSent || resolved) return;
			usageSent = true;
			captureStart = lines.length;
			console.error(`prompt held idle ${READY_HOLD_MS}ms — sending /usage`);
			child.write('/usage\r');
			scheduleQuiescenceCheck();
		}, READY_HOLD_MS);
	};

	child.onData((chunk) => {
		const stripped = stripAnsi(chunk);
		residual += stripped;
		const segments = residual.split('\n');
		residual = segments.pop() ?? '';
		for (const raw of segments) {
			const line = raw.replace(/\r$/, '');
			// Skip spinner status lines — they aren't part of the panel.
			if (SPINNER_RE.test(line)) continue;
			lines.push(line);
		}
		// Reset quiescence timer on each new chunk after /usage was sent —
		// the panel sometimes renders in two passes.
		if (usageSent && !resolved) {
			scheduleQuiescenceCheck();
		}
		// Pre-/usage: look for the prompt indicator, then hold it idle for
		// READY_HOLD_MS to be sure startup chrome has settled.
		if (!usageSent && PROMPT_RE.test(lines.join('\n'))) {
			scheduleUsageSend();
		}
	});

	child.onExit(({ exitCode }) => {
		if (resolved) return;
		console.error(`pty exited unexpectedly (code ${exitCode}) before capture`);
		clearTimeout(hardTimeout);
		process.exit(3);
	});
}

main().catch((err) => {
	console.error('capture script failed:', err);
	process.exit(1);
});
