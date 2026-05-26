// Injected at build time by scripts/build-maestro-p.mjs via esbuild `define`.
// The typeof guard keeps non-esbuild execution paths (ts-node, plain tsc output) from
// throwing a ReferenceError; in those paths the constant is never substituted.
declare const __MAESTRO_P_VERSION__: string;

export const VERSION: string =
	typeof __MAESTRO_P_VERSION__ !== 'undefined' ? __MAESTRO_P_VERSION__ : '0.0.0-dev';
