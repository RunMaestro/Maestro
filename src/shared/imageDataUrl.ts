const IMAGE_MIME_EXTENSIONS = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'image/svg+xml': 'svg',
} as const;

export type ImageMimeType = keyof typeof IMAGE_MIME_EXTENSIONS;

export interface ParsedImageDataUrl {
	mimeType: ImageMimeType;
	extension: (typeof IMAGE_MIME_EXTENSIONS)[ImageMimeType];
	base64: string;
	bytes: Uint8Array;
	byteLength: number;
}

export interface ParseImageDataUrlOptions {
	maximumBytes?: number;
	filename?: string;
}

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DATA_URL_PATTERN =
	/^data:(image\/(?:png|jpeg|gif|webp|svg\+xml));base64,([A-Za-z0-9+/]+={0,2})$/;

function hasMatchingExtension(filename: string, extension: string): boolean {
	const extensionStart = filename.lastIndexOf('.');
	if (extensionStart === -1) return true;
	const filenameExtension = filename.slice(extensionStart + 1).toLowerCase();
	return filenameExtension === extension || (extension === 'jpg' && filenameExtension === 'jpeg');
}

export function parseImageDataUrl(
	value: string,
	options: ParseImageDataUrlOptions = {}
): ParsedImageDataUrl | null {
	const match = DATA_URL_PATTERN.exec(value);
	if (!match) return null;

	const mimeType = match[1] as ImageMimeType;
	const base64 = match[2];
	if (!BASE64_PATTERN.test(base64)) return null;

	const extension = IMAGE_MIME_EXTENSIONS[mimeType];
	if (options.filename !== undefined && !hasMatchingExtension(options.filename, extension))
		return null;

	const paddingBytes = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
	const byteLength = (base64.length / 4) * 3 - paddingBytes;
	if (options.maximumBytes !== undefined && byteLength > options.maximumBytes) return null;

	try {
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}
		return { mimeType, extension, base64, bytes, byteLength };
	} catch {
		return null;
	}
}
