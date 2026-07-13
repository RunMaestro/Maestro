import { describe, it, expect, expectTypeOf } from 'vitest';
import { spawnSync } from 'child_process';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import {
	defineManifest,
	definePlugin,
	validatePluginManifest,
	PLUGIN_CAPABILITIES,
	PLUGIN_ID_PATTERN,
	PLUGIN_TIERS,
	HOST_API_VERSION,
	isHostApiCompatible,
	type MaestroSdk,
	type PluginManifest,
	type PluginModule,
	type AgentToolContribution,
	type KeybindingContribution,
	type HostViewBlocks,
	type HostViewContribution,
	type WorkspaceRootCapability,
	type MaestroInteractiveRuntimeApi,
} from '../index';

const sdkRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function buildSdk(): void {
	const result = spawnSync('bun', ['run', 'build'], {
		cwd: sdkRoot,
		encoding: 'utf8',
	});
	expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

function assertNoRepoInternalImports(filePath: string): void {
	const content = readFileSync(filePath, 'utf8');
	expect(content).not.toMatch(/\bfrom\s+['"][^'"]*(?:src\/|src\\|shared\/plugins)/);
	expect(content).not.toMatch(/\bimport\s*\(\s*['"][^'"]*(?:src\/|src\\|shared\/plugins)/);
}
describe('@maestro/plugin-sdk authoring surface', () => {
	// A well-formed tier-1 manifest authored through defineManifest. The id
	// matches PLUGIN_ID_PATTERN, the version is valid semver, and minHostApi is
	// pinned to the host contract this SDK build tracks.
	const sample: PluginManifest = defineManifest({
		id: 'com.example.transcript-reader',
		name: 'Transcript Reader',
		version: '0.1.0',
		tier: 1,
		maestro: { minHostApi: HOST_API_VERSION },
		entry: 'dist/entry.js',
		permissions: [{ capability: 'transcripts:read', reason: 'Summarize the active session.' }],
	});

	it('defineManifest is an identity that preserves the manifest', () => {
		expect(sample.id).toBe('com.example.transcript-reader');
		expect(PLUGIN_ID_PATTERN.test(sample.id)).toBe(true);
		expect(PLUGIN_TIERS).toContain(sample.tier);
	});

	it('validatePluginManifest accepts the well-formed tier-1 manifest', () => {
		const result = validatePluginManifest(sample);
		expect(result.errors).toEqual([]);
		expect(result.manifest).not.toBeNull();
		expect(result.manifest?.id).toBe(sample.id);
		expect(result.manifest?.tier).toBe(1);
		expect(result.manifest?.maestro.minHostApi).toBe(HOST_API_VERSION);
		expect(result.manifest?.permissions).toEqual([
			{ capability: 'transcripts:read', reason: 'Summarize the active session.' },
		]);
	});

	it('rejects a manifest whose id breaks PLUGIN_ID_PATTERN', () => {
		const bad = validatePluginManifest({ ...sample, id: '1nope' });
		expect(bad.manifest).toBeNull();
		expect(bad.errors.some((e) => e.includes('id'))).toBe(true);
	});

	it('exposes the P0 capabilities in PLUGIN_CAPABILITIES', () => {
		expect(PLUGIN_CAPABILITIES).toContain('transcripts:read');
		for (const cap of [
			'history:read',
			'sessions:create',
			'sessions:write',
			'tabs:manage',
			'transcripts:write',
			'decisions:write',
			'shell:openExternal',
			'storage:sql',
			'fs:watch',
			'power:preventSleep',
			'background:service',
		] as const) {
			expect(PLUGIN_CAPABILITIES).toContain(cap);
		}
	});

	it('definePlugin is an identity over a PluginModule', () => {
		const calls: string[] = [];
		const mod: PluginModule = definePlugin({
			activate() {
				calls.push('activate');
			},
		});
		mod.activate?.(undefined as unknown as MaestroSdk);
		expect(calls).toEqual(['activate']);
		expect(mod.deactivate).toBeUndefined();
	});

	it('types transcripts.read and transcripts.append on the MaestroSdk runtime surface', () => {
		expectTypeOf<MaestroSdk>().toHaveProperty('transcripts');
		expectTypeOf<MaestroSdk['transcripts']>().toHaveProperty('read');
		expectTypeOf<MaestroSdk['transcripts']['read']>().toBeFunction();
		expectTypeOf<MaestroSdk['transcripts']['read']>().parameter(0).toMatchObjectType<{
			sessionId: string;
			fields: string[];
			projectPath?: string;
			limit?: number;
			since?: number;
		}>();
		expectTypeOf<MaestroSdk['transcripts']['read']>().returns.resolves.toEqualTypeOf<
			Array<Record<string, unknown>>
		>();
		expectTypeOf<MaestroSdk['transcripts']>().toHaveProperty('append');
		expectTypeOf<MaestroSdk['transcripts']['append']>().parameter(0).toMatchObjectType<{
			sessionId: string;
			projectPath?: string;
			entries: Array<Record<string, unknown>>;
		}>();
	});

	it('types the P0 SDK namespaces', () => {
		expectTypeOf<MaestroSdk>().toHaveProperty('history');
		expectTypeOf<MaestroSdk['history']>().toHaveProperty('list');
		expectTypeOf<MaestroSdk>().toHaveProperty('tabs');
		expectTypeOf<MaestroSdk['tabs']>().toHaveProperty('focus');
		expectTypeOf<MaestroSdk['storage']>().toHaveProperty('sql');
		expectTypeOf<MaestroSdk['fs']>().toHaveProperty('watch');
		expectTypeOf<MaestroSdk>().toHaveProperty('shell');
		expectTypeOf<MaestroSdk['shell']>().toHaveProperty('openExternal');
		expectTypeOf<MaestroSdk>().toHaveProperty('decisions');
		expectTypeOf<MaestroSdk>().toHaveProperty('power');
		expectTypeOf<MaestroSdk>().toHaveProperty('background');
	});

	it('keeps activation root-free while exposing an optional explicit interactive runtime API', () => {
		expectTypeOf<MaestroSdk['interactiveRuntime']>().toEqualTypeOf<
			MaestroInteractiveRuntimeApi | undefined
		>();
		expectTypeOf<MaestroSdk['interactiveRuntime']>().toMatchTypeOf<
			MaestroInteractiveRuntimeApi | undefined
		>();
		expectTypeOf<MaestroSdk>().not.toHaveProperty('workspaceRoot');
		expectTypeOf<
			MaestroInteractiveRuntimeApi['requestWorkspaceRoot']
		>().returns.resolves.toEqualTypeOf<WorkspaceRootCapability | null>();
	});

	it('exports the new tool + keybinding contribution types', () => {
		expectTypeOf<AgentToolContribution>().toHaveProperty('inputSchema');
		expectTypeOf<KeybindingContribution>().toHaveProperty('key');
		expectTypeOf<MaestroSdk>().toHaveProperty('tools');
		expectTypeOf<MaestroSdk['tools']>().toHaveProperty('register');
	});

	it('types host-rendered views and their ui:hostView runtime methods', () => {
		expectTypeOf<HostViewContribution>().toHaveProperty('surface');
		expectTypeOf<HostViewContribution>().toHaveProperty('blocks');
		expectTypeOf<MaestroSdk['ui']>().toHaveProperty('hostView');
		expectTypeOf<MaestroSdk['ui']['hostView']>().toHaveProperty('update');
		expectTypeOf<MaestroSdk['ui']['hostView']['update']>().parameter(0).toBeString();
		expectTypeOf<MaestroSdk['ui']['hostView']['update']>()
			.parameter(1)
			.toEqualTypeOf<HostViewBlocks>();
		expectTypeOf<MaestroSdk['ui']['hostView']['update']>().returns.resolves.toBeVoid();
		expectTypeOf<MaestroSdk['ui']['hostView']>().toHaveProperty('remove');
		expectTypeOf<MaestroSdk['ui']['hostView']['remove']>().parameter(0).toBeString();
		expectTypeOf<MaestroSdk['ui']['hostView']['remove']>().returns.resolves.toBeVoid();
	});

	it('loads from a packed standalone SDK copy without repo-internal imports', async () => {
		const distDir = join(sdkRoot, 'dist');
		const hadDist = existsSync(distDir);
		try {
			buildSdk();
			const distIndexJs = join(distDir, 'index.js');
			const distIndexDts = join(distDir, 'index.d.ts');
			expect(existsSync(distIndexJs)).toBe(true);
			expect(existsSync(distIndexDts)).toBe(true);
			assertNoRepoInternalImports(distIndexJs);
			assertNoRepoInternalImports(distIndexDts);

			const pkg = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8')) as {
				files: string[];
				exports: { '.': { import: string; types: string } };
				main: string;
				types: string;
			};
			expect(pkg.files).toEqual(['dist']);
			expect(pkg.main).toBe('dist/index.js');
			expect(pkg.types).toBe('dist/index.d.ts');
			expect(pkg.exports['.']).toEqual({
				import: './dist/index.js',
				types: './dist/index.d.ts',
			});

			const tempDir = mkdtempSync(join(tmpdir(), 'maestro-sdk-standalone-'));
			try {
				const pluginRoot = join(tempDir, 'plugin');
				const installedSdk = join(pluginRoot, 'node_modules', '@maestro', 'plugin-sdk');
				mkdirSync(installedSdk, { recursive: true });
				cpSync(distDir, join(installedSdk, 'dist'), { recursive: true });
				cpSync(join(sdkRoot, 'package.json'), join(installedSdk, 'package.json'));
				writeFileSync(
					join(pluginRoot, 'plugin.json'),
					JSON.stringify({
						id: 'com.example.standalone-sdk',
						name: 'Standalone SDK',
						version: '1.0.0',
						tier: 1,
						maestro: { minHostApi: HOST_API_VERSION },
						entry: 'main.mjs',
						permissions: [{ capability: 'notifications:toast' }],
					})
				);
				writeFileSync(
					join(pluginRoot, 'main.mjs'),
					[
						"import { definePlugin, HOST_API_VERSION as sdkHostApiVersion } from '@maestro/plugin-sdk';",
						'export const loadedHostApiVersion = sdkHostApiVersion;',
						'export default definePlugin({',
						'  activate(maestro) {',
						'    void maestro.notifications.toast(`loaded ${sdkHostApiVersion}`);',
						'  },',
						'});',
					].join('\n')
				);

				// Dynamic import intentionally exercises plugin loading from a runtime install boundary.
				const mod = await import(
					`${pathToFileURL(join(pluginRoot, 'main.mjs')).href}?t=${Date.now()}`
				);
				expect(mod.loadedHostApiVersion).toBe(HOST_API_VERSION);
				expect(mod.default.activate).toBeTypeOf('function');
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		} finally {
			if (!hadDist) rmSync(distDir, { recursive: true, force: true });
		}
	});

	it('matches host API semver compatibility edge cases without dependencies', () => {
		expect(isHostApiCompatible('1.7.0+build.1', '1.7.0+build.2').compatible).toBe(true);
		expect(isHostApiCompatible('1.7.0-beta.1', '1.7.0').compatible).toBe(true);
		expect(isHostApiCompatible('1.7.0', '1.7.0-beta.1').compatible).toBe(false);
		expect(isHostApiCompatible('v1.7.0', '1.7.0').compatible).toBe(true);
		expect(isHostApiCompatible('1.7.0', 'v1.7.0').compatible).toBe(true);
		expect(isHostApiCompatible('1.7.0junk', '1.7.0').compatible).toBe(false);
	});
});
