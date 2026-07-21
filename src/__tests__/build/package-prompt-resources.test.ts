import fs from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';

const root = path.resolve(__dirname, '../../..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
	build: { extraResources: Array<{ from: string; filter?: string[] }> };
};

const promptResourceDirs = ['src/prompts/speckit', 'src/prompts/openspec', 'src/prompts/bmad'];

describe('packaged methodology prompt resources', () => {
	test('emit only markdown prompts and metadata', () => {
		const resources = packageJson.build.extraResources.filter((resource) =>
			promptResourceDirs.includes(resource.from)
		);

		expect(resources).toHaveLength(promptResourceDirs.length);

		for (const resource of resources) {
			expect(resource.filter).toEqual(['*.md', 'metadata.json']);

			const emittedFiles = fs
				.readdirSync(path.join(root, resource.from))
				.filter((filename) =>
					resource.filter!.some((pattern) =>
						pattern === '*.md' ? filename.endsWith('.md') : filename === pattern
					)
				);

			expect(emittedFiles).not.toContain('catalog.ts');
			expect(
				emittedFiles.every((filename) => filename.endsWith('.md') || filename === 'metadata.json')
			).toBe(true);
		}
	});
});
