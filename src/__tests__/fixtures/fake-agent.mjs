#!/usr/bin/env node
/**
 * A provider stand-in for tests: replays one recorded turn.
 *
 * It writes the recording's stdout chunks in order, then its stderr, and ends
 * the way the recorded process ended: with the recorded exit code, or on the
 * recorded signal. The arguments it was started with are ignored, so it can
 * stand in for any provider's binary.
 *
 * Everything it is told arrives through the environment, because the command
 * line belongs to the code under test:
 *
 *   FAKE_AGENT_RECORDING   path to `{ chunks, stderr?, close: { code, signal } }`
 *   FAKE_AGENT_ARGV_OUT    write the arguments it was started with here (JSON)
 *   FAKE_AGENT_STDIN_OUT   read stdin to its end and write it here
 *   FAKE_AGENT_ENV_OUT     write its environment here (JSON)
 *   FAKE_AGENT_HOLD        after replaying, stay running until signalled
 *   FAKE_AGENT_TICK_FILE   tick the first unchecked task (`- [ ]`) of this file before replaying,
 *                          as an Auto Run agent does when it finishes a task
 */

import fs from 'node:fs';

const recordingPath = process.env.FAKE_AGENT_RECORDING;
if (!recordingPath) {
	process.stderr.write('fake-agent: FAKE_AGENT_RECORDING is not set\n');
	process.exit(64);
}

const recording = JSON.parse(fs.readFileSync(recordingPath, 'utf8'));

if (process.env.FAKE_AGENT_ARGV_OUT) {
	fs.writeFileSync(process.env.FAKE_AGENT_ARGV_OUT, JSON.stringify(process.argv.slice(2)));
}
if (process.env.FAKE_AGENT_ENV_OUT) {
	fs.writeFileSync(process.env.FAKE_AGENT_ENV_OUT, JSON.stringify(process.env));
}

if (process.env.FAKE_AGENT_TICK_FILE) {
	const file = process.env.FAKE_AGENT_TICK_FILE;
	fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('- [ ]', '- [x]'));
}

function readStdin() {
	return new Promise((resolve) => {
		let text = '';
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', (chunk) => {
			text += chunk;
		});
		process.stdin.on('end', () => resolve(text));
	});
}

function write(stream, text) {
	return new Promise((resolve) => {
		if (!text) resolve();
		else stream.write(text, () => resolve());
	});
}

if (process.env.FAKE_AGENT_STDIN_OUT) {
	fs.writeFileSync(process.env.FAKE_AGENT_STDIN_OUT, await readStdin());
}

for (const chunk of recording.chunks ?? []) {
	await write(process.stdout, chunk);
}
await write(process.stderr, recording.stderr ?? '');

if (process.env.FAKE_AGENT_HOLD) {
	// Still working, as far as anyone watching can tell.
	setInterval(() => {}, 1000);
} else if (recording.close?.signal) {
	process.kill(process.pid, recording.close.signal);
	// The signal is delivered asynchronously; do not exit cleanly before it lands.
	setInterval(() => {}, 1000);
} else {
	process.exit(recording.close?.code ?? 0);
}
