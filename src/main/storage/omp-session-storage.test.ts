import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import fs from 'fs/promises';
import { OmpSessionStorage } from './omp-session-storage';

vi.mock('fs/promises');

const projectPath = 'C:\\Users\\Administrator\\Software\\Maestro';
const sessionDirectory = 'C:\\Users\\Administrator\\.omp\\agent\\sessions\\-Software-Maestro';
const runDirectory = `${sessionDirectory}\\2026-07-14T04-20-15-283Z_019f5eda-a533-7000-b2ba-f7ab9dd52a50`;
const sessionFile = `${runDirectory}\\OmpSessionStorageLayoutFix.jsonl`;
const absoluteProjectPath = 'C:\\tmp';
const absoluteSessionDirectory = 'C:\\Users\\Administrator\\.omp\\agent\\sessions\\--C--tmp--';
const absoluteRunDirectory = `${absoluteSessionDirectory}\\2026-07-13T05-19-56-955Z_019f59ea-f01c-7000-98d7-390ec0ed1498`;
const absoluteSessionFile = `${absoluteRunDirectory}\\OmpAbsolutePath.jsonl`;
const rootSessionFile = `${sessionDirectory}\\2026-07-14T04-20-15-283Z_019f5eda-a533-7000-b2ba-f7ab9dd52a50.jsonl`;

const transcript = readFileSync(
	join(
		__dirname,
		'fixtures',
		'omp-session-layout',
		'2026-07-14T04-20-15-283Z_019f5eda-a533-7000-b2ba-f7ab9dd52a50',
		'OmpSessionStorageLayoutFix.jsonl'
	),
	'utf-8'
);
const absoluteTranscript = readFileSync(
	join(
		__dirname,
		'fixtures',
		'omp-session-layout',
		'--C--tmp--',
		'2026-07-13T05-19-56-955Z_019f59ea-f01c-7000-98d7-390ec0ed1498',
		'OmpAbsolutePath.jsonl'
	),
	'utf-8'
);

function directoryEntry(name: string) {
	return { name, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
}

function fileEntry(name: string) {
	return { name, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
}

function mockNestedLayout() {
	vi.mocked(fs.readdir).mockImplementation(async (directory) => {
		if (directory === sessionDirectory) {
			return [
				directoryEntry('2026-07-14T04-20-15-283Z_019f5eda-a533-7000-b2ba-f7ab9dd52a50'),
				fileEntry('2026-07-14T04-20-15-283Z_019f5eda-a533-7000-b2ba-f7ab9dd52a50.jsonl'),
			] as never;
		}
		if (directory === runDirectory) return [fileEntry('OmpSessionStorageLayoutFix.jsonl')] as never;
		return [] as never;
	});
	vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
		if (filePath === rootSessionFile) throw new Error('Root-level JSONL must not be read');
		if (filePath === sessionFile) return transcript as never;
		throw new Error(`Unexpected file read: ${String(filePath)}`);
	});
	vi.mocked(fs.stat).mockResolvedValue({
		size: Buffer.byteLength(transcript),
		mtime: new Date('2026-07-14T04:24:53.200Z'),
	} as never);
}

afterEach(() => vi.restoreAllMocks());

describe('OmpSessionStorage', () => {
	it('lists and reads real nested OMP transcript records while excluding root JSONL indexes', async () => {
		mockNestedLayout();
		const storage = new OmpSessionStorage();

		const sessions = await storage.listSessions(projectPath);
		const messages = await storage.readSessionMessages(
			projectPath,
			'019f5ede-dbc7-7000-ae7e-cfe1b435837c'
		);

		expect(sessions).toEqual([
			expect.objectContaining({
				sessionId: '019f5ede-dbc7-7000-ae7e-cfe1b435837c',
				sessionName: 'OmpSessionStorageLayoutFix',
				firstMessage: 'Fix the nested OMP session catalogue.',
				messageCount: 2,
				modifiedAt: '2026-07-14T04:24:53.200Z',
			}),
		]);
		expect(messages.messages).toEqual([
			expect.objectContaining({
				role: 'user',
				content: 'Fix the nested OMP session catalogue.',
				uuid: 'user-1',
			}),
			expect.objectContaining({
				role: 'assistant',
				content: 'I will inspect the nested session layout.',
				uuid: 'assistant-1',
			}),
		]);
		expect(fs.readdir).toHaveBeenCalledWith(sessionDirectory, { withFileTypes: true });
		expect(fs.readdir).toHaveBeenCalledWith(runDirectory, { withFileTypes: true });
		expect(fs.readFile).toHaveBeenCalledWith(sessionFile, 'utf-8');
		expect(fs.readFile).not.toHaveBeenCalledWith(rootSessionFile, 'utf-8');
	});

	it('searches messages from nested OMP transcript records', async () => {
		mockNestedLayout();
		const storage = new OmpSessionStorage();

		await expect(storage.searchSessions(projectPath, 'nested', 'all')).resolves.toEqual([
			expect.objectContaining({
				sessionId: '019f5ede-dbc7-7000-ae7e-cfe1b435837c',
				matchType: 'user',
				matchCount: 2,
			}),
		]);
	});

	it('maps absolute paths outside the home directory to OMP session directories', async () => {
		vi.mocked(fs.readdir).mockImplementation(async (directory) => {
			if (directory === absoluteSessionDirectory) {
				return [
					directoryEntry('2026-07-13T05-19-56-955Z_019f59ea-f01c-7000-98d7-390ec0ed1498'),
				] as never;
			}
			if (directory === absoluteRunDirectory) return [fileEntry('OmpAbsolutePath.jsonl')] as never;
			return [] as never;
		});
		vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
			if (filePath === absoluteSessionFile) return absoluteTranscript as never;
			throw new Error(`Unexpected file read: ${String(filePath)}`);
		});
		vi.mocked(fs.stat).mockResolvedValue({
			size: Buffer.byteLength(absoluteTranscript),
			mtime: new Date('2026-07-13T05:20:24.000Z'),
		} as never);
		const storage = new OmpSessionStorage();

		await expect(storage.listSessions(absoluteProjectPath)).resolves.toEqual([
			expect.objectContaining({
				sessionId: '019f59ea-f01c-7000-98d7-390ec0ed1498',
				sessionName: 'Bind ethernet card to VM',
				firstMessage: 'Bind the ethernet card to the virtual machine.',
			}),
		]);
		expect(fs.readdir).toHaveBeenCalledWith(absoluteSessionDirectory, { withFileTypes: true });
	});

	it('does not descend beneath OMP run directories', async () => {
		const nestedDirectory = `${runDirectory}\\nested`;
		vi.mocked(fs.readdir).mockImplementation(async (directory) => {
			if (directory === sessionDirectory) {
				return [
					directoryEntry('2026-07-14T04-20-15-283Z_019f5eda-a533-7000-b2ba-f7ab9dd52a50'),
				] as never;
			}
			if (directory === runDirectory) return [directoryEntry('nested')] as never;
			if (directory === nestedDirectory)
				return [fileEntry('OmpSessionStorageLayoutFix.jsonl')] as never;
			return [] as never;
		});
		vi.mocked(fs.readFile).mockResolvedValue(transcript as never);
		vi.mocked(fs.stat).mockResolvedValue({
			size: Buffer.byteLength(transcript),
			mtime: new Date(),
		} as never);
		const storage = new OmpSessionStorage();

		await expect(storage.listSessions(projectPath)).resolves.toEqual([]);
		expect(fs.readdir).not.toHaveBeenCalledWith(nestedDirectory, { withFileTypes: true });
	});

	it('fails closed for malformed nested JSONL files', async () => {
		vi.mocked(fs.readdir).mockImplementation(async (directory) => {
			if (directory === sessionDirectory) return [directoryEntry('run')] as never;
			if (directory === `${sessionDirectory}\\run`) return [fileEntry('malformed.jsonl')] as never;
			return [] as never;
		});
		vi.mocked(fs.readFile).mockResolvedValue('{not-json}\n');
		vi.mocked(fs.stat).mockResolvedValue({ size: 12, mtime: new Date() } as never);
		const storage = new OmpSessionStorage();

		await expect(storage.listSessions(projectPath)).resolves.toEqual([]);
		await expect(storage.readSessionMessages(projectPath, 'malformed')).resolves.toEqual({
			messages: [],
			total: 0,
			hasMore: false,
		});
	});
});
