import { describe, expect, it, vi } from 'vitest';
import { createOmpWorkspaceAdapter, type OmpPanelPort } from '../../panel/OmpPanelPort';

describe('OMP panel resource staging', () => {
	it('stages supported image bytes and sends only compact opaque refs in the prompt request', async () => {
		const request = vi.fn(async (kind, payload) => ({ kind, requestId: 'request-id', payload }));
		const stageResource = vi.fn(async (name: string, mediaType: string, bytes: Uint8Array) => ({
			ref: `00000000-0000-4000-8000-00000000000${bytes[0]}`,
			name,
			mediaType,
			size: bytes.byteLength,
			sha256: 'a'.repeat(64),
		}));
		const port: OmpPanelPort = {
			request,
			stageResource,
			subscribe: vi.fn(() => vi.fn()),
		};
		const attachments = [
			['one.png', 'image/png', 1],
			['two.jpg', 'image/jpeg', 2],
			['three.webp', 'image/webp', 3],
			['four.gif', 'image/gif', 4],
		].map(
			([name, type, byte]) =>
				({
					name,
					type,
					size: 1,
					arrayBuffer: async () => new Uint8Array([byte as number]).buffer,
				}) as File
		);

		await createOmpWorkspaceAdapter(port).sendMessage('session-1', 'inspect', attachments);

		expect(stageResource).toHaveBeenCalledTimes(4);
		const prompt = request.mock.calls.find(([kind]) => kind === 'omp.prompt.send')?.[1];
		expect(prompt).toEqual(
			expect.objectContaining({
				sessionId: 'session-1',
				text: 'inspect',
				attachments: expect.arrayContaining([
					expect.objectContaining({ ref: expect.any(String), sha256: 'a'.repeat(64) }),
				]),
			})
		);
		expect(JSON.stringify(prompt)).not.toContain('dataBase64');
		expect(new TextEncoder().encode(JSON.stringify(prompt)).byteLength).toBeLessThan(64 * 1024);
	});
});
