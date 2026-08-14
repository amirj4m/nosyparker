#!/usr/bin/env node
/**
 * The launcher for the MCP server.
 *
 * It takes Node's experimental SQLite warning off stderr and then starts the
 * server proper, which is in `mcp-main.js`.
 *
 * Same shape as `cli.js`, and for the same reason: the filter has to be
 * installed before `node:sqlite` is loaded, and a dynamic import cannot be
 * hoisted above the line before it, whereas a static import can be moved by
 * anyone tidying the file.
 *
 * What the warning costs here is different from what it costs at the terminal.
 * It goes to stderr, so it cannot corrupt the protocol on stdout — but an
 * agent's client writes stderr into its own log, and a warning there is how a
 * person debugging a connection concludes the server is the problem.
 */

import { silenceSqliteExperimentalWarning } from './warnings.js';

silenceSqliteExperimentalWarning();

await import('./mcp-main.js');
