import { describe, expect, it } from 'vitest';
import { assertOmpAttachmentDtos, MAX_OMP_ATTACHMENT_BYTES } from '../../main/omp-workspace-bridge';

describe('OMP workspace bridge attachment boundary', () => {
	it('accepts a serializable bounded attachment with exact declared byte length', () => {
		const attachments = [
			{ name: 'image.png', mediaType: 'image/png', size: 3, bytes: new ArrayBuffer(3) },
		];
		expect(() => assertOmpAttachmentDtos(attachments)).not.toThrow();
	});

	it('rejects forged metadata, oversized bytes, and DOM-like values', () => {
		expect(() =>
			assertOmpAttachmentDtos([
				{ name: 'x', mediaType: 'image/png', size: 2, bytes: new ArrayBuffer(1) },
			])
		).toThrow('InvalidOmpAttachments');
		expect(() =>
			assertOmpAttachmentDtos([
				{
					name: 'x',
					mediaType: 'image/png',
					size: MAX_OMP_ATTACHMENT_BYTES + 1,
					bytes: new ArrayBuffer(0),
				},
			])
		).toThrow('InvalidOmpAttachments');
		expect(() =>
			assertOmpAttachmentDtos([{ name: 'x', mediaType: 'image/png', size: 0, bytes: {} }])
		).toThrow('InvalidOmpAttachments');
	});
});
