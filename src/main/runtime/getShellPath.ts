// Moved into maestro-lib (Maestro-lib Part One): shell PATH probing carries no
// desktop-framework dependency, so it now lives in the shared library.
// Re-exported here so every existing `from '../runtime/getShellPath'` import
// keeps resolving unchanged.
export * from '../../shared/maestro-lib/launch/getShellPath';
export { default } from '../../shared/maestro-lib/launch/getShellPath';
