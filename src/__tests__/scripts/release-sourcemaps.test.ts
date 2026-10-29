/**
 * The release workflow builds hidden renderer source maps, uploads them to
 * Sentry, and deletes them before packaging. These tests pin the ordering and
 * gating that keep the two promises: maps never ship inside the app, and a
 * fork (no SENTRY_AUTH_TOKEN) or a Sentry outage never fails a release.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { UserConfig } from 'vite';
import viteConfig from '../../../vite.config.mts';

const root = path.resolve(__dirname, '../../..');

interface WorkflowStep {
	name?: string;
	run?: string;
	if?: string;
	env?: Record<string, string>;
	'continue-on-error'?: boolean;
}

function buildSteps(): WorkflowStep[] {
	const workflow = yaml.load(
		readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')
	) as { jobs: { build: { steps: WorkflowStep[] } } };
	return workflow.jobs.build.steps;
}

function indexOfStep(steps: WorkflowStep[], name: string): number {
	const index = steps.findIndex((step) => step.name === name);
	expect(index, `step "${name}"`).toBeGreaterThanOrEqual(0);
	return index;
}

describe('release workflow: renderer source maps', () => {
	const steps = buildSteps();

	it('builds the renderer with hidden source maps', () => {
		const build = steps[indexOfStep(steps, 'Build application')];
		expect(build.env?.MAESTRO_RENDERER_SOURCEMAPS).toBe('1');
	});

	it('uploads only when the token is present and never fails the release', () => {
		const upload = steps[indexOfStep(steps, 'Upload renderer source maps to Sentry')];
		expect(upload['continue-on-error']).toBe(true);
		expect(upload.env?.SENTRY_AUTH_TOKEN).toBe('${{ secrets.SENTRY_AUTH_TOKEN }}');
		expect(upload.run).toMatch(/if \[ -z "\$\{SENTRY_AUTH_TOKEN:-\}" \]; then[\s\S]*exit 0/);
		// The release must match app.getVersion() and the frame paths app://app/assets/*.
		expect(upload.run).toContain('--release "$VERSION"');
		expect(upload.run).toContain("--url-prefix 'app://app/'");
		expect(upload.env?.VERSION).toBe('${{ steps.version.outputs.VERSION }}');
	});

	it('injects and uploads after the build, then deletes every map before any packaging step', () => {
		const build = indexOfStep(steps, 'Build application');
		const upload = indexOfStep(steps, 'Upload renderer source maps to Sentry');
		const remove = indexOfStep(steps, 'Remove renderer source maps before packaging');
		const firstPackage = steps.findIndex((step) => step.name?.startsWith('Package for'));

		expect(firstPackage).toBeGreaterThan(0);
		expect(build).toBeLessThan(upload);
		expect(upload).toBeLessThan(remove);
		expect(remove).toBeLessThan(firstPackage);

		const removeStep = steps[remove];
		expect(removeStep.if).toBeUndefined();
		// A map that survives must stop the release, not be waved through.
		expect(removeStep['continue-on-error']).toBeUndefined();
		expect(removeStep.run).toContain("find dist/renderer -type f -name '*.map' -delete");
	});

	it('excludes renderer maps from the packaged files as a second guard', () => {
		const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
		expect(pkg.build.files).toContain('!dist/renderer/**/*.map');
	});
});

describe('renderer vite config: source maps', () => {
	const original = process.env.MAESTRO_RENDERER_SOURCEMAPS;

	afterEach(() => {
		if (original === undefined) delete process.env.MAESTRO_RENDERER_SOURCEMAPS;
		else process.env.MAESTRO_RENDERER_SOURCEMAPS = original;
	});

	// The config reads the flag when Vite calls it, so each case builds a fresh one.
	function resolveConfig(): UserConfig {
		const factory = viteConfig as unknown as (env: {
			mode: string;
			command: 'build';
		}) => UserConfig;
		return factory({ mode: 'production', command: 'build' });
	}

	it('writes hidden maps only when the release flag is set', () => {
		delete process.env.MAESTRO_RENDERER_SOURCEMAPS;
		expect(resolveConfig().build?.sourcemap).toBe(false);

		process.env.MAESTRO_RENDERER_SOURCEMAPS = '1';
		// 'hidden', never true: a sourceMappingURL comment would point the shipped
		// bundle at a map that the workflow deletes before packaging.
		expect(resolveConfig().build?.sourcemap).toBe('hidden');
	});

	it('drops the xterm chunk map, which describes the minified code the plugin discards', () => {
		interface Hooks {
			name: string;
			renderChunk(code: string, chunk: { name: string }): null;
			generateBundle(options: unknown, bundle: Record<string, unknown>): void;
		}
		const plugins = resolveConfig().build?.rollupOptions?.plugins as unknown as Hooks[];
		const plugin = plugins.find((p) => p.name === 'skip-xterm-minify');
		expect(plugin).toBeDefined();

		plugin!.renderChunk('const unminified = 1;\n', { name: 'vendor-xterm' });
		const chunk = {
			type: 'chunk',
			name: 'vendor-xterm',
			fileName: 'assets/vendor-xterm-abc.js',
			code: 'const a=1;',
			map: { mappings: 'AAAA' },
		};
		const otherMap = { type: 'asset', fileName: 'assets/index-def.js.map' };
		const bundle: Record<string, unknown> = {
			[chunk.fileName]: chunk,
			[`${chunk.fileName}.map`]: { type: 'asset', fileName: `${chunk.fileName}.map` },
			[otherMap.fileName]: otherMap,
		};
		plugin!.generateBundle({}, bundle);

		expect(chunk.code).toBe('const unminified = 1;\n');
		expect(chunk.map).toBeNull();
		expect(bundle[`${chunk.fileName}.map`]).toBeUndefined();
		// Every other chunk keeps its map for the upload.
		expect(bundle[otherMap.fileName]).toBe(otherMap);
	});
});
