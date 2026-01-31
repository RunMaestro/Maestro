import { parseDataUrl } from './imageUtils';

interface ImageContent {
	type: 'image';
	source: {
		type: 'base64';
		media_type: string;
		data: string;
	};
}

interface TextContent {
	type: 'text';
	text: string;
}

type MessageContent = ImageContent | TextContent;

/**
 * Build a stream-json message for Claude Code with images and text
 */
export function buildStreamJsonMessage(prompt: string, images: string[]): string {
	const content: MessageContent[] = [];

	// Add text content first
	content.push({
		type: 'text',
		text: prompt,
	});

	// Add image content for each image
	for (const imageDataUrl of images) {
		const parsed = parseDataUrl(imageDataUrl);
		if (parsed) {
			content.push({
				type: 'image',
				source: {
					type: 'base64',
					media_type: parsed.mediaType,
					data: parsed.base64,
				},
			});
		}
	}

	const message = {
		type: 'user_message',
		content,
	};

	return JSON.stringify(message);
}
