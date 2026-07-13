import { describe, expect, it, vi } from 'vitest';
import { createOmpWorkspaceAdapter, type OmpPanelPort } from '../../panel/OmpPanelPort';
import { MAX_OMP_IMAGE_BYTES } from '../../runtime/byte-codec';

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

	it('stages an exact 2 MiB aggregate attachment for a writable prompt request', async () => {
		const bytes = new Uint8Array(MAX_OMP_IMAGE_BYTES);
		const request = vi.fn(async (kind, payload) => ({ kind, requestId: 'request-id', payload }));
		const stageResource = vi.fn(async (name: string, mediaType: string, staged: Uint8Array) => ({
			ref: 'a3a2c574-aeb6-4ba7-9634-4f8ddbe8e1e8',
			name,
			mediaType,
			size: staged.byteLength,
			sha256: 'a'.repeat(64),
		}));
		const port: OmpPanelPort = {
			request,
			stageResource,
			subscribe: vi.fn(() => vi.fn()),
		};

		await createOmpWorkspaceAdapter(port).sendMessage('session-1', 'inspect', [
			{
				name: 'limit.png',
				type: 'image/png',
				size: bytes.byteLength,
				arrayBuffer: async () => bytes.buffer,
			} as File,
		]);

		expect(stageResource).toHaveBeenCalledTimes(1);
		expect(request).toHaveBeenCalledWith(
			'omp.prompt.send',
			expect.objectContaining({
				attachments: [
					expect.objectContaining({ size: MAX_OMP_IMAGE_BYTES, ref: expect.any(String) }),
				],
			})
		);
	});

	it('rejects an aggregate byte overflow before reading or staging any selected image', async () => {
		const request = vi.fn(async () => ({}));
		const stageResource = vi.fn(async () => ({}));
		const firstArrayBuffer = vi.fn(async () => new ArrayBuffer(0));
		const secondArrayBuffer = vi.fn(async () => new ArrayBuffer(0));
		const port: OmpPanelPort = {
			request,
			stageResource,
			subscribe: vi.fn(() => vi.fn()),
		};
		await expect(
			createOmpWorkspaceAdapter(port).sendMessage('session-1', 'inspect', [
				{
					name: 'one.png',
					type: 'image/png',
					size: MAX_OMP_IMAGE_BYTES - 1,
					arrayBuffer: firstArrayBuffer,
				} as File,
				{
					name: 'two.png',
					type: 'image/png',
					size: 2,
					arrayBuffer: secondArrayBuffer,
				} as File,
			])
		).rejects.toThrow(/aggregate size limit/);

		expect(firstArrayBuffer).not.toHaveBeenCalled();
		expect(secondArrayBuffer).not.toHaveBeenCalled();
		expect(stageResource).not.toHaveBeenCalled();
		expect(request).not.toHaveBeenCalled();
	});
});
