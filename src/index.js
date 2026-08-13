/**
 * What Phase 1 offers to anything that wants to use it as a library.
 *
 * Reading is free. Changing anything goes through the gate, which is the only
 * code that writes, and which always writes a decision row alongside.
 *
 * Note what is absent: there is no delete, no expiry, no cleanup and nothing
 * that runs on a timer. Removing a row permanently is done by a person from a
 * terminal with `scripts/purge.mjs`, which nothing here can call.
 */

export { LOCAL_OWNER, defaultStorePath, systemClock } from './config.js';
export { forget, restore, submit } from './gate.js';
export {
  getMemory,
  listDecisions,
  listMemories,
  openStore,
  searchMemories,
} from './store.js';
