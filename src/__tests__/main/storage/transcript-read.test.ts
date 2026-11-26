/**
 * A conversation read gives one answer for one transcript file in every mode.
 *
 * A transcript that does not exist is an empty conversation ("Beginning of conversation"). One
 * that exists and cannot be read rejects ("Could not load earlier messages" with Retry). A local
 * agent and a hosted agent (whose host reads its own disk) go through the local reader; an SSH
 * agent goes through the remote reader. Before this, a local read of a missing file threw while
 * an SSH read of any failure returned empty.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../../main/utils/remote-fs', () => ({ readFileRemote: vi.fn() }));

import { readFileRemote } from '../../../main/utils/remote-fs';
import {
	forEachLocalTranscriptLine,
	isMissingRemoteFile,
	readLocalTranscript,
	readRemoteTranscript,
} from '../../../main/storage/transcript-read';
import { AGENT_MODES, type AgentMode } from '../../helpers/mockSession';
import type { SshRemoteConfig } from '../../../shared/types';

const sshConfig = { id: 'r1', host: 'box', port: 22, username: 'me' } as unknown as SshRemoteConfig;

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-read-'));
	vi.mocked(readFileRemote).mockReset();
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Read one transcript the way an agent in `mode` does: the SSH agent's remote answers like the
 * file on disk would (`readFileRemote`'s wording for each case), the others read the disk.
 */
async function readAs(mode: AgentMode, file: string): Promise<string[]> {
	if (mode === 'ssh') {
		const local = (() => {
			try {
				return { success: true, data: fs.readFileSync(file, 'utf8') };
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				return {
					success: false,
					error:
						code === 'ENOENT'
							? `File not found: ${file}`
							: code === 'EISDIR'
								? `Path is a directory: ${file}`
								: String(error),
				};
			}
		})();
		vi.mocked(readFileRemote).mockResolvedValueOnce(local as never);
		const content = await readRemoteTranscript(file, sshConfig);
		return (content ?? '').split('\n').filter((line) => line.trim());
	}
	const lines: string[] = [];
	await forEachLocalTranscriptLine(file, (line) => lines.push(line));
	return lines;
}

describe('a conversation read across agent modes', () => {
	it.each(AGENT_MODES)(
		'reads a missing transcript as an empty conversation for a %s agent',
		async (mode) => {
			await expect(readAs(mode, path.join(dir, 'gone.jsonl'))).resolves.toEqual([]);
		}
	);

	it.each(AGENT_MODES)('reads the lines of a transcript for a %s agent', async (mode) => {
		const file = path.join(dir, 'there.jsonl');
		fs.writeFileSync(file, '{"a":1}\n\n{"b":2}\n');
		await expect(readAs(mode, file)).resolves.toEqual(['{"a":1}', '{"b":2}']);
	});

	it.each(AGENT_MODES)(
		'rejects a transcript that exists and cannot be read for a %s agent',
		async (mode) => {
			// A directory where the file should be: it exists, and no reader can read it as text.
			const file = path.join(dir, 'unreadable.jsonl');
			fs.mkdirSync(file);
			await expect(readAs(mode, file)).rejects.toThrow();
		}
	);
});

describe('the transcript readers', () => {
	it('reads a missing local file as null, and an existing one whole', async () => {
		expect(await readLocalTranscript(path.join(dir, 'gone.jsonl'))).toBeNull();
		const file = path.join(dir, 'there.jsonl');
		fs.writeFileSync(file, 'x');
		expect(await readLocalTranscript(file)).toBe('x');
	});

	it('reads a missing folder above a local file as missing too', async () => {
		expect(await readLocalTranscript(path.join(dir, 'no-folder', 'gone.jsonl'))).toBeNull();
		expect(await forEachLocalTranscriptLine(path.join(dir, 'no-folder', 'x.jsonl'), () => {})).toBe(
			false
		);
	});

	it('reads an empty remote file as an empty conversation, not a failure', async () => {
		vi.mocked(readFileRemote).mockResolvedValueOnce({ success: true, data: '' });
		expect(await readRemoteTranscript('/t.jsonl', sshConfig)).toBe('');
	});

	it('rejects a remote read that failed for any reason but a missing file, with its words', async () => {
		vi.mocked(readFileRemote).mockResolvedValueOnce({
			success: false,
			error: 'Permission denied: /t.jsonl',
		});
		await expect(readRemoteTranscript('/t.jsonl', sshConfig)).rejects.toThrow(
			'Permission denied: /t.jsonl'
		);
		vi.mocked(readFileRemote).mockResolvedValueOnce({
			success: false,
			error: 'ssh: connect to host box port 22: Connection refused',
		});
		await expect(readRemoteTranscript('/t.jsonl', sshConfig)).rejects.toThrow('Connection refused');
	});

	it('tells a missing remote file from every other remote failure', () => {
		expect(isMissingRemoteFile('File not found: /x')).toBe(true);
		expect(isMissingRemoteFile('cat: /x: No such file or directory')).toBe(true);
		// The local reader reads ENOTDIR as missing; the remote one must agree.
		expect(isMissingRemoteFile('cat: /a/b.jsonl: Not a directory')).toBe(true);
		expect(isMissingRemoteFile('Permission denied: /x')).toBe(false);
		expect(isMissingRemoteFile('Path is a directory: /x')).toBe(false);
		expect(isMissingRemoteFile(undefined)).toBe(false);
	});
});
