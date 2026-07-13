import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import verifyOmpProductionResource from './verify-omp-production-resource.mjs';

const options = parseOptions(process.argv.slice(2));
const artifact = resolve(requiredOption(options, 'artifact'));
const release = resolve(requiredOption(options, 'release'));
const output = resolve('dist/omp-production');
if (artifact.toLowerCase().includes('fixture') || release.toLowerCase().includes('fixture')) {
	throw new Error('production OMP resources cannot be prepared from fixture inputs');
}
mkdirSync(output, { recursive: true });
copyFileSync(artifact, resolve(output, 'com.maestro.omp.omp'));
copyFileSync(release, resolve(output, 'release.json'));
verifyOmpProductionResource();

function parseOptions(args) {
	const options = {};
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (!key?.startsWith('--') || !value || options[key.slice(2)] !== undefined) {
			throw new Error('expected unique --key value arguments');
		}
		options[key.slice(2)] = value;
	}
	return options;
}

function requiredOption(options, key) {
	const value = options[key];
	if (!value) throw new Error(`missing --${key}`);
	return value;
}
