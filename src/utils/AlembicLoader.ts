/**
 * AlembicLoader.ts — DEPRECATED compatibility shim.
 *
 * The Alembic (.abc) loader has been rewritten on top of i-saint's
 * `WebAlembicViewer` (wabc) C ABI. This file re-exports the public API
 * from the new `WabcLoader.ts` so any stale imports continue to work.
 *
 * New code should import directly from `./WabcLoader`.
 */

export {
  loadAlembicFromBuffer,
  closeAlembic,
  type AlembicMeta,
  type AlembicLoadResult,
} from "./WabcLoader";
