/**
 * @file stream-json-input.test.ts
 * @description Tests for src/maestro-p/stream-json-input.ts - translation of
 * Maestro's `--input-format stream-json` envelope into a TUI-ready prompt
 * with `@/tmp/.../*.png` image mentions.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	cleanupStreamJsonImages,
	translateStreamJsonInput,
} from '../../maestro-p/stream-json-input';

// 1x1 transparent PNG, base64-encoded. Small enough to keep tests fast; the
// translator only validates that bytes get written, not that they decode as
// real pixels.
const TINY_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function buildEnvelope(content: unknown): string {
	return JSON.stringify({
		type: 'user',
		message: { role: 'user', content },
	});
}

describe('translateStreamJsonInput', () => {
	const created: string[] = [];

	afterEach(() => {
		cleanupStreamJsonImages(created);
		created.length = 0;
	});

	it('returns null for non-JSON input', () => {
		expect(translateStreamJsonInput('hello world')).toBeNull();
	});

	it('returns null for an empty string', () => {
		expect(translateStreamJsonInput('')).toBeNull();
	});

	it('returns null for JSON without a message.content array', () => {
		expect(translateStreamJsonInput(JSON.stringify({ type: 'user' }))).toBeNull();
		expect(translateStreamJsonInput(JSON.stringify({ message: { role: 'user' } }))).toBeNull();
	});

	it('extracts a text-only envelope as a plain prompt', () => {
		const out = translateStreamJsonInput(buildEnvelope([{ type: 'text', text: 'describe this' }]));
		expect(out).not.toBeNull();
		expect(out!.prompt).toBe('describe this');
		expect(out!.imagePaths).toEqual([]);
	});

	it('writes a base64 image to /tmp and rewrites the prompt as `@path text`', () => {
		const out = translateStreamJsonInput(
			buildEnvelope([
				{
					type: 'image',
					source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_BASE64 },
				},
				{ type: 'text', text: 'what is this image?' },
			])
		);
		expect(out).not.toBeNull();
		expect(out!.imagePaths).toHaveLength(1);
		created.push(...out!.imagePaths);

		const imgPath = out!.imagePaths[0];
		expect(imgPath.startsWith(os.tmpdir() + path.sep)).toBe(true);
		expect(imgPath.endsWith('.png')).toBe(true);
		expect(fs.existsSync(imgPath)).toBe(true);
		const bytes = fs.readFileSync(imgPath);
		expect(bytes.equals(Buffer.from(TINY_PNG_BASE64, 'base64'))).toBe(true);

		expect(out!.prompt).toBe(`@${imgPath} what is this image?`);
	});

	it('preserves image order and joins multiple mentions with spaces', () => {
		const out = translateStreamJsonInput(
			buildEnvelope([
				{
					type: 'image',
					source: { type: 'base64', media_type: 'image/jpeg', data: TINY_PNG_BASE64 },
				},
				{
					type: 'image',
					source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_BASE64 },
				},
				{ type: 'text', text: 'compare' },
			])
		);
		expect(out).not.toBeNull();
		expect(out!.imagePaths).toHaveLength(2);
		created.push(...out!.imagePaths);

		expect(out!.imagePaths[0].endsWith('.jpeg')).toBe(true);
		expect(out!.imagePaths[1].endsWith('.png')).toBe(true);
		expect(out!.prompt).toBe(`@${out!.imagePaths[0]} @${out!.imagePaths[1]} compare`);
	});

	it('handles image-only envelopes (no text block) by emitting just the mention', () => {
		const out = translateStreamJsonInput(
			buildEnvelope([
				{
					type: 'image',
					source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_BASE64 },
				},
			])
		);
		expect(out).not.toBeNull();
		expect(out!.imagePaths).toHaveLength(1);
		created.push(...out!.imagePaths);
		expect(out!.prompt).toBe(`@${out!.imagePaths[0]}`);
	});

	it('rejects images with a malformed media_type (no temp file written)', () => {
		const out = translateStreamJsonInput(
			buildEnvelope([
				{
					type: 'image',
					source: {
						type: 'base64',
						media_type: '../etc/passwd',
						data: TINY_PNG_BASE64,
					},
				},
				{ type: 'text', text: 'what?' },
			])
		);
		expect(out).not.toBeNull();
		expect(out!.imagePaths).toEqual([]);
		expect(out!.prompt).toBe('what?');
	});

	it('skips unknown content block types without crashing', () => {
		const out = translateStreamJsonInput(
			buildEnvelope([
				{ type: 'tool_use', name: 'foo' },
				{ type: 'text', text: 'hello' },
			])
		);
		expect(out).not.toBeNull();
		expect(out!.imagePaths).toEqual([]);
		expect(out!.prompt).toBe('hello');
	});
});

describe('cleanupStreamJsonImages', () => {
	it('unlinks each path and silently ignores already-missing files', () => {
		const tmp = path.join(os.tmpdir(), `maestro-p-cleanup-test-${process.pid}.txt`);
		fs.writeFileSync(tmp, 'x');
		expect(fs.existsSync(tmp)).toBe(true);

		cleanupStreamJsonImages([tmp, '/nonexistent/path/that-does-not-exist']);

		expect(fs.existsSync(tmp)).toBe(false);
	});
});
