#!/usr/bin/env node
/**
 * Build script for maestro-lib as a library another tool can depend on.
 *
 * Bundles the public entry, src/shared/maestro-lib/index.ts, into
 * dist/maestro-lib/:
 *
 *   index.js       CommonJS, Node 20, self-contained. `require` loads it, and
 *                  so does `import` from an ES module (esbuild annotates the
 *                  export names for Node's CommonJS detection).
 *   index.d.ts     The entry's types, re-exported from types/.
 *   types/         Declarations for every module the entry reaches, emitted
 *                  by the TypeScript compiler with the CLI's options.
 *   package.json   Private (never published), versioned with
 *                  MAESTRO_LIB_VERSION; `maestroAppVersion` records the app
 *                  version the build was cut from.
 *
 * node-pty stays external: the library only uses its types, so nothing of it
 * is left in the bundle, and the package lists it as an optional peer for the
 * declarations that name it. Everything else, including the src/shared modules the
 * library reaches outside its own folder, is bundled.
 *
 * The bundle must stay free of the desktop app. The build reads esbuild's list
 * of bundled inputs and fails when one is Electron or lives under src/main,
 * and it loads the finished bundle in this plain Node process to read its
 * version, so a bundle that cannot load without Electron never gets written
 * out as a package.
 */

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const entry = path.join(rootDir, 'src/shared/maestro-lib/index.ts');

// `--out-dir <dir>` builds somewhere else, for a test that loads the result
// from a folder with no node_modules around it.
const outDirFlag = process.argv.indexOf('--out-dir');
const outDir =
	outDirFlag === -1
		? path.join(rootDir, 'dist/maestro-lib')
		: path.resolve(process.argv[outDirFlag + 1] ?? '');
if (outDirFlag !== -1 && !process.argv[outDirFlag + 1]) {
	throw new Error('--out-dir needs a directory');
}
const outfile = path.join(outDir, 'index.js');
const typesDir = path.join(outDir, 'types');

const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const appVersion = pkgJson.version;
if (typeof appVersion !== 'string' || appVersion.length === 0) {
	throw new Error('Cannot build maestro-lib: package.json is missing a valid "version" field');
}

/** Bundled inputs that would tie the library to the desktop app. */
function desktopInputs(metafile) {
	return Object.keys(metafile.inputs).filter((input) => {
		const normalized = input.split(path.sep).join('/');
		return (
			normalized.startsWith('src/main/') ||
			/(^|\/)node_modules\/electron\//.test(normalized) ||
			normalized === 'electron'
		);
	});
}

/** Emit declarations for the entry and everything it reaches. Returns error messages. */
function emitDeclarations() {
	const configPath = path.join(rootDir, 'tsconfig.cli.json');
	const parsed = ts.getParsedCommandLineOfConfigFile(
		configPath,
		{},
		{
			...ts.sys,
			onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
				throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
			},
		}
	);
	const options = {
		...parsed.options,
		noEmit: false,
		declaration: true,
		emitDeclarationOnly: true,
		sourceMap: false,
		declarationMap: false,
		incremental: false,
		composite: false,
		outDir: typesDir,
		rootDir: path.join(rootDir, 'src'),
		// TypeScript 6 includes no @types package unless asked. The whole-project
		// configs reach Node's types through other files; the entry's graph alone
		// does not, so it names them.
		types: parsed.options.types ?? ['node'],
	};
	// The entry, plus the ambient declarations the project relies on.
	const ambient = parsed.fileNames.filter((file) => file.includes('/src/types/'));
	const program = ts.createProgram([entry, ...ambient], options);
	const result = program.emit();
	const diagnostics = [...ts.getPreEmitDiagnostics(program), ...result.diagnostics].filter(
		(diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
	);
	return diagnostics.map((diagnostic) =>
		ts.formatDiagnostic(diagnostic, {
			getCanonicalFileName: (name) => name,
			getCurrentDirectory: () => rootDir,
			getNewLine: () => '\n',
		})
	);
}

async function build() {
	console.log('Building maestro-lib with esbuild...');

	try {
		fs.rmSync(outDir, { recursive: true, force: true });

		const result = await esbuild.build({
			entryPoints: [entry],
			bundle: true,
			platform: 'node',
			target: 'node20',
			outfile,
			format: 'cjs',
			sourcemap: true,
			minify: false, // Keep readable for debugging
			metafile: true,
			external: ['node-pty'],
		});

		const offenders = desktopInputs(result.metafile);
		if (offenders.length > 0) {
			throw new Error(`maestro-lib reaches the desktop app through:\n  ${offenders.join('\n  ')}`);
		}

		const errors = emitDeclarations();
		if (errors.length > 0) {
			throw new Error(`Declaration emit failed:\n${errors.join('')}`);
		}
		const entryTypes = path.join(typesDir, 'shared/maestro-lib/index.d.ts');
		if (!fs.existsSync(entryTypes)) {
			throw new Error(`Declaration emit produced no ${path.relative(rootDir, entryTypes)}`);
		}
		fs.writeFileSync(
			path.join(outDir, 'index.d.ts'),
			"export * from './types/shared/maestro-lib/index';\n"
		);

		// Loading the bundle here, in plain Node, is the check that it stands alone.
		const { MAESTRO_LIB_VERSION } = require(outfile);
		if (typeof MAESTRO_LIB_VERSION !== 'string' || MAESTRO_LIB_VERSION.length === 0) {
			throw new Error('The built bundle exports no MAESTRO_LIB_VERSION');
		}

		const libPackage = {
			name: 'maestro-lib',
			version: MAESTRO_LIB_VERSION,
			private: true,
			description: 'Run an AI coding agent turn from a plain Node program (Maestro).',
			license: pkgJson.license,
			main: 'index.js',
			types: 'index.d.ts',
			engines: { node: '>=20' },
			// Only the stop types name node-pty (a PTY a caller started itself), so
			// a consumer that never stops a PTY does not need it.
			peerDependencies: { 'node-pty': pkgJson.dependencies['node-pty'] },
			peerDependenciesMeta: { 'node-pty': { optional: true } },
			maestroAppVersion: appVersion,
		};
		fs.writeFileSync(
			path.join(outDir, 'package.json'),
			`${JSON.stringify(libPackage, null, '\t')}\n`
		);

		const sizeKB = (fs.statSync(outfile).size / 1024).toFixed(1);
		console.log(`✓ Built ${outfile} (${sizeKB} KB), maestro-lib ${MAESTRO_LIB_VERSION}`);
	} catch (error) {
		console.error('Build failed:', error);
		process.exit(1);
	}
}

build();
