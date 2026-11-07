/** Compatibility facade. Canonical Node file I/O lives in maestro-lib. */
export {
	atomicWriteJson,
	atomicWriteFile,
	atomicWriteFileSync,
	createKeyedWriteQueue,
	type KeyedWriteQueue,
} from '../../shared/maestro-lib/storage/atomic-json-store';
