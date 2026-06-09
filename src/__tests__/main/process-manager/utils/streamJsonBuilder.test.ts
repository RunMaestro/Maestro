import { describe, expect, it } from 'vitest';
import { buildStreamJsonMessage } from '../../../../main/process-manager/utils/streamJsonBuilder';

describe('streamJsonBuilder', () => {
	it('builds a prompt-only user message', () => {
		const result = JSON.parse(buildStreamJsonMessage('Summarize this repo', []));

		expect(result).toEqual({
			type: 'user',
			message: {
				role: 'user',
				content: [
					{
						type: 'text',
						text: 'Summarize this repo',
					},
				],
			},
		});
	});

	it('places valid images before text with base64 sources', () => {
		const result = JSON.parse(
			buildStreamJsonMessage('Compare these images', [
				'data:image/png;base64,cG5nLWJ5dGVz',
				'data:image/jpeg;base64,anBlZy1ieXRlcw==',
			])
		);

		expect(result.message.content).toEqual([
			{
				type: 'image',
				source: {
					type: 'base64',
					media_type: 'image/png',
					data: 'cG5nLWJ5dGVz',
				},
			},
			{
				type: 'image',
				source: {
					type: 'base64',
					media_type: 'image/jpeg',
					data: 'anBlZy1ieXRlcw==',
				},
			},
			{
				type: 'text',
				text: 'Compare these images',
			},
		]);
	});

	it('skips invalid image data URLs and preserves valid images', () => {
		const result = JSON.parse(
			buildStreamJsonMessage('Use the valid image', [
				'data:text/plain;base64,Zm9v',
				'not-a-data-url',
				'data:image/webp;base64,d2VicA==',
			])
		);

		expect(result.message.content).toEqual([
			{
				type: 'image',
				source: {
					type: 'base64',
					media_type: 'image/webp',
					data: 'd2VicA==',
				},
			},
			{
				type: 'text',
				text: 'Use the valid image',
			},
		]);
	});

	it('keeps an empty prompt as text content', () => {
		const result = JSON.parse(buildStreamJsonMessage('', []));

		expect(result.message.content).toEqual([
			{
				type: 'text',
				text: '',
			},
		]);
	});
});
