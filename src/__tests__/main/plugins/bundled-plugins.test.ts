import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Hoisted so the vi.mock factories can reference them safely. `sigStatus` maps a
// plugin dir to the verdict verifyPluginSignature should return; `target.dir` is
// where pluginsDir() points. Together they let the seed logic (trust gate,
// replace-untrusted, version, symlink skip) run over real fs without real crypto
// or Electron.
const h = vi.hoisted(() => ({
	sigStatus: {} as Record<string, string>,
	target: { dir: '' },
}));

vi.mock('../../../main/plugins/plugin-signature', () => ({
	verifyPluginSignature: (dir: string) => ({ status: h.sigStatus[dir] ?? 'unsigned' }),
}));
vi.mock('../../../main/plugins/plugin-store-main', () => ({
	pluginsDir: () => h.target.dir,
	isSafePluginFolderName: (name: string) => /^[a-z][a-z0-9._-]*$/i.test(name),
}));

import { seedBundledPlugins } from '../../../main/plugins/bundled-plugins';

let tmp = '';
let bundledRoot = '';
const originalResourcesPath = process.resourcesPath;
const trustedKeys = () => ['publisher-key'];

function writePlugin(dir: string, id: string, version: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, 'plugin.json'),
		JSON.stringify({
			id,
			name: id,
			version,
			tier: 1,
			entry: 'main.js',
			maestro: { minHostApi: '1.0.0' },
		})
	);
	fs.writeFileSync(path.join(dir, 'main.js'), '// entry');
}

function bundle(id: string, version: string, status: string): string {
	const src = path.join(bundledRoot, 'plugins', id);
	writePlugin(src, id, version);
	h.sigStatus[src] = status;
	return src;
}

beforeEach(() => {
	h.sigStatus = {};
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-bundled-'));
	bundledRoot = path.join(tmp, 'resources');
	h.target.dir = path.join(tmp, 'userData', 'plugins');
	fs.mkdirSync(path.join(bundledRoot, 'plugins'), { recursive: true });
	Object.defineProperty(process, 'resourcesPath', { value: bundledRoot, configurable: true });
});

afterEach(() => {
	Object.defineProperty(process, 'resourcesPath', {
		value: originalResourcesPath,
		configurable: true,
	});
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('seedBundledPlugins', () => {
	it('does not seed an untrusted bundled plugin (empty anchor stays safe)', () => {
		bundle('agent-flow', '0.1.0', 'untrusted');
		seedBundledPlugins({ trustedKeys });
		expect(fs.existsSync(path.join(h.target.dir, 'agent-flow'))).toBe(false);
	});

	it('seeds a trusted bundled plugin when none is installed', () => {
		bundle('agent-flow', '0.1.0', 'trusted');
		seedBundledPlugins({ trustedKeys });
		expect(fs.existsSync(path.join(h.target.dir, 'agent-flow', 'plugin.json'))).toBe(true);
	});

	it('replaces a same-version install that is not itself trusted', () => {
		bundle('agent-flow', '0.1.0', 'trusted');
		const dest = path.join(h.target.dir, 'agent-flow');
		writePlugin(dest, 'agent-flow', '0.1.0');
		fs.writeFileSync(path.join(dest, 'manual.txt'), 'user copy');
		h.sigStatus[dest] = 'unsigned';
		seedBundledPlugins({ trustedKeys });
		expect(fs.existsSync(path.join(dest, 'manual.txt'))).toBe(false);
	});

	it('leaves an already-trusted install at the same version untouched', () => {
		bundle('agent-flow', '0.1.0', 'trusted');
		const dest = path.join(h.target.dir, 'agent-flow');
		writePlugin(dest, 'agent-flow', '0.1.0');
		fs.writeFileSync(path.join(dest, 'keep.txt'), 'unchanged');
		h.sigStatus[dest] = 'trusted';
		seedBundledPlugins({ trustedKeys });
		expect(fs.existsSync(path.join(dest, 'keep.txt'))).toBe(true);
	});

	it('refreshes a trusted install when the bundled version is newer', () => {
		bundle('agent-flow', '0.2.0', 'trusted');
		const dest = path.join(h.target.dir, 'agent-flow');
		writePlugin(dest, 'agent-flow', '0.1.0');
		fs.writeFileSync(path.join(dest, 'stale.txt'), 'old');
		h.sigStatus[dest] = 'trusted';
		seedBundledPlugins({ trustedKeys });
		expect(fs.existsSync(path.join(dest, 'stale.txt'))).toBe(false);
	});
});
