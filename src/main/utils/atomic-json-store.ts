/** Compatibility facade. Canonical Node file I/O lives in maestro-lib. */
export {
	atomicWriteJson,
	atomicWriteFile,
	createKeyedWriteQueue,
	type KeyedWriteQueue,
} from '../../shared/maestro-lib/storage/atomic-json-store';
