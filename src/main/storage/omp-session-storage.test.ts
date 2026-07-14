import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import { OmpSessionStorage } from './omp-session-storage';

vi.mock('fs/promises');

const projectPath = 'C:\\Users\\Administrator\\Software\\Maestro';
const sessionDirectory = 'C:\\Users\\Administrator\\.omp\\agent\\sessions\\-Software-Maestro';
const sessionFile = `${sessionDirectory}\\2026-07-06T00-44-10-917Z_019f34e1-f325-7000-867d-5cd3cae5e451.jsonl`;

const transcript = [
	'{"type":"title","v":1,"title":"Native OMP work","updatedAt":"2026-07-06T00:45:00.000Z"}',
	'{"type":"session","version":3,"id":"019f34e1-f325-7000-867d-5cd3cae5e451","timestamp":"2026-07-06T00:44:10.917Z","cwd":"C:\\\\Users\\\\Administrator\\\\Software\\\\Maestro"}',
	'{"type":"message","id":"user-1","timestamp":"2026-07-06T00:44:14.414Z","message":{"role":"user","content":[{"type":"text","text":"Implement OMP storage"}]}}',
	'{"type":"message","id":"assistant-1","timestamp":"2026-07-06T00:44:15.414Z","message":{"role":"assistant","content":[{"type":"text","text":"I will implement it."}]}}',
].join('\n');

afterEach(() => vi.restoreAllMocks());

describe('OmpSessionStorage', () => {
	it('lists and reads real-format OMP JSONL session records', async () => {
		vi.mocked(fs.readdir).mockResolvedValue([
			'2026-07-06T00-44-10-917Z_019f34e1-f325-7000-867d-5cd3cae5e451.jsonl',
		] as never);
		vi.mocked(fs.readFile).mockResolvedValue(transcript);
		vi.mocked(fs.stat).mockResolvedValue({
			size: 1234,
			mtime: new Date('2026-07-06T00:45:00.000Z'),
		} as never);
		const storage = new OmpSessionStorage();

		const sessions = await storage.listSessions(projectPath);
		const messages = await storage.readSessionMessages(
			projectPath,
			'019f34e1-f325-7000-867d-5cd3cae5e451'
		);

		expect(sessions).toEqual([
			expect.objectContaining({
				sessionId: '019f34e1-f325-7000-867d-5cd3cae5e451',
				sessionName: 'Native OMP work',
				firstMessage: 'Implement OMP storage',
				messageCount: 2,
			}),
		]);
		expect(messages.messages).toEqual([
			expect.objectContaining({ role: 'user', content: 'Implement OMP storage', uuid: 'user-1' }),
			expect.objectContaining({
				role: 'assistant',
				content: 'I will implement it.',
				uuid: 'assistant-1',
			}),
		]);
		expect(fs.readdir).toHaveBeenCalledWith(sessionDirectory);
		expect(fs.readFile).toHaveBeenCalledWith(sessionFile, 'utf-8');
	});

	it('searches normalized OMP message content', async () => {
		vi.mocked(fs.readdir).mockResolvedValue([
			'2026-07-06T00-44-10-917Z_019f34e1-f325-7000-867d-5cd3cae5e451.jsonl',
		] as never);
		vi.mocked(fs.readFile).mockResolvedValue(transcript);
		vi.mocked(fs.stat).mockResolvedValue({ size: 1234, mtime: new Date() } as never);
		const storage = new OmpSessionStorage();

		await expect(storage.searchSessions(projectPath, 'implement', 'all')).resolves.toEqual([
			expect.objectContaining({
				sessionId: '019f34e1-f325-7000-867d-5cd3cae5e451',
				matchType: 'user',
				matchCount: 2,
			}),
		]);
	});

	it('fails closed for malformed JSONL files', async () => {
		vi.mocked(fs.readdir).mockResolvedValue(['malformed.jsonl'] as never);
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
