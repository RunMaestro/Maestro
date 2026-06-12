// Warn early if the Python that node-gyp will pick up is 3.12+ without
// `setuptools` installed. node-gyp (pulled in transitively by better-sqlite3
// and node-pty) still imports `distutils`, which was removed from the
// standard library in Python 3.12 — so `npm install` dies with
// `ModuleNotFoundError: No module named 'distutils'` during the postinstall
// electron-rebuild step. See https://github.com/RunMaestro/Maestro/issues/170.

import { spawnSync } from 'node:child_process';

const skip =
	process.env.MAESTRO_SKIP_PYTHON_CHECK === '1' || process.env.MAESTRO_SKIP_PYTHON_CHECK === 'true';
if (skip) process.exit(0);

const candidate = process.env.PYTHON || process.env.npm_config_python || 'python3';

function resolvePython() {
	const bins = candidate === 'python' ? ['python'] : [candidate, 'python'];
	for (const bin of bins) {
		const probe = spawnSync(bin, ['--version'], { stdio: 'pipe', encoding: 'utf8' });
		if (probe.error || probe.status !== 0) continue;
		const raw = (probe.stdout || probe.stderr || '').trim();
		const match = raw.match(/Python (\d+)\.(\d+)/);
		if (!match) continue;
		return { bin, major: Number(match[1]), minor: Number(match[2]), raw };
	}
	return null;
}

const python = resolvePython();
if (!python) {
	// No Python found — let node-gyp raise its own error if it actually needs one.
	process.exit(0);
}

// distutils was removed in Python 3.12; node-gyp's vendored gyp still imports it.
const needsDistutilsWorkaround = python.major > 3 || (python.major === 3 && python.minor >= 12);
if (!needsDistutilsWorkaround) process.exit(0);

const hasSetuptools = spawnSync(python.bin, ['-c', 'import setuptools'], {
	stdio: 'pipe',
	encoding: 'utf8',
});
// Treat "setuptools present" AND spawn failures (status === null from a
// transient EAGAIN, sandbox, or binary-gone-away) as non-problems: the
// advisory is best-effort and we'd rather stay silent than misattribute
// a spawn error to a missing module.
if (hasSetuptools.error || hasSetuptools.status === null || hasSetuptools.status === 0) {
	process.exit(0);
}

const reset = '\x1b[0m';
const yellow = '\x1b[33m';
const bold = '\x1b[1m';
// eslint-disable-next-line no-console
console.warn(
	[
		'',
		`${yellow}${bold}[maestro] Python toolchain warning${reset}`,
		`  Detected ${python.raw} at '${python.bin}', but \`setuptools\` is not installed.`,
		`  node-gyp (via better-sqlite3 / node-pty) still imports \`distutils\`, which was`,
		`  removed from Python's standard library in 3.12 — your install is likely to fail`,
		`  during the electron-rebuild postinstall step with:`,
		`    ModuleNotFoundError: No module named 'distutils'`,
		'',
		`  Fix it with one of:`,
		`    ${bold}${python.bin} -m pip install setuptools${reset}`,
		`    ${bold}uv venv -p 3.11 && source .venv/bin/activate${reset}   (use Python 3.11)`,
		'',
		`  Set MAESTRO_SKIP_PYTHON_CHECK=1 to silence this check.`,
		'',
	].join('\n')
);
// Warn only — don't block installs for users who know what they're doing.
process.exit(0);
