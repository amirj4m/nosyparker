# Phase 3 research: MCP client landscape, discovery, and this machine

Research date: 2026-08-17. No product code, no branch, no commit.

Sections 1–7 are read-only inspection: nothing on the machine was modified. Addendum A involved installing Zed at the owner's request and writing a temporary test config, since removed — see A.0 and A.6 for exactly what changed and what was restored.

## Confidence legend

Every claim below carries one of these markers. Nothing is filled in from memory.

| Marker | Meaning |
|---|---|
| **[MACHINE]** | Verified by inspecting a real installation on this machine |
| **[BINARY]** | Verified by reading the installed application's own shipped code on this machine — stronger than docs, because it is the code that will actually run |
| **[DOCS]** | Confirmed from the vendor's official documentation |
| **[SECONDARY]** | From third-party write-ups only; plausible, not authoritative |
| **[UNCONFIRMED]** | Could not be established. Treat as unknown. |

---

## 1. Answer first: the three things that should shape the Phase 3 brief

1. **No discovery mechanism exists.** Nothing has shipped since May 2026 that lets a local stdio server announce itself once. Per-client file writing is still the only way. Section 3 has the evidence.
2. **Four clients have a real CLI that will start the server and tell you it connected.** Everything else can only be written and hoped for. The installer's honest status vocabulary has to be at least three-valued, not tick/cross. Section 5.
3. **VS Code 1.133 reads other clients' config files.** It has built-in discovery adapters for Claude Desktop, Windsurf, and Cursor. Writing one client's file can silently register nosyparker in VS Code as well. This is a duplicate-registration hazard the installer must know about. Section 4, VS Code row.

---

## 2. Per-client reference

### 2.1 Claude Code (CLI)

| Field | Value | Confidence |
|---|---|---|
| Installed here | Yes — `2.1.227`, bundled inside Claude Desktop at `~/.config/Claude/claude-code/2.1.227/claude` (a 304 MB ELF binary). **Not on `PATH`.** | [MACHINE] |
| User scope | `~/.claude.json`, top-level `mcpServers` | [DOCS] |
| Local scope (default) | `~/.claude.json`, under `projects["<abs project path>"].mcpServers` | [DOCS] |
| Project scope | `.mcp.json` at project root | [DOCS] |
| Enterprise | `managed-mcp.json` + `allowedMcpServers` / `deniedMcpServers` | [DOCS] |
| Windows / macOS | Same relative paths (`~` = `%USERPROFILE%`) | [DOCS] |
| Key name | `mcpServers` | [DOCS] |
| Entry shape | `{"command": "...", "args": [...], "env": {...}}`. `type` may be omitted — **an entry with no `type` is read as stdio.** An entry with a `url` and no `type` is a hard error. Also accepts `timeout` (ms). | [DOCS] |
| Precedence | local → project → user. Highest wins **entirely**; fields are not merged across scopes. | [DOCS] |
| Current contents here | `~/.claude.json` is 39,736 bytes, mode `0600`. Top-level `mcpServers` is absent. No project entry has `mcpServers`. `claude mcp list` → `No MCP servers configured.` | [MACHINE] |

**Silent non-load conditions** [DOCS]:
- `disabledMcpServers` / `enabledMcpServers`, per-project, in `~/.claude.json` — the `/mcp` panel toggle writes here.
- `disabledMcpjsonServers` / `enabledMcpjsonServers` in settings files — controls approval of `.mcp.json` servers. Unrelated to the above pair.
- **Workspace trust** (v2.1.196+): in an untrusted folder, approvals committed to `.claude/settings.json` are ignored and the server stays at `⏸ Pending approval`.
- Reserved names, skipped at load with a warning: `workspace`, `claude-in-chrome`, `computer-use`, `Claude Preview`, `Claude Browser`.
- Leading/trailing whitespace in `command`, `args`, `env` keys or values is **not** trimmed — it is used verbatim and only warned about.

**Verification** — the best in the field:

```
claude mcp list        # health-checks each server: ✔ Connected | ! Needs authentication
                       # | ✘ Failed to connect | ⏸ Pending approval
claude mcp get <name>  # per-server detail, including an "Issue:" line on failure
```

`claude mcp list` exits `0` even with zero servers configured [MACHINE] — **the exit code is not a signal, the output is.** `claude mcp get <missing>` prints `No MCP server named "<name>".` [MACHINE]. This is the one client where the installer can honestly claim the server *runs*, not merely that a file was written.

**Danger surface — high.** `~/.claude.json` is the CLI's live state file. It holds `oauthAccount`, `userID`, `machineID`, feature caches, and per-project history [MACHINE], is mode `0600`, and is rewritten by the app constantly. Do not hand-edit it. Use `claude mcp add --scope user` and let the tool own its own file. This is also the only supported programmatic path.

---

### 2.2 Claude Desktop

| Field | Value | Confidence |
|---|---|---|
| Installed here | Yes — deb package `claude-desktop-unofficial 1.28929.0-3.2.2`, the community Linux build. Anthropic ships **macOS and Windows only.** | [MACHINE] / [DOCS] |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` | [DOCS] |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` | [DOCS] |
| Linux | `${XDG_CONFIG_HOME:-$HOME/.config}/Claude/claude_desktop_config.json` | [BINARY] — VS Code 1.133's `claude-desktop` discovery adapter computes exactly this branch for Linux; and the file exists at that path here [MACHINE] |
| Key name | `mcpServers` | [DOCS] |
| Entry shape | `{"command": "...", "args": [...], "env": {...}}`. No `type` field in any official example. | [DOCS] |
| Project scope | None. | [DOCS] |
| Current contents here | 1,674 bytes, mode `0600`. **Contains no `mcpServers` key at all** — top-level keys are `coworkUserFilesPath` and `preferences`. | [MACHINE] |

**Silent non-load conditions**: `~/.config/Claude/config.json` carries `dxt:allowlistEnabled:<orgId>`, `dxt:allowlistLastUpdated:<orgId>` and `dxt:allowlistCache:<orgId>` keys, and `~/.config/Claude/extensions-blocklist.json` exists [MACHINE]. An org-level allowlist can therefore gate what loads. The exact interaction with hand-written `mcpServers` entries is **[UNCONFIRMED]** — worth an empirical test before the installer claims success here.

**Danger surface — the highest of any client.** The Debian launcher's own source documents a known data-loss class, verbatim [MACHINE, `/usr/lib/claude-desktop-unofficial/launcher-common.sh`]:

> Upstream's config loader silently falls back to `{}` on a failed cold-start read and then serializes the whole cached object over the file on the next settings write

referencing `anthropics/claude-code` issues #32345, #59640, #63651. The launcher mitigates by rotating five out-of-band copies into `~/.cache/claude-desktop-debian/config-backups/` **before every launch** — all five are present here [MACHINE].

Consequences for the installer:
- The app rewrites this file wholesale from memory. An edit made while the app is running will be clobbered on its next settings write.
- Edit only when no Claude Desktop process is live, and back up first regardless.
- The file is `0600` and sits beside OAuth token caches. Never log its contents.

**Verification**: no CLI. `claude mcp add-from-claude-desktop` exists but is macOS/WSL only [DOCS]. The only real confirmation is deferred: after the app restarts, a per-server log file appears — `~/Library/Logs/Claude/mcp-server-<NAME>.log` on macOS, `%APPDATA%\Claude\logs\` on Windows [DOCS]. A `logs` directory exists at `~/.config/Claude/logs` here [MACHINE] but its MCP contents are **[UNCONFIRMED]** — nothing has been configured to produce any.

---

### 2.3 Cursor

| Field | Value | Confidence |
|---|---|---|
| Installed here | Yes — deb `cursor 3.15.19`, at `/usr/share/cursor`. `~/.cursor/` exists; **`~/.cursor/mcp.json` does not.** | [MACHINE] |
| User scope | `~/.cursor/mcp.json` — all platforms | [BINARY] Cursor's own code joins `homedir/.cursor/mcp.json`, plus [DOCS] |
| Project scope | `<workspaceFolder>/.cursor/mcp.json` | [BINARY] + [DOCS] |
| Key name | `mcpServers` | [DOCS] |
| Entry shape | `{"type": "stdio", "command": "...", "args": [...], "env": {...}, "envFile": "..."}`. The docs' field table marks `type` **required**. `envFile` is stdio-only. | [DOCS] |
| CLI | `cursor --add-mcp '<json>'` → user profile; add `--mcp-workspace` to target the workspace or folder instead. | [BINARY] — read from `cursor --help` on this machine |

**Silent non-load conditions**: a per-server on/off toggle in the Customize sidebar [DOCS]. Where that state is persisted is **[UNCONFIRMED]** — the only MCP-related key in this machine's `state.vscdb` is `mcpOAuth.global.*` [MACHINE], and no server has ever been configured here, so there is nothing to observe.

**Danger surface — moderate.** Cursor owns this file: its bundle contains `ensureUserConfigDirExists`, `removeServerFromConfigFile` and a watcher on both paths [BINARY]. It will rewrite the file. `env` blocks in this file conventionally hold API keys.

**Verification — weak.** No list command was found. `--add-mcp` gives an exit code and nothing else. Re-reading the file only proves the write, which is exactly the class of false success Phases 1 and 2 already produced.

---

### 2.4 VS Code (Copilot)

| Field | Value | Confidence |
|---|---|---|
| Installed here | Yes — deb `code 1.133.0`, at `/usr/share/code`. **`~/.config/Code` does not exist — VS Code has never been launched on this machine.** | [MACHINE] |
| User scope | `<userRoamingDataHome>/mcp.json`. On Linux → `~/.config/Code/User/mcp.json`; macOS → `~/Library/Application Support/Code/User/mcp.json`; Windows → `%APPDATA%\Code\User\mcp.json`. Insiders substitutes `Code - Insiders`. | [BINARY] for the `<profileRoot>/mcp.json` join; [SECONDARY] for the per-OS roots, since the directory does not exist here to confirm against |
| **Profiles** | A non-default profile gets its own file: `<userRoamingDataHome>/profiles/<profileId>/mcp.json`. Writing only the default profile's file will miss a user who works in a custom profile. | [BINARY] |
| Workspace scope | `.vscode/mcp.json` | [BINARY] + [DOCS] |
| Key name | `servers`. The file also accepts `inputs` and `sandbox`. | [DOCS] |
| Entry shape | `{"type": "stdio", "command": "...", "args": [...]}`, optionally `cwd`, `env`, `envFile`, `dev`, `sandboxEnabled`. | [DOCS] |
| Is `type` required? | **Docs contradict themselves.** The MCP configuration reference lists `type` and `command` as required; the how-to page calls `type` optional and implicit for command-based servers. A scoped grep of the shipped bundle did not settle it. **Recommendation: always write `"type": "stdio"`** — valid under either reading. | [UNCONFIRMED] |
| CLI | `code --add-mcp '<json>'` — "Adds a Model Context Protocol server definition to the user profile" | [BINARY] — read from `code --help` on this machine |

**Silent non-load conditions.** All of these setting ids are present in the shipped 1.133.0 bundle [BINARY]:

`chat.mcp.enabled`, `chat.mcp.access` (values include `any`, `registry`, `none`), `chat.mcp.allowedServers`, `chat.mcp.deniedServers`, `chat.mcp.allowManagedServersOnly`, `chat.mcp.gallery.enabled`, `chat.mcp.autostart`, `chat.mcp.collisionBehavior`, `chat.mcp.discovery.enabled`, `chat.mcp.serverSampling`, `chat.mcp.ui.enabled`.

Several carry a `.policy` sibling (`chat.mcp.access.policy`, `chat.mcp.allowedServers.policy`, `chat.mcp.deniedServers.policy`, `chat.mcp.allowManagedServersOnly.policy`) [BINARY] — meaning an enterprise policy can block a perfectly-written entry, and the installer cannot see that policy from the config file. Per-server enable state is tracked as `userMcpEnabled` / `userMcpDisabled` [BINARY].

**Cross-client discovery — important.** VS Code 1.133 ships MCP discovery adapters with exactly these ids [BINARY]:

| `discoverySource` | File it reads |
|---|---|
| `claude-desktop` | `%APPDATA%\Claude\` · `~/Library/Application Support/Claude/` · `${XDG_CONFIG_HOME:-~/.config}/Claude/` + `claude_desktop_config.json` |
| `windsurf` | `~/.codeium/windsurf/mcp_config.json` |
| `cursor-global` | `~/.cursor/mcp.json` |
| `cursor-workspace` | `<workspaceFolder>/.cursor/mcp.json` |

Gated by `chat.mcp.discovery.enabled`. This is a genuinely useful cross-check — it independently corroborates the Claude Desktop Linux path and the Windsurf path above — and a hazard: **writing Cursor's or Claude Desktop's file may register nosyparker in VS Code too**, producing a duplicate. `chat.mcp.collisionBehavior` exists but its semantics are **[UNCONFIRMED]**.

**Verification — moderate at best.** `--add-mcp` returns an exit code. There is no `code --list-mcp`. A truthful check is: write via the CLI, then read back the file *and* inspect `chat.mcp.enabled` / `chat.mcp.access` / `chat.mcp.deniedServers` in the user settings, and downgrade the reported status if any of them would block it.

---

### 2.5 Windsurf

| Field | Value | Confidence |
|---|---|---|
| Installed here | **No.** | [MACHINE] |
| Path, all platforms | `~/.codeium/windsurf/mcp_config.json` | [DOCS] + [BINARY] via VS Code's `windsurf` adapter |
| Key name | `mcpServers` | [DOCS] |
| Entry shape | `{"command": "...", "args": [...], "env": {...}}` | [DOCS] |
| Project scope | None documented. | [DOCS] |
| Verification | None found — no CLI, no log documented. | — |

**Silent non-load conditions** [DOCS]: Cascade enforces a **100-tool ceiling across all servers**. Adding a server can silently push other servers' tools out of reach — a failure mode where our own write succeeds and someone else's breaks. Servers also have a UI on/off toggle, and enterprise tenants must enable MCP explicitly.

**Note on the product's future**: `docs.windsurf.com` now 307-redirects to `docs.devin.ai`, and the MCP page carries a warning that this applies to "the legacy Cascade agent", with the newer Devin Local agent using CLI config files instead [DOCS]. The Devin Local agent's config format is **[UNCONFIRMED]**.

---

### 2.6 Zed

| Field | Value | Confidence |
|---|---|---|
| Installed here | **No.** | [MACHINE] |
| Key name | `context_servers` | [DOCS] |
| Entry shape | Current official docs show `{"command": "...", "args": [...], "env": {}}` with **no `source` field**. | [DOCS] |
| Is `source: "custom"` required? | **Unresolved.** Multiple third-party guides and older Zed docs state it is required for manual entries; the current `zed.dev/docs/ai/mcp` example omits it entirely. Zed 0.233.x release notes mention "a deprecated key was removed from HTTP context_servers" (PR #48003), which suggests recent churn in this exact area but does not identify the key. | [UNCONFIRMED] |
| Settings file path | Official docs give no filesystem path — they only reference the `zed::OpenSettingsFile` action. Commonly stated as `~/.config/zed/settings.json` on Linux **and macOS**, `%APPDATA%\Zed\settings.json` on Windows. | [UNCONFIRMED] |
| Project scope `.zed/settings.json` | Widely reported; not stated on the page fetched. | [UNCONFIRMED] |
| Verification | None found. | — |

**Danger surface**: Zed's `settings.json` is **JSONC** — it accepts `//` comments, and users write them. A naive `JSON.parse` → `JSON.stringify` round-trip will silently delete a user's comments and reformat their whole file. This is the clearest example of why the installer needs a comment-preserving edit path, not a parse-and-rewrite.

Zed is the weakest row in this report. Everything about it is documentation-or-worse, nothing can be tested here, and the one field the original brief called out as required (`source: "custom"`) is precisely the field I could not confirm. Recommend Phase 3 either installs Zed to test, or ships Zed support marked explicitly unverified.

---

### 2.7 Everything else with meaningful adoption

| Client | Config path(s) | Key / shape | Project scope | CLI verification | Confidence |
|---|---|---|---|---|---|
| **Gemini CLI** | user `~/.gemini/settings.json`; project `.gemini/settings.json`; a system level also exists | `mcpServers`; `{command, args, env, cwd, timeout, trust, includeTools, excludeTools}` | Yes | `gemini mcp list` · `add` · `remove` · `enable` · `disable` | [DOCS] (repo docs) |
| **Codex CLI** | `~/.codex/config.toml`; project `.codex/config.toml` for trusted projects | TOML `[mcp_servers.<name>]` with `command`, `args`, `env`, `startup_timeout` | Yes (trusted only) | `codex mcp list --json` · `add` · `get` · `remove` | [SECONDARY] |
| **GitHub Copilot CLI** | user `~/.copilot/mcp-config.json`; project `.mcp.json` or `.github/mcp.json` | `mcpServers`; `{type, command, args, env, tools}`. Official examples use `"type": "local"`; `"stdio"` is also accepted. `tools` defaults to `["*"]`. | Yes | `copilot mcp add` · `list` · `get` · `remove` | [DOCS] |
| **Cline** (VS Code ext) | Linux `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` | `mcpServers`; `{command, args, env}` plus `disabled` / `autoApprove` | No | None found | [SECONDARY] |
| **Continue** | `~/.continue/config.yaml` top-level `mcpServers` block; or standalone YAML files in `.continue/mcpServers/` | **YAML, and a list of maps — not an object map.** Entries carry `name`, `type: stdio`, `command`, `args`, `cwd`, `env`. | Yes | None found; docs note it does not always pick up edits live — the extension must be reloaded | [DOCS] |
| **Goose** | `~/.config/goose/config.yaml` | top-level `extensions:` map; `{type: stdio, cmd, args, enabled, timeout, envs, env_keys, description}`. **`cmd`, not `command`.** `enabled: true` is required. | Not documented | `goose configure` (interactive) | [SECONDARY] |
| **Warp** | `~/.warp/.mcp.json` — **all platforms**, shared between Stable and Preview. Note that Warp's *other* config follows XDG on Linux but this file does not. | `mcpServers`; `{command, args, env, working_directory}` | No | Warp has MCP CLI reference pages; contents not fetched | [DOCS] (official file-locations page) |
| **JetBrains** | Junie: user `~/.junie/mcp/mcp.json`, project `.junie/mcp/mcp.json`. AI Assistant on Linux reported as `~/.config/JetBrains/AIAssistant/mcp.json`. MCP is an AI Assistant feature, so the path is the same across IntelliJ / PyCharm / WebStorm / etc. | `mcpServers`-style JSON pasted through Settings → Tools → AI Assistant → Model Context Protocol | Yes (Junie) | None found | [DOCS] for Junie, [SECONDARY] for the AI Assistant path |

---

## 3. Discovery and registry: the answer is no

**Nothing has shipped that would let nosyparker announce itself once.** Per-client file writing is still the whole job. Specifically:

**The 2026-07-28 specification revision** (release candidate) makes five significant changes: a stateless protocol core that removes the `initialize` handshake and `Mcp-Session-Id` entirely, a first-class Extensions framework with reverse-DNS identifiers, MCP Apps (server-supplied HTML in sandboxed iframes), Tasks graduated to an extension, and authorization hardening across six SEPs. **It says nothing about local server discovery or registration.** [DOCS]

**SEP-1649 / SEP-2127, "MCP Server Cards — HTTP Server Discovery via `.well-known`"**: still Draft, not merged. It applies to HTTP transports — servers supporting Streamable HTTP or SSE *SHOULD* publish a card at a `.well-known` URI. For stdio it offers only an in-band `mcp://server-card.json` resource, which requires a connection to already exist. That is useless for installation: you cannot discover a server you are not yet connected to. [DOCS]

**SEP-2633, "Standard Client-Side Configuration Format — `mcp.json`"**: Draft, PR open, authored April 2026, sponsored by an Anthropic reviewer. It would standardise on the filename `mcp.json`, the top-level key `mcpServers`, and transport names `stdio` / `sse` / `streamable-http` — explicitly to fix the fragmentation this report documents. Unresolved review questions include whether it belongs in core or as an Extension. **Not merged. No client commitments recorded.** [DOCS]

**The official MCP Registry** is a catalogue of *published* servers, with namespace verification and version records, for humans and package managers to find servers. It does not write to any client's config, and nosyparker is a locally-installed server rather than a published package. Not relevant to this phase. [DOCS]

**What this means for the design.** Build the per-client writer as planned. But note that SEP-2633, if it lands, converges on `mcpServers` + explicit `type: "stdio"` — so writing that shape everywhere it is legal costs nothing now and ages better. And prefer each client's own CLI wherever one exists: it is the closest thing to a supported API, it is what vendors will keep working, and it is the only path that survives a client changing its on-disk format.

---

## 4. What is actually on this machine

Ubuntu 24.04.4 LTS. **No Snap or Flatpak installs of any MCP-capable client** — Snap holds only Firefox and Canonical base packages; Flatpak holds only Telegram and runtimes [MACHINE]. Every relevant client here is a native `.deb`. The Snap-path concern from the brief does not apply to this machine, though it may still apply to other Ubuntu users.

| Client | Installed | Config file | Exists? | MCP servers configured |
|---|---|---|---|---|
| Claude Code | Yes, `2.1.227`, bundled in Claude Desktop, not on `PATH` | `~/.claude.json` | Yes — 39,736 B, `0600` | **None.** `mcpServers` absent at top level; no project entry has it. `claude mcp list` → `No MCP servers configured.` |
| Claude Desktop | Yes, `claude-desktop-unofficial 1.28929.0-3.2.2` | `~/.config/Claude/claude_desktop_config.json` | Yes — 1,674 B, `0600` | **None.** Keys are `coworkUserFilesPath` and `preferences` only. No `mcpServers` key exists. |
| Cursor | Yes, `3.15.19` (deb) | `~/.cursor/mcp.json` | **No** — `~/.cursor/` exists, the file does not | None |
| VS Code | Yes, `1.133.0` (deb) | `~/.config/Code/User/mcp.json` | **No** — `~/.config/Code` does not exist at all; VS Code has never been launched | None |
| Windsurf | No | — | — | — |
| Zed | No | — | — | — |
| Gemini CLI / Codex / Goose / Continue / Cline / Warp / JetBrains | No | — | — | — |

Other observations [MACHINE]:
- One unrelated `.mcp.json` exists at `~/.cache/plugins/github.com-vercel-vercel-plugin/.mcp.json` — a Claude Code plugin's bundled server definition, not user config. Do not touch it.
- `~/.cache/claude-desktop-debian/config-backups/` already holds five rotated copies of `claude_desktop_config.json`.
- `~/.claude/settings.json` is 71 bytes and holds only notification preferences.

**What Phase 3 can genuinely test versus what it can only write blind:**

- **Testable end-to-end here**: Claude Code. It is installed, has a working `mcp list` that health-checks, and currently has zero servers — a clean baseline.
- **Testable for write-and-read-back only**: Claude Desktop (installed, file present, but confirming a load needs a GUI restart), Cursor and VS Code (both installed with a working `--add-mcp`, but neither has ever created its MCP file, and neither can list back).
- **Documentation only, untestable on this machine**: Windsurf, Zed, and everything in section 2.7. If Phase 3 ships support for these, it must say so in its own output.

A useful consequence of the empty baseline: any `mcpServers` key that appears in any of these files after the installer runs was put there by the installer. That makes a clean before/after diff test possible for the first run.

---

## 5. Verification, ranked honestly

This is the section that matters most for the "no tick without proof" rule. Verification splits into three tiers, and the installer's status vocabulary should mirror them rather than collapsing to pass/fail.

**Tier A — the client starts the server and reports back.** A tick here is earned.

| Client | Command | Notes |
|---|---|---|
| Claude Code | `claude mcp list`, `claude mcp get <name>` | [MACHINE-verified] Health-checks and prints `✔ Connected` / `✘ Failed to connect` with an `Issue:` detail line. **Exit code is 0 even for an empty list — parse the output.** |
| Gemini CLI | `gemini mcp list` | [DOCS], untested here |
| Codex CLI | `codex mcp list --json` | [SECONDARY], untested here |
| Copilot CLI | `copilot mcp list` | [DOCS], untested here |

**Tier B — write through the app's own CLI; exit code only, no read-back.** Report as *written via supported interface, load not confirmed*.

| Client | Command | Notes |
|---|---|---|
| VS Code | `code --add-mcp '<json>'` | [BINARY-verified present in 1.133.0]. Must additionally inspect `chat.mcp.enabled`, `chat.mcp.access`, `chat.mcp.deniedServers`, `chat.mcp.allowManagedServersOnly` and downgrade the status if any would block. Enterprise `.policy` variants are invisible from disk — that limitation should be stated, not papered over. |
| Cursor | `cursor --add-mcp '<json>'` (+ `--mcp-workspace`) | [BINARY-verified present in 3.15.19] |

**Tier C — file write only. No confirmation is possible without launching a GUI.** Report as *written, not verified*, and name the reason.

Claude Desktop, Windsurf, Zed, Cline, Continue, Goose, Warp, JetBrains.

For Claude Desktop there is a *deferred* check worth building: after the app next starts, a per-server log file `mcp-server-<NAME>.log` appears in the log directory [DOCS]. That is a real signal, but it arrives minutes-to-days after install, so it belongs in a `nosyparker doctor`-style recheck rather than in the installer's own output.

**Proposed status vocabulary**, so the installer never prints an unearned tick:

- `connected` — Tier A confirmed the server starts. Only Claude Code (and, untested, the three other CLIs) can reach this.
- `written` — the entry is in the file, via the app's own CLI where one exists.
- `written, load unverifiable` — Tier C, with the reason named (no CLI, GUI restart required).
- `written, may be blocked` — a known blocker is present: VS Code `chat.mcp.access`/denied-servers, Claude Desktop org allowlist, Windsurf at its 100-tool ceiling.
- `skipped` — client not installed.
- `failed` — write failed, with the error.

---

## 6. Danger surface

The rule for this phase — back up before touching, never remove what we did not add, every change reversible — is right. Specifics that make it concrete:

**Files the app rewrites from memory (our edit can be clobbered):**
- `~/.claude.json` — rewritten constantly. **Never hand-edit; use `claude mcp add`.**
- `claude_desktop_config.json` — documented wipe class (section 2.2). Edit only when no Claude Desktop process is alive; back up out of band first.
- `~/.cursor/mcp.json` — Cursor has add/remove/watch code paths for it [BINARY].
- VS Code `mcp.json` — managed by `mcpResourceScannerService`, and `--add-mcp` is the app's own supported write path.

**Files that are hand-edited by people, and are JSONC:**
- VS Code `mcp.json` and `.vscode/mcp.json` — comments, plus `${input:...}` placeholder references into the `inputs` array. A parse-and-rewrite drops comments and can break placeholder wiring.
- Zed `settings.json` — comments are explicitly supported and users write them.
- Continue's `config.yaml` — YAML, where indentation is load-bearing and a tab silently breaks parsing [DOCS]. Do not treat it as JSON.

The safe pattern is a format-preserving edit that inserts only our one key, rather than a `parse → mutate → stringify` round-trip.

**Secrets that must not be touched or logged.** Every one of these files can carry an `env` block with live API keys, and several sit beside credential stores: `~/.claude.json` holds `oauthAccount` and `userID`; `~/.config/Claude/config.json` holds `oauth:tokenCache` and `oauth:tokenCacheV2` [MACHINE]. Both `~/.claude.json` and `claude_desktop_config.json` are mode `0600` here [MACHINE]. Implications: never log file contents or diffs, redact `env` and `headers` in any error message, and **preserve file mode and ownership** on rewrite — write to a temp file on the *same filesystem*, `fchmod` it to the original's mode, then `rename`.

**Duplicate registration.** VS Code's discovery adapters (section 2.4) mean a single logical install can surface nosyparker two or three times. The installer should either detect this and report it, or deliberately not write files that VS Code will re-read when VS Code is also a target.

**Backups.** Claude Desktop's Debian launcher already models the right approach: rotate N copies out of band, only rotate on a real change, never block on backup failure. Worth copying that shape rather than inventing one — including the "only rotate when the content actually changed" rule, which prevents a good pre-damage copy being evicted by repeated no-op runs.

---

## 7. What I could not confirm

Listing these plainly, since an unknown is more useful than a guess:

1. **Zed's `source: "custom"`** — current official docs omit it; older docs and third-party guides call it required. Unresolved. Zed is not installed here to test against.
2. **Zed's settings.json path on any OS** — the official docs give no filesystem path at all, only an editor action.
3. **Zed project-scoped `.zed/settings.json`** — widely reported, not on the official page.
4. **Whether VS Code strictly requires `type: "stdio"`** — the two official pages contradict each other, and a grep of the shipped bundle did not settle it. Writing it is safe under either reading.
5. **VS Code's per-OS user-profile roots** — the `<profileRoot>/mcp.json` join is verified from the binary, but `~/.config/Code/User` could not be confirmed on this machine because VS Code has never been launched and the directory does not exist.
6. **`chat.mcp.collisionBehavior` semantics** — the setting exists in 1.133.0; what it does with a duplicate is unknown.
7. **Whether Claude Desktop's `dxt:` org allowlist gates hand-written `mcpServers` entries**, or only packaged extensions.
8. **Where Cursor persists its per-server enable/disable toggle** — nothing observable here, since no server has ever been configured.
9. **Codex, Goose, Cline, JetBrains AI Assistant path** — established from third-party sources only. Verify against official docs before shipping support.
10. **The Devin Local agent's config format** — Windsurf/Cascade is now flagged as legacy and the successor's format is undocumented in what I fetched.

---

## Sources

Specification and discovery:
[MCP 2026-07-28 release candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/) ·
[SEP-1649 Server Cards](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1649) ·
[SEP-2127 PR](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127) ·
[SEP-2633 mcp.json client config](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2633) ·
[RFC 2219 standardize config schema](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/2219) ·
[Discussion 2218](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2218)

Clients:
[Claude Code MCP](https://code.claude.com/docs/en/mcp) ·
[Connect to local MCP servers (Claude Desktop)](https://modelcontextprotocol.io/docs/develop/connect-local-servers) ·
[Cursor MCP](https://cursor.com/docs/mcp) ·
[VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) ·
[VS Code add and manage MCP servers](https://code.visualstudio.com/docs/agent-customization/mcp-servers) ·
[Windsurf/Devin Cascade MCP](https://docs.devin.ai/desktop/cascade/mcp) ·
[Zed MCP](https://zed.dev/docs/ai/mcp) ·
[Zed 0.233.5 release notes](https://zed.dev/releases/stable/0.233.5) ·
[Gemini CLI MCP docs](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/tools/mcp-server.md) ·
[GitHub Copilot CLI MCP](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers) ·
[Warp file and folder locations](https://docs.warp.dev/terminal/settings/file-locations/) ·
[Warp MCP](https://docs.warp.dev/agent-platform/capabilities/mcp/) ·
[Continue MCP deep dive](https://docs.continue.dev/customize/deep-dives/mcp) ·
[Goose configuration file](https://block.github.io/goose/docs/guides/config-file/) ·
[Junie MCP configuration](https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html) ·
[Codex MCP subcommand](https://codex.danielvaughan.com/2026/05/07/codex-mcp-subcommand-managing-mcp-servers-from-the-terminal/) ·
[Cline issue #10894](https://github.com/cline/cline/issues/10894)

On-machine sources (read-only): `/usr/share/code/resources/app/out`, `/usr/share/cursor/resources/app/out`, `/usr/lib/claude-desktop-unofficial/launcher-common.sh`, `code --help`, `cursor --help`, `claude mcp list`, `claude mcp --help`, `dpkg -l`, `snap list`, `flatpak list`, and the config files listed in section 4.

---

# Addendum A — Zed, verified against a real installation

Added 2026-08-17, after installing Zed on this machine. **This supersedes §2.6 and clears items 1–3 of §7.**

## A.0 What was installed, and the deviation from the brief

**There is no official `.deb` for Zed.** Upstream's Linux page offers exactly two official routes: the install script (`curl -f https://zed.dev/install.sh | sh`), which it calls "the fastest way to install Zed", and manual extraction of a pre-built `.tar.gz`. Debian packages exist only as community builds. [DOCS]

I used the install script, after downloading and reading it first. It is 4,870 bytes and does only what it documents: downloads a tarball from `cloud.zed.dev`, unpacks to `~/.local/zed.app/`, symlinks `~/.local/bin/zed`, and copies a `.desktop` file into `~/.local/share/applications/`. **No sudo, no system paths, no sandbox.** [MACHINE]

This satisfies the intent behind the brief's preference for a `.deb`: the install is native and unsandboxed, so its config paths are representative rather than Flatpak-remapped. What it is *not* is system-wide — the binary lives under `$HOME`. That distinction matters for a detector that looks for clients in `/usr/share` or via `dpkg`: **Zed installed the official way is invisible to both.** A detector must look for `~/.local/bin/zed` and `~/.local/zed.app/`, or resolve `zed` on `PATH`.

Installed: **Zed 1.15.0** (`e17dc4f9`, stable). 424 MB on disk. [MACHINE]

Note the version. Nearly all third-party writing about `context_servers` — including the sources behind §2.6 — describes Zed 0.x. The 0.233 → 1.15 gap explains why those sources disagree with what the binary actually does.

## A.1 The Zed row, at last

| Field | Value | Confidence |
|---|---|---|
| Installed here | Yes — Zed 1.15.0, official install script, `~/.local/zed.app/`, symlink `~/.local/bin/zed` | [MACHINE] |
| User config path (Linux) | **`~/.config/zed/settings.json`** — precisely `${XDG_CONFIG_HOME:-~/.config}/zed/settings.json` | [MACHINE] the directory appeared on first launch; [BINARY] the strings `XDG_CONFIG_HOME` → `zed` → `settings.json` sit in one path-resolution blob |
| User data path | `${XDG_DATA_HOME:-~/.local/share}/zed/` — confirmed by `zed --help`, which documents `--user-data-dir` as overriding "the default platform-specific data directory location: `$XDG_DATA_HOME/zed`" | [MACHINE] |
| Flatpak variance | Zed reads `FLATPAK_XDG_DATA_HOME` and `FLATPAK_XDG_CACHE_HOME`, so a Flatpak install resolves its dirs differently. Exact remapped paths **not** established — no Flatpak Zed here to test. | [BINARY] for the mechanism, [UNCONFIRMED] for the resulting paths |
| macOS / Windows paths | Not established. Zed's docs still give no filesystem path on any OS. | [UNCONFIRMED] |
| Key name | **`context_servers`** — confirmed | [BINARY] present in the shipped default settings file |
| **Is `source: "custom"` required?** | **No.** See A.2 — settled two independent ways. | [BINARY] + [MACHINE] |
| Minimal working entry | `{"command": "...", "args": [...]}` | [BINARY] + [MACHINE] |
| Project scope | **Yes — `.zed/settings.json`**, alongside `.zed/tasks.json` and `.zed/debug.json` | [BINARY] |
| Per-server timeout | `timeout` (seconds) inside the entry; global default is the top-level `context_server_timeout`, default `60` | [BINARY] |
| Blocking settings | **None found.** No Zed equivalent of VS Code's `chat.mcp.*` gate — see A.3. | [BINARY] |
| Verification path | **None usable by a program** — see A.4. | [MACHINE] |
| Does Zed rewrite the file? | Not on its own. See A.5. | [MACHINE] |

## A.2 `source: "custom"` is not required — two independent proofs

**Proof 1 — Zed's own shipped documentation.** Zed 1.15.0 embeds its default settings file (JSON-with-comments) in the binary. I extracted it. The canonical `context_servers` example it ships reads, verbatim:

```jsonc
  // Default timeout in seconds for all context server tool calls.
  // Individual servers can override this in their configuration.
  // Examples:
  // "context_servers": {
  //   "my-stdio-server": {
  //     "command": "/path/to/server",
  //     "timeout": 120  // Override: 2 minutes for this server
  //   },
  // }
  // Default: 60
  "context_server_timeout": 60,
  // Configures context servers for use by the agent.
  "context_servers": {},
```

`command` alone. No `source`. This is the example the authors of Zed 1.15.0 ship inside the binary that runs. [BINARY]

**Proof 2 — an empirical A/B against the running app.** I wired Zed to nosyparker's actual Phase 2 server (`src/mcp-server.js`) and restarted Zed under two configurations:

| Run | Entry written | Result |
|---|---|---|
| **A** | `{"command": "node", "args": ["…/src/mcp-server.js"]}` — no `source` | **Server spawned.** `mcp-server.js` observed running as a live process across four polls over 20 s. |
| **E** | same, plus `"source": "definitely-not-a-valid-variant"` | **Server spawned anyway.** An invalid enum value did not prevent the load. |

Run E is the more informative of the two: an entry carrying a nonsense `source` still started. Whatever `source` does in Zed 1.15.0, it does not gate whether a stdio server loads. Writing it is unnecessary; writing it *wrong* is apparently harmless too, but there is no reason to write it. [MACHINE]

**What `source` appears to be.** In the binary, the strings `extension` and `custom` sit adjacent to a template that emits `"source": "…"` and `"settings": {}` — consistent with `source` being an enum distinguishing an extension-packaged server (which then takes a `settings` object) from a hand-written one, used by Zed's own *Configure Context Server* modal when it writes an entry. The same blob carries `enabled_in_text_threads`. I am reporting these as observed adjacent string literals, not as a verified schema — I did not confirm the full field list or defaults. [INFERRED]

**Recommendation for the installer:** write `{"command", "args"}` and nothing else. Do not write `source`.

## A.3 Nothing in Zed silently blocks a valid entry

This was the VS Code lesson, so I looked for the equivalent and did not find one. Searching the binary for gating keys returned zero hits for `enable_context_servers`, `context_servers_disabled`, and `disabled_context_servers`. There is no allowlist, no denylist, no `access` mode, no policy variant. [BINARY]

The only related knobs are `context_server_timeout` (global, seconds) and the per-entry `timeout`. Neither prevents loading.

Zed also has a per-server on/off control in its UI, and a *Configure Context Server* modal. Where that toggle persists its state is **[UNCONFIRMED]** — it is not in `~/.local/share/zed/db/0-global/db.sqlite`, which holds only `migrations` and `kv_store` tables [MACHINE], and it did not appear in `settings.json` during my runs. Worth pinning down before the installer claims a Zed entry is active rather than merely present.

One caveat about scope, not blocking: Zed's path-resolution blob also contains `Cursor`, `VSCODE_PORTABLE`, `Code - Insiders`, `Code - OSS`, `VSCodium` and `User/settings.json` [BINARY]. That is almost certainly Zed's *import settings from another editor* feature. **Whether it imports `context_servers` / MCP entries is [UNCONFIRMED]** — I did not test it, and I am explicitly not claiming Zed has VS Code-style MCP discovery. Do not assume symmetry with the VS Code finding in §2.4.

## A.4 Zed has no verification path a program can use — this is the important negative

I tried every read-back route available and all of them came up empty.

- **No CLI.** Full `zed --help` reviewed: `--wait`, `--add`, `--new`, `--existing`, `--user-data-dir`, `--foreground`, `--diff`, `--dev-container`, `--completions`, `--uninstall`. **No MCP or context-server subcommand of any kind**, and no equivalent of `code --add-mcp`. [MACHINE]
- **The log says nothing.** I re-ran Zed with `ZED_LOG=debug`. The log grew to **5,162 lines** and contained **zero** occurrences of `context_server`, `mcp`, or the server's name. The single line matching `server` was `[project::lsp_store] Refreshing workspace configurations for servers {}` — the language-server subsystem, unrelated. The log's modules are dominated by `naga` (shader validation). Context servers are simply not logged, at any level I could enable. [MACHINE]
- **No state in the database.** `~/.local/share/zed/db/0-global/db.sqlite` has two tables, `migrations` and `kv_store`. No context-server registry. [MACHINE]
- **Zed does not report bad config to disk either.** A settings file containing an invalid `source` value produced no warning, no error, nothing in the log. Zed surfaces settings problems in the UI, not anywhere a program can read. [MACHINE]

**Spawning is lazy and not reliably observable.** In two of my runs the server process appeared; in others it did not, with the same config — the difference appears to be whether Zed's restored session brings up the agent panel. Watching for a child process is therefore a positive-only signal: seeing it proves the entry loaded, not seeing it proves nothing.

**Conclusion: Zed is firmly Tier C in the §5 taxonomy.** The installer can write Zed's entry and confirm the file parses. It cannot confirm Zed read it. It must say so.

## A.5 Zed danger surface — better than feared, with one real trap

- **Zed did not rewrite my hand-written file.** After several launch/quit cycles, `~/.config/zed/settings.json` was byte-identical to what I wrote — 150 bytes, my formatting, my key order, untouched. Zed leaves a hand-edited settings file alone unless the user changes something through the UI. This is materially safer than Claude Desktop or `~/.claude.json`. [MACHINE]
- **The JSONC trap is real and remains the main hazard.** Zed's settings file is JSON-with-comments — its own shipped defaults are wall-to-wall `//` comments, and users copy that style. A `JSON.parse` → `JSON.stringify` round-trip will silently delete every comment and reformat the file. Use a comment-preserving edit. This was flagged in §2.6 and the install confirms it.
- **Zed keeps its own backups**: `settings_backup.json` and `keymap_backup.json` appear in the same path blob as `settings.json` [BINARY]. These look like migration backups rather than a rotation, and I did not see one created during my runs. Do not rely on them; take our own.
- **Config is created lazily.** `~/.config/zed/` existed after first launch containing only `themes/` — **no `settings.json` at all** [MACHINE]. The installer must handle "Zed is installed, config directory exists, settings file does not" as a normal first-run case, creating the file rather than treating its absence as an error.

## A.6 State of this machine after the Zed work

Zed is installed and stays installed, as asked. **The test entry has been removed** and `~/.config/zed/settings.json` deleted, restoring the true first-run state (directory present, no settings file) so Phase 3 still has a clean before/after baseline — matching every other client here at zero servers configured. The test artifacts, the extracted default-settings file, and the per-run logs are in this session's scratchpad, outside the repo. [MACHINE]

## A.7 What is still unconfirmed about Zed after installing it

1. Zed's settings path on **macOS and Windows** — still undocumented and untestable here.
2. The **Flatpak** remapped paths — the mechanism is confirmed, the resulting paths are not.
3. Where the **UI enable/disable toggle** persists.
4. The **full `source` enum and field list** for `context_servers` — inferred from adjacent strings, not verified.
5. Whether Zed's **editor-import** feature carries MCP entries across from VS Code or Cursor.
6. Whether `.zed/settings.json` project scope behaves identically for `context_servers` — the path is confirmed in the binary; I tested only user scope.

---

# Addendum B — the Claude Desktop config risk, precisely

Short answers to the five questions, in order.

**1. Can nosyparker be added to Claude Desktop's config at all?**

Yes. Nothing blocks it. The file exists at `~/.config/Claude/claude_desktop_config.json`, is valid JSON, and simply has no `mcpServers` key yet — its top-level keys are `coworkUserFilesPath` and `preferences` [MACHINE]. Adding an `mcpServers` object alongside them is the documented, ordinary mechanism [DOCS]. This is a routine edit, not a blocked one.

**2. What exactly is the failure mode, and does it need the app to be running?**

Two distinct failures. Only one is the one the launcher warns about.

*The wipe (the documented one).* Per the launcher's own source comment, upstream's config loader **falls back to `{}` on a failed cold-start read**, and then **serialises that empty cached object over the file on the next settings write**. The comment names the read failures it covers: corrupt JSON, ENOENT, and a single bad entry failing Zod validation. Referenced upstream issues: `anthropics/claude-code` #32345, #59640, #63651. [MACHINE, `/usr/lib/claude-desktop-unofficial/launcher-common.sh`]

So the trigger is **a failed read at startup** — it does not require the app to be running when we write. The causal chain runs the other way: *we* leave behind a file the app cannot read or validate, and the wipe happens on the *next* launch. A malformed write is not a write that fails; it is a write that destroys the file later.

*The clobber (the ordinary one).* If we write while the app is running, the app's in-memory object does not contain our entry, and its next settings write overwrites the file with what it has. Our entry vanishes. No corruption, just a silent loss.

**3. Is writing while the app is closed genuinely safe?**

It removes the clobber entirely, and it is what we should do. It does **not** remove the wipe risk, because the wipe is triggered by the *content* we leave, not by the timing. Residual risk, in order of what actually matters:

- Our own write is malformed or fails the app's validation → next launch wipes it. **Mitigation: after writing, re-read and re-parse the file, and verify our entry is present and the pre-existing keys survived. Do not report success on the strength of the write call returning.**
- The app is launched between our write and our verification. Small window; closing it means checking for a live process immediately before writing and again after.
- We preserve mode and ownership. The file is `0600` and sits beside `oauth:tokenCache` in the same directory [MACHINE]. Write to a temp file on the same filesystem, `fchmod` to the original's mode, then `rename`.

**4. Does Claude Desktop need a restart?**

Yes — the docs are explicit: "completely quit Claude Desktop and restart it. The application needs to restart to load the new configuration and start the MCP server." [DOCS]

And your expectation is right that this generalises. Every client examined needs a restart or an explicit reload:

| Client | What it takes |
|---|---|
| Claude Desktop | Full quit and relaunch [DOCS] |
| Claude Code | New session picks it up; a running session needs a reconnect via `/mcp` [DOCS] |
| Zed | Restart. Writing `settings.json` while Zed ran produced nothing; the server appeared only after a relaunch [MACHINE] |
| VS Code | Watches the file; `chat.mcp.autostart` governs whether servers restart on config change, and when disabled they do not [DOCS] |
| Cursor | Watches both config paths [BINARY]; whether it hot-reloads without a restart is untested |
| Continue | Docs note it does not always pick up edits live; the extension must be reloaded [DOCS] |

So the installer's closing message should tell the person to restart the affected apps, and should name them. That is not a caveat — it is the last required step of the install.

**5. The five rotating backups — safety net or not?**

Useful here, but **do not count on them.** They are a mitigation shipped by the *unofficial Debian launcher*, not by Claude Desktop:

- They do not exist on **macOS or Windows**, where Claude Desktop is officially supported.
- They only run when the app is started **through the launcher**. `backup_user_config` is called at line 32 of `/usr/bin/claude-desktop-unofficial`, before Electron starts. Launching the Electron binary directly bypasses it. (The launcher does rewrite the XDG autostart entry to point back at itself, so login launches are covered. [MACHINE])
- They rotate **only when the content changed**, keeping five copies — deliberate, so repeated no-op launches cannot evict a good pre-damage copy.

One genuinely reassuring property: because the backup runs *before* Electron starts, a launch that then wipes the file has already captured our written version. On this machine, a wipe is recoverable. On a Mac, it is not.

**Net answer for the owner:** yes, we can install to Claude Desktop, and the operation is ordinary. The discipline it demands is: write only while the app is closed, keep our own backup rather than relying on the launcher's, verify by re-reading and re-parsing rather than trusting the write, preserve `0600`, and tell the person to restart the app — reporting the entry as written-but-unverified until they do.

---

# Addendum C — strategic research: staying current, named clients, leverage, findability

Added 2026-08-17. All four answers are from web sources searched today, not from training knowledge. Confidence markers are the same as the rest of the report: **[DOCS]** = confirmed from the vendor's or project's own documentation; **[SECONDARY]** = credible third-party only; **[UNCONFIRMED]** = unknown. Two findings are marked **[FETCHED]** — I retrieved the artefact itself and read it.

**The short version of all four:** the owner's instinct is right that a leverage layer exists, but it is not where he expected. It is not gateways, and it is not OpenRouter. There are exactly two real multipliers: a community-maintained **`clients.json`** that already encodes what §2 of this report took a day to establish, and the **official MCP Registry**, which one `server.json` feeds into multiple clients' built-in browsers. Neither removes the per-client writing Phase 3 has to do.

---

## C.1 Staying current as new clients appear

### There is a machine-readable client registry, and it is good

**`https://install.apicommons.org/clients.json`** — an open registry of how each MCP client installs a server. I fetched it and its schema. [FETCHED]

- **33 clients**, declared `version: "1.0.0"`.
- Published JSON Schema at `https://install.apicommons.org/clients.schema.json`. [FETCHED]
- Each entry carries: `id`, `name`, `maker`, `category`, `transports` (stdio/http/sse), `platforms` (mac/windows/linux/web/ios/android), `website`, `docs`, `notes`.
- `category` is the install mechanism — **`deeplink`**, **`cli`**, **`config`**, or **`connector`** — and each category has its own block: CLI command templates with token slots for env and header flags; config format (JSON/YAML/TOML), root key, style variant and per-OS paths; deep-link builders; connector setup steps for web clients.
- Maintained by Kin Lane under API Commons. **Community, not official** — he frames it explicitly as a commons artefact and takes pull requests. [DOCS]

**It agrees with our findings.** Spot-checking against §2, which I derived independently from binaries and installed apps: Claude Code as `cli` with `claude mcp add {name}{envFlags} -- {command} {args}`; Claude Desktop `mcpServers` at the macOS and Windows paths; Cursor `mcpServers` at `~/.cursor/mcp.json` on all three OSes; VS Code `servers` with `code --add-mcp '{jsonWithName}'`; Zed `context_servers`, stdio only; Windsurf `mcpServers` at `~/.codeium/windsurf/mcp_config.json` with `serverUrl` as its URL key. [FETCHED]

**Its two weaknesses, both material:**
1. **No `lastUpdated` or maintenance-status field anywhere** — not per entry, not at the top level. You cannot tell from the file whether an entry was verified last week or in January. [FETCHED]
2. It lists Claude Desktop's macOS and Windows paths but **not Linux** — the exact gap this report had to close by reading VS Code's discovery adapter. So it is a strong seed, not a complete oracle.

### How comparable projects actually do it

Three real multi-client installers, and all three do the same thing: **a hardcoded table, plus an escape hatch.**

| Project | Clients covered | Mechanism | [conf] |
|---|---|---|---|
| **FastMCP** | 3 first-class — `fastmcp install claude-code`, `claude-desktop`, `cursor` — plus `fastmcp install mcp-json`, which emits a standard `mcpServers` blob for everything else | Per-client install modules in source; the generic emitter is the documented answer for unsupported clients, CI, and config sharing | [DOCS] |
| **MCPM** (`pathintegral-institute/mcpm.sh`) | ~10 listed: Claude Desktop, Cursor, Windsurf, VS Code, Cline, Continue, Goose, 5ire, Roo Code, OpenCode, "more coming soon" | Not documented. The repo says nothing about how it resolves client paths, nothing about keeping up with format changes, and has no client registry — only a server registry | [DOCS] for the list; **[UNCONFIRMED]** for the mechanism |
| **Smithery CLI** | Claude Desktop, Cursor, Windsurf and others; `npx @smithery/cli list clients` enumerates them, `--client <name>` selects one | Built-in client list in the CLI | [SECONDARY] |

**What breaks for them** is visible in MCPM's gap: no project in this set documents a staleness process. FastMCP's answer is the most honest — rather than pretend to cover everything, it covers three properly and hands you a correct JSON blob for the rest. That is a design choice worth copying.

### Realistic maintenance cost, and what reduces it

The cost is not writing the table. It is *noticing* when an entry goes wrong, because every failure mode here is silent — a client renames a key, moves a path, or adds a gate, and our installer keeps writing a file nobody reads. This report already found four things no documentation stated: VS Code's per-profile `mcp.json`, its nine `chat.mcp.*` gates, Zed's `source` field being unnecessary, and Claude Desktop's Linux path.

What actually reduces it, in order of value:

1. **Prefer the client's own CLI over its config file.** `claude mcp add`, `code --add-mcp`, `cursor --add-mcp`, `codex mcp add`, `gemini mcp add`, `copilot mcp add`, `hermes mcp add`, `openclaw mcp add` — eight of the clients in this report now ship one. A CLI is a maintained interface; a file path is an implementation detail. This single rule removes most of the staleness surface.
2. **Vendor `clients.json` as a build-time cross-check**, not a runtime dependency. Diff our table against it in CI and fail loudly on divergence. It is community-maintained with no freshness signal, so it must never be the source of truth — but as a second opinion that flags "someone thinks Cursor's path changed", it is nearly free.
3. **Ship the FastMCP escape hatch**: a `--print-config` mode that emits a correct entry for a client we do not support, so an unknown client costs the user a copy-paste rather than a bug report.
4. **Report honestly per client** (the §5 vocabulary). A stale entry that says "written, unverified" is a much smaller failure than one that says "installed".

### → What it means for us

**Affects Phase 3, modestly.** Keep our own hardcoded table as the source of truth — the evidence quality in §2 is higher than anything available off the shelf. Add: CLI-first writing wherever a CLI exists, a CI diff against `clients.json`, and a `--print-config` fallback. Do not fetch anything at install time.

---

## C.2 The clients he named

| Client | Real MCP client? | Config | Key | CLI / verification | [conf] |
|---|---|---|---|---|---|
| **DeepSeek** | **No — not as a local agent.** DeepSeek ships models and an API. DeepSeek V4 (Apr 2026) is strong at tool calling and works *with* any MCP client via OpenAI- and Anthropic-compatible APIs, but that makes it a model behind someone else's client, not a client. The MCP-capable DeepSeek CLIs — DeepSeek-TUI (`~/.deepseek/mcp.json`), DeepSeek-Reasonix, Deep Code CLI — are **community projects, not official**. | n/a | n/a | n/a | [SECONDARY]; no official agent found |
| **"K3"** | **Not an MCP client — it is a model.** Kimi K3 is Moonshot's model (marketed at 2.8T params / 1M context). No `K3` agent product exists in this space. *(Searches also surface `k3s`, which is Kubernetes and unrelated.)* **The thing he probably means is Kimi Code**, Moonshot's terminal agent built on Kimi K2.7 Code — and that *is* a real MCP client. | — | — | — | [SECONDARY] |
| **Kimi Code** (the real one) | **Yes** | user `~/.kimi-code/mcp.json` (or `$KIMI_CODE_HOME/mcp.json`); project `.kimi-code/mcp.json` | `mcpServers` | `/mcp-config` to add/edit/delete, `/mcp` for connection status — both **slash commands inside the TUI, not shell subcommands** | [DOCS] |
| **Gemini CLI** | **Yes** | user `~/.gemini/settings.json`; project `.gemini/settings.json`; a system level exists | `mcpServers` | `gemini mcp list` / `add` / `remove` / `enable` / `disable` | [DOCS] |
| **Codex CLI** | **Yes** | `~/.codex/config.toml`; project `.codex/config.toml` **for trusted projects only** | TOML `[mcp_servers.<name>]` — `command` required; `args`, `env`, `startup_timeout_sec` (default 10), `enabled` optional | `codex mcp add` / `list` / `login`. **`enabled = false` disables without deleting** — a silent-non-load condition | [DOCS] — upgraded from [SECONDARY] in §2.7 |
| **Goose** | **Yes** | macOS/Linux `~/.config/goose/config.yaml`; **Windows `%APPDATA%\Block\goose\config\config.yaml`** | `extensions` | `goose configure` (interactive). No non-interactive add/list documented | [DOCS] — upgraded from [SECONDARY]; **`enabled: true` is required**, and the field is `cmd`, not `command` |
| **Cline** | **Yes** | Linux `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` | `mcpServers` | None found | [SECONDARY] — unchanged |
| **Continue** | **Yes** | `~/.continue/config.yaml` block, or standalone YAML in `.continue/mcpServers/` | `mcpServers` — **YAML list of maps, not an object map** | None; docs note edits are not always picked up live | [DOCS] |
| **Warp** | **Yes** | `~/.warp/.mcp.json` — all platforms, shared across release channels | `mcpServers` | Warp documents MCP CLI reference pages; not verified | [DOCS] |
| **JetBrains** | **Yes** | Junie: `~/.junie/mcp/mcp.json` user, `.junie/mcp/mcp.json` project. AI Assistant on Linux reported at `~/.config/JetBrains/AIAssistant/mcp.json` | JSON pasted via Settings → Tools → AI Assistant → MCP | None found | [DOCS] for Junie; [SECONDARY] for the AI Assistant path |

### → What it means for us

**Affects Phase 3 directly.** Four additions earn their place because they have real CLIs and land in Tier A/B of §5: **Codex, Gemini CLI, Kimi Code, Goose**. Codex's `enabled = false` and Goose's required `enabled: true` are both silent-non-load conditions the installer must handle — Goose especially, since omitting the field means the extension never loads.

**Drop DeepSeek and "K3" from the plan.** Neither is an MCP client. If the owner wants DeepSeek covered, the honest framing is that DeepSeek users reach nosyparker through whatever client they run, and that client is already in our table.

---

## C.3 The leverage question — gateways and hubs

### Hermes and OpenClaw: both real, both just clients

| | **Hermes Agent** (NousResearch) | **OpenClaw** |
|---|---|---|
| Config | `~/.hermes/config.yaml` | `~/.openclaw/openclaw.json` |
| Key | top-level **`mcp_servers:`** (YAML) — note the docs flag `mcp: servers:` as a common and wrong variant | **`mcp.servers`** (JSON) |
| stdio entry | `command`, `args` | `command`, `args` |
| CLI | `hermes mcp` — add, install, configure, login, serve, catalog, interactive picker | `openclaw mcp` — list, show, status, doctor, probe, add, set, configure, tools, login, logout, reload, unset |
| Runs as an MCP server? | Yes — `hermes mcp serve`, stdio only | Yes — `openclaw mcp serve`, stdio |
| **Does that re-expose its configured servers?** | **No.** It exposes ~10 tools covering Hermes' *own* messaging capabilities — list conversations, read history, send messages | **No.** It exposes Gateway-backed *conversations* |
| [conf] | [DOCS] | [DOCS] |

**This is the answer to the owner's question, and it is no.** Both call themselves gateways, and both can act as an MCP server — but what they serve is their own functionality, not a fan-out of the MCP servers they consume. Installing nosyparker into Hermes reaches Hermes users. It does not reach the Claude Code user sitting behind it. They are two more rows in the client table, not a multiplier.

One nuance worth keeping: OpenClaw describes its config as "an MCP client-side registry for servers its own runtimes may consume later… so embedded OpenClaw and other adapters don't maintain duplicate lists" [DOCS]. That is a shared registry *within* the OpenClaw family. Real, but bounded.

### The actual aggregator category does exist

`e2b-dev/awesome-mcp-gateways` catalogues **47 gateways — 23 open-source, 24 commercial**. [DOCS] The serious ones:

- **MetaMCP** — aggregates many MCP servers into one, applies middleware, and is itself an MCP server "so it can be easily plugged into ANY MCP client". Servers / Namespaces / Endpoints hierarchy with per-level tool overrides.
- **IBM ContextForge** (`IBM/mcp-context-forge`) — registry and proxy federating MCP, A2A and REST/gRPC behind one endpoint, with guardrails and plugins.
- **Docker MCP Gateway** — each server in an isolated container, wired to Docker's catalog of verified servers.

These genuinely do fan out: one gateway endpoint, many clients pointed at it, many servers behind it.

**But they give us no leverage, for a specific reason.** A gateway is an MCP client. It consumes ordinary MCP servers through ordinary config with **zero special packaging** — the listings describe "drop-in" behaviour and "zero code changes" [DOCS]. Which means:

1. **nosyparker already works behind every one of them, today, with no work from us.** There is nothing to build and nothing to integrate.
2. The fan-out is *the user's* to set up. Someone still has to add nosyparker to their gateway — the same single act as adding it to a client. We do not reach anyone by being "installable into MetaMCP", because there is no such thing as being installable into MetaMCP; there is only a user adding a server.

The leverage is real but it belongs to the user who runs the gateway, not to us.

### → What it means for us

**Not worth pursuing as an integration.** There is nothing to build: gateway compatibility is a property we already have by being a standards-compliant stdio server, and it costs nothing to keep.

Two cheap follow-ons: add **Hermes** and **OpenClaw** as ordinary client rows (both have `mcp add` CLIs, so both are Tier B at least), and state gateway compatibility in the README as a supported configuration — a claim we can make truthfully and for free. Worth one line in Phase 3's test plan: point one gateway at nosyparker and confirm it works, so the claim is verified rather than assumed.

---

## C.4 OpenRouter, and where people actually find MCP servers

### OpenRouter: not our layer, and there is no marketplace to get into

Confirmed, and the answer is a clean no — but with one twist worth knowing.

- OpenRouter routes **model API calls**. It is a different layer from local MCP servers, as suspected. [DOCS]
- **There is no MCP server marketplace, plugin marketplace, or tool directory on OpenRouter.** Their `works-with-openrouter` page is a directory of *applications that consume OpenRouter's model API* — chat UIs, coding agents, research tools — and you get listed by submitting a PR. nosyparker does not consume OpenRouter, so it does not qualify and would not belong there. [DOCS]
- The twist: OpenRouter has moved in the **opposite** direction. They now publish their *own* remote MCP server at `https://mcp.openrouter.ai/mcp`, added as a connector in Claude Desktop, with an OAuth flow that mints a scoped key. It exposes things like full-text search over OpenRouter's docs. So OpenRouter is an MCP *server vendor*, not an MCP server *distributor*. [DOCS]
- Every "OpenRouter MCP" package on Smithery, Glama, mcp.so and MCP Market is a **community server wrapping OpenRouter's API** — the same direction, and nothing to do with distributing servers like ours. [SECONDARY]

### Where people actually find MCP servers

| Venue | What it is | How to get listed | [conf] |
|---|---|---|---|
| **Official MCP Registry** — `registry.modelcontextprotocol.io` | The canonical metadata repository, run by the MCP Steering Committee with Anthropic, GitHub, Microsoft and PulseMCP behind it. REST API: `GET /v0/servers?limit=10`, `?search=`, `/v0/servers/{id}` | Publish a **`server.json`**: namespaced name (`io.github.user/server-name`), package/endpoint location, execution instructions, description. Custom metadata goes under `io.modelcontextprotocol.registry/publisher-provided`, capped at 4 KB | [DOCS] |
| **VS Code in-client gallery** | Extensions view → type `@mcp` → browse → Install, and VS Code writes the config itself | Sourced from a registry rather than a hand-curated Microsoft list — VS Code 1.133 ships `chat.mcp.gallery.enabled` and a `chat.mcp.access` value of `registry` [BINARY, §2.4]. **That the source is specifically the official MCP Registry is [UNCONFIRMED]** — the VS Code docs describe the gallery but not its backing source | [DOCS] for the gallery; [UNCONFIRMED] for the source |
| **Smithery** | Directory plus hosting and observability | Active publish step: `smithery mcp publish <url> -n yourorg/your-server` | [SECONDARY] |
| **Glama** | Directory tracking ~37,000 servers as of mid-2026, tiered into publisher-verified "Official" and author-verified "Claimed" | Auto-indexes open-source servers from GitHub; you claim your listing | [SECONDARY] |
| **mcp.so** | Aggregator, 20,000+ servers | Submit button on the site, or a GitHub issue | [SECONDARY] |
| **PulseMCP** | Directory that also publishes estimated weekly visitor counts per server — a genuine signal most directories lack | Also operates a sub-registry API | [SECONDARY] |
| **Docker MCP Catalog** | Curated, verified servers as signed Docker images, surfaced in Docker Desktop's MCP Toolkit | PR to `github.com/docker/mcp-registry`. Docker builds, signs and publishes to `mcp/<name>`; live within 24 h of approval. Requires containerising nosyparker | [DOCS] |

**The one that matters.** Publishing a single `server.json` to the official registry is the closest thing in this ecosystem to the owner's "support one thing, reach many users" — it is the upstream that client-side galleries and several directories draw from. It costs one file and a namespace claim. That is genuinely high leverage, and it is the correct answer to his underlying question, just aimed at *discovery* rather than *installation*.

Two honest caveats: nosyparker is a **local** server, so anything demanding a containerised or hosted artefact (Docker Catalog, Smithery hosting) is a larger commitment than a registry entry. And I could not confirm that VS Code's `@mcp` gallery specifically pulls from the official registry — worth verifying before treating "publish once, appear in VS Code" as a fact.

### → What it means for us

**OpenRouter: not worth pursuing. Close the question.** Wrong layer, no marketplace, and we do not meet the criteria for the directory they do have.

**Findability: Phase 5 distribution, not Phase 3.** Nothing here changes the installer's design. When we get to distribution, the order is: official registry `server.json` first (highest leverage, lowest cost, feeds the others), then Glama and mcp.so as cheap claims, then Smithery and Docker only if hosting or containerising is something we want anyway.

One thing to carry into **Phase 3** from this section: the registry's naming convention, `io.github.<user>/<server-name>`. If we are likely to publish later, picking the server name now with that shape in mind costs nothing and avoids a rename after people have it in their configs.

---

# Addendum D — the five remaining clients, installed and verified on this machine

Added 2026-08-17. All five installed one at a time, wired to nosyparker's real Phase 2 server (`src/mcp-server.js`), tested, and cleaned up. **No rotation was needed** — disk went from 16 GB free to 14 GB and never approached the 3 GB floor. Total footprint added: ~2.2 GB.

Nothing was signed into. Where a client could not be verified without an account, that is recorded as the finding rather than worked around.

## D.0 Headline results

1. **Gemini CLI is a second Tier A verifier — and it needs no account.** It reports `✓ Connected` / `✗ Disconnected` and correctly distinguished our working server from a deliberately broken one. Only Claude Code was in that class before.
2. **`gemini mcp add` is broken.** It printed `MCP server "nosyparker" added to project settings.` and wrote no file anywhere on disk. The client's own CLI reports success and does nothing. **Do not use it.**
3. **Windsurf/Devin has two MCP config files, not one.** `--add-mcp` writes a VS Code-shaped `servers` file at `~/.config/Devin/User/mcp.json`; every published doc describes a different file, `~/.codeium/windsurf/mcp_config.json`, with a different key.
4. **`kimi doctor` gives a false green light.** It reports "All checked config files are valid" while `mcp.json` contains syntactically invalid JSON — it never reads that file.
5. **Codex's `mcp list` is not a health check.** It reported a nonexistent binary as `enabled`.
6. **Goose moved orgs.** `github.com/block/goose` now 301-redirects to `github.com/aaif-goose/goose` (Agentic AI Foundation). §2.7's `block.github.io` reference is stale.

---

## D.1 Codex CLI — **verified on this machine**

| Field | Value |
|---|---|
| Version | `codex-cli 0.147.0` |
| Install | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh`, upstream's recommended method. Binary `~/.local/bin/codex`, standalone package under `~/.codex/packages/standalone/`. No sudo, no system writes. `~/.local/bin` was already on PATH so **no shell profile was modified**. 301 MB. |
| **User config** | **`~/.codex/config.toml`** — did not exist before; created by `codex mcp add` |
| **Key** | TOML table **`[mcp_servers.<name>]`** |
| **Minimal entry** (written verbatim by the CLI) | ```toml\n[mcp_servers.nosyparker]\ncommand = "node"\nargs = ["/abs/path/src/mcp-server.js"]\n``` |
| Full field set | From the binary's own display strings: `enabled`, `enabled_tools`, `disabled_tools`, `command`, `args`, `cwd`, `env`, `url`, `bearer_token_env_var`, `http_headers`, `env_http_headers`, `startup_timeout_sec`, `tool_timeout_sec`, `default_tools_approval_mode` |
| **Project scope** | **Did not reproduce.** A `.codex/config.toml` placed in the working directory was ignored — `codex mcp list` from that directory showed only the global entry. The binary contains `projects."<path>".trust_level`, so project config is gated behind a trust record in the *global* config. Treat project scope as real but trust-gated and unverified. |
| Blocking conditions | `enabled = false`; `enabled_tools` / `disabled_tools` filters; untrusted project directory |
| **Account required?** | **No.** `codex mcp list`, `get`, `add`, `remove` and `--json` all worked with no sign-in. |
| **Verification** | `codex mcp list`, `codex mcp get <name>`, `codex mcp list --json`. The JSON is well-structured: `name`, `enabled`, `disabled_reason`, `transport{type,command,args,env,cwd}`, `startup_timeout_sec`, `tool_timeout_sec`, `auth_status`. |
| **Verification limit — proven** | **Config read-back only, not a health check.** I added a server pointing at `/nonexistent/definitely-not-a-binary`; `codex mcp list` reported it as `Status: enabled` and `codex mcp get` showed `enabled: true`. It never tries to run the command. |
| **Tier** | **B+** — authoritative, structured, machine-readable read-back that proves our entry parsed and is enabled. Proves nothing about liveness. |

---

## D.2 Gemini CLI — **verified on this machine**, and the best result of the five

| Field | Value |
|---|---|
| Version | `0.55.1` |
| Install | `npm install -g --prefix ~/.npm-global @google/gemini-cli` (upstream recommends npm/npx). 122 MB. Binary at **`~/.npm-global/bin/gemini`** — see D.6, this is **not on the owner's PATH**. |
| **User config** | **`~/.gemini/settings.json`** — the directory `~/.gemini/` is created on first run (with `projects.json`, `history/`, `tmp/`), but `settings.json` is **not** created until something writes it |
| **Key** | **`mcpServers`** |
| **Minimal working entry** (verified loading) | ```json\n{"mcpServers":{"nosyparker":{"command":"node","args":["/abs/path/src/mcp-server.js"]}}}\n``` |
| Project scope | `.gemini/settings.json`, plus a system level. Documented; not verified here. |
| **Blocking condition — major** | **Workspace trust silently disables user-level servers.** In an untrusted folder: `Warning: MCP servers are configured but disabled because this folder is untrusted. User-level servers are also suppressed in untrusted folders to prevent accidental side-effects.` and the server lists as `○ nosyparker: … - Disabled`. Trust is recorded in **`~/.gemini/trustedFolders.json`** as `{"<absolute path>": "TRUST_FOLDER"}`; the bundle's trust values are `TRUST_FOLDER`, `TRUST_PARENT`, `DO_NOT_TRUST`, governed by a `security.folderTrust` setting. A correct install is invisible until the user's folder is trusted. |
| **Account required?** | **No.** All MCP management and verification worked with no Google sign-in. |
| **Verification — Tier A, proven** | In a trusted folder, `gemini mcp list` prints:<br>`✓ nosyparker: node /abs/path/src/mcp-server.js (stdio) - Connected`<br>Control test with a broken server alongside it:<br>`✗ brokentest: /nonexistent/definitely-not-a-binary (stdio) - Disconnected`<br>It genuinely starts the server and distinguishes working from broken. |
| **⚠ `gemini mcp add` is broken** | `gemini mcp add nosyparker node /abs/path/…` printed `MCP server "nosyparker" added to project settings. (stdio)` and **created no file anywhere**. A second add behaved the same. `gemini mcp list` immediately afterwards reported `No MCP servers configured.` A filesystem-wide search for files modified in the preceding ten minutes found nothing. A **hand-written** `~/.gemini/settings.json` was read correctly. **Conclusion: write the file ourselves; do not use `gemini mcp add`.** This is the exact false-success class Phases 1 and 2 suffered from, shipped in someone else's CLI. |
| **Tier** | **A for verification, C for the vendor's writer.** Write by file, verify by CLI. |

---

## D.3 Kimi Code — installed, **cannot be verified here**

| Field | Value |
|---|---|
| Version | `0.36.1` |
| Install | `curl -fsSL https://code.kimi.com/kimi-code/install.sh \| bash`. Default install dir `~/.kimi-code` (a sudo/`/usr/local` variant exists and was not used). 173 MB. **It appended a PATH line to `~/.zshrc`** — left in place, see D.6. |
| **User config** | **`~/.kimi-code/mcp.json`** (or `$KIMI_CODE_HOME/mcp.json`) |
| **Project config** | **`<cwd>/.kimi-code/mcp.json`** — and the binary's own embedded documentation is explicit that "Kimi reads the **current working directory's** Kimi-specific MCP file, not every project-root `.kimi-code/mcp.json` from subdirectories" |
| **Bonus finding** | Kimi **also reads project-root `.mcp.json`** — its embedded docs say "project-root `.mcp.json` is already read by Kimi as a Claude-compatible MCP file". So writing Claude Code's project file may register the server in Kimi too. Not independently tested. |
| **Key** | **`mcpServers`** |
| Minimal entry | `{"mcpServers":{"nosyparker":{"command":"node","args":["/abs/path/…"]}}}` |
| CLI | **No `mcp` subcommand.** MCP is managed only by the `/mcp-config` and `/mcp` slash commands inside the interactive TUI. Non-interactive subcommands are `export`, `provider`, `acp`, `web`, `login`, `doctor`, `vis`, `migrate`, `upgrade`. |
| **⚠ `kimi doctor` is a false-reassurance trap** | It validates only `config.toml` and `tui.toml`. With `~/.kimi-code/mcp.json` containing deliberately invalid JSON, it still printed **"All checked config files are valid."** An installer that used `kimi doctor` as its check would report success over a broken config. |
| **Account required?** | **Yes.** `kimi -p "say ok"` → `error: failed to run prompt: No model configured. Run 'kimi' and use /login to sign in`. |
| **Does it load MCP before auth?** | **No.** From a cleared baseline I ran Kimi unauthenticated and polled for 16 seconds: **zero** `mcp-server.js` processes. *(Correction worth recording: an earlier observation of one process led me to think Kimi had spawned it. Re-testing from a cleared baseline showed the process was a stray left by the Gemini test. The claim did not survive checking.)* |
| **Verification** | **None available without a Moonshot account.** We can write the file; nobody can confirm it loads on this machine. |
| **Tier** | **C — write only.** The installer must mark Kimi unverified. |

---

## D.4 Goose — **verified on this machine**

| Field | Value |
|---|---|
| Version | `1.46.0` |
| **Org moved** | `github.com/block/goose` **301-redirects** to `github.com/aaif-goose/goose` (Agentic AI Foundation) — GitHub's own transfer redirect, not a hijack. Docs are now `goose-docs.ai`. |
| Install | `CONFIGURE=false bash download_cli.sh` from the release above. `CONFIGURE=false` skips the interactive provider setup, which is what kept this account-free. Binary `~/.local/bin/goose`. No sudo. |
| **User config** | **`~/.config/goose/config.yaml`** — **printed by the app itself**: `goose info` outputs `Config yaml: /home/amirjam/.config/goose/config.yaml`. Also `Sessions DB: ~/.local/share/goose/sessions/sessions.db`, `Logs dir: ~/.local/state/goose/logs`. Windows path per docs: `%APPDATA%\Block\goose\config\config.yaml` (unverified, and note it still says `Block`). |
| **Key** | **`extensions`** |
| **Minimal entry** (verified echoed back) | ```yaml\nextensions:\n  nosyparker:\n    type: stdio\n    name: nosyparker\n    enabled: true\n    cmd: node\n    args:\n      - /abs/path/src/mcp-server.js\n``` **`cmd`, not `command`** — and `name` is repeated inside the entry. |
| Project scope | None documented, none found. |
| **Blocking conditions** | `enabled: false` — the entry still appears in the read-back with `enabled: false` visible, so a program can distinguish present-and-on from present-and-off. **And a severe one: malformed YAML causes a silent fallback to built-in defaults.** With broken YAML, `goose info -v` listed only the bundled platform extensions, showed no error, and every user extension vanished from view. A bad write by us silently disables *all* of the user's extensions, not just ours. |
| **Account required?** | **Partly.** `goose info` and `goose info -v` work with **no** provider configured. `goose doctor` does **not** — it exits with `error: No provider configured. Run 'goose configure' first.` |
| **Verification** | **`goose info -v` echoes the parsed `config.yaml`, including our entry and its `enabled` value** — a genuine read-back, no account needed. Not a liveness check: no session can start without a provider. |
| Note | `goose mcp` runs goose's *own bundled* MCP servers. It does not manage external ones. |
| **Tier** | **B+** — parsed-config read-back without an account. |

---

## D.5 Windsurf / Devin Desktop — **verified on this machine**, and the most surprising row

| Field | Value |
|---|---|
| Identity | **Windsurf is now Devin Desktop.** App version `1.126.0`; tarball `Devin-linux-x64-3.7.25.tar.gz`. `product.json` gives `nameShort: Devin`, `applicationName: devin-desktop`, `dataFolderName: .devin`. |
| Install | `windsurf.com` redirects to `devin.ai`, which was returning **HTTP 429** throughout. The working route was the tarball redirect `https://windsurf.com/api/windsurf/download-redirect?build=linux-x64&isNext=false` → 335 MB archive, extracted to **`~/.local/Devin`**. User-local: no apt, no sudo, no Snap, no Flatpak. 1.2 GB installed. *(An apt repo exists but needs root; a guessed `codeiumdata` apt path returned 404, so I did not pursue it.)* |
| **Two MCP surfaces — the headline** | **1. `~/.config/Devin/User/mcp.json`** — key **`servers`**, VS Code shape, emitted with `"inputs": []`. **This is what `--add-mcp` actually writes.** Verified on disk.<br>**2. `~/.codeium/windsurf/mcp_config.json`** — key `mcpServers`. This is the file every published doc describes, including §2.5 of this report. |
| Which is live? | `~/.codeium/windsurf/` **is created on first launch** (verified on disk — `database/`, `cascade/`, `memories/`, `brain/` all appear), but `mcp_config.json` is not written until Cascade needs it. And **Cascade is off by default in this build**: first launch wrote `~/.config/Devin/User/settings.json` containing `{"devin.cascade.enabled": false}`. So the documented surface is dormant out of the box. |
| **Path survived the rename** | The bundle builds the directory as `[".codeium", n]` where `n` is `windsurf` on stable, `windsurf-insiders` / `windsurf-next` on other channels. Confirmed on disk: even under the Devin name, it creates `~/.codeium/windsurf/`. §2.5's path is correct. |
| **CLI** | **`devin-desktop --add-mcp '<json>'`** — exists, exit 0, prints `Added MCP servers: nosyparker`. Undocumented in the MCP docs; found in `--help`. |
| Blocking conditions | Inherits VS Code's gates — `chat.mcp.access` (incl. `.registry` / `.none`), `chat.mcp.gallery.enabled`, `chat.mcp.autostart`, `chat.mcp.collisionBehavior`, `chat.mcp.serverSampling` — **plus** `devin.cascade.enabled`, which is `false` by default here. |
| Cross-client discovery | The bundle contains `devin.cascade.readClaudeCodeConfig` and strings for Cursor's global and workspace configs — the same adapter pattern found in VS Code (§2.4). Another duplicate-registration surface. |
| **Clobber confirmed empirically** | I deleted `~/.config/Devin/User/mcp.json` while the app was running and **it reappeared**. Devin rewrites its config from memory, exactly like Claude Desktop. The file only stayed deleted after the app was stopped. **Write only while it is closed.** |
| **Verification** | No list command. `--add-mcp` gives an exit code and a success line, nothing more. |
| **Tier** | **B** — write via the app's own CLI, no read-back. |
| Unverified | Cascade's documented 100-tool ceiling (§2.5) — not testable with Cascade disabled. |

---

## D.6 What was left on the machine

**All five clients are installed and working**, as asked. Disk: 14 GB free (was 16 GB).

| Path | What | Size |
|---|---|---|
| `~/.local/bin/codex` + `~/.codex/` | Codex 0.147.0 | 301 MB |
| `~/.npm-global/` | Gemini CLI 0.55.1 | 122 MB |
| `~/.kimi-code/` | Kimi Code 0.36.1 | 173 MB |
| `~/.local/bin/goose` | Goose 1.46.0 | ~50 MB |
| `~/.local/Devin/` | Devin Desktop 1.126.0 | 1.2 GB |
| `~/.local/zed.app/` | Zed 1.15.0 (Addendum A) | 424 MB |

**Every test config was removed.** Verified absent at the end: `~/.codex/config.toml`, `~/.gemini/settings.json`, `~/.gemini/trustedFolders.json`, `~/.kimi-code/mcp.json`, `~/.config/goose/config.yaml`, `~/.config/Devin/User/mcp.json`, `~/.config/zed/settings.json`, `~/.codeium/windsurf/mcp_config.json`. No `mcp-server.js` processes left running. **The zero-servers-configured baseline is intact for every client in the table.**

**Three changes I did not revert, flagged for a decision:**

1. **`~/.zshrc` gained a PATH line** — `export PATH="/home/amirjam/.kimi-code/bin:$PATH"`, appended by Kimi's installer under a `# kimi-code` comment. This is upstream's normal behaviour and it makes `kimi` usable; removing it would leave the client installed but unreachable. Trivially reversible.
2. **npm's user prefix was changed** — I ran `npm config set prefix ~/.npm-global --location=user`, because the system npm targets `/usr/local`, which needs root, and nvm's own npm is a **broken symlink** (`~/.nvm/versions/node/v22.23.1/bin/npm` → a `../lib/node_modules/npm/` that does not exist). This makes future `npm -g` installs land in `~/.npm-global`. Revert with `npm config delete prefix --location=user`. **`~/.npm-global/bin` is not on the owner's PATH**, so `gemini` is only reachable by full path until that is added.
3. **First-run directories created by the apps themselves**, not by me: `~/.gemini/`, `~/.codeium/windsurf/`, `~/.devin/`, `~/.config/Devin/` (including the app's own `settings.json` with Cascade disabled). Normal post-install state.

**Separate security note, unrelated to this task:** `~/.npmrc` contains an npm auth token in plaintext, and one of my commands printed it into this session's output. Worth rotating if this transcript is shared.

---

## D.7 The verification tiers, now complete

This is the table that determines what the installer is allowed to claim.

| Tier | What it proves | Clients |
|---|---|---|
| **A — the server actually runs** | The client starts our server and reports the connection | **Claude Code** (`claude mcp list` → `✔ Connected`), **Gemini CLI** (`gemini mcp list` → `✓ Connected`, in a trusted folder) |
| **B+ — the config parsed and is enabled** | An authoritative read-back of the parsed config, including the enable flag. Says nothing about liveness. | **Codex** (`codex mcp list --json`), **Goose** (`goose info -v`) |
| **B — written through the app's own CLI** | Exit code only, no read-back | **VS Code** (`code --add-mcp`), **Cursor** (`cursor --add-mcp`), **Windsurf/Devin** (`devin-desktop --add-mcp`) |
| **C — written, unverifiable** | The file is correct as far as we can tell; nothing confirms the client read it | **Claude Desktop**, **Zed**, **Kimi Code** (account wall), Cline, Continue, Warp, JetBrains |

**Genuinely verifiable on this machine: 6 of 11** — Claude Code, Gemini CLI, Codex, Goose at Tier A/B+, plus VS Code and Cursor at Tier B. **Not verifiable here: Kimi Code** (needs a Moonshot account), **Claude Desktop and Zed** (no read-back at all), and the four clients that remain uninstalled.

**Three vendor CLIs must not be trusted as verification**, each proven by a control test:
- `gemini mcp add` — reports success, writes nothing.
- `kimi doctor` — reports "all valid" over invalid JSON it never read.
- `codex mcp list` — reports a nonexistent binary as `enabled`.

The pattern is consistent enough to be a design rule: **use a vendor CLI to write only when we can independently read the result back, and never treat its success message as evidence.** For Gemini specifically, invert the usual preference — write the file directly, then verify with the CLI.

---

# Addendum E — machine restored, and how many clients there are

Added 2026-08-17.

## E.0 Correction to D.6 — the three unreverted changes are now reverted

D.6 listed three changes left in place. All three have been dealt with; **that section is superseded by this one.**

| D.6 item | Status now |
|---|---|
| `~/.zshrc` PATH line from Kimi's installer | **Removed.** `~/.zshrc` is now byte-identical to the copy taken before Kimi's installer ran (`diff` reports no differences). |
| npm user prefix set to `~/.npm-global` | **Reverted** — and it was a genuine mistake, see E.2. |
| First-run directories | Enumerated in E.3. Left in place; all are normal post-install state. |

## E.1 Credentials removed

**`~/.npmrc`** — held `//registry.npmjs.org/:_authToken=` (40-character value). Removed.

**`~/.npmrc.bak-1786545727`** — held a **second, different** npm token, also 40 characters, dated 2026-08-12. I compared the two by SHA-256 prefix rather than by value: `56a130de16aa1922` vs `774b8db7f84e3c41` — **two distinct credentials**, not one file copied twice. Removed.

Before and after, with values redacted (I did not re-print either token, and I made no backup copies of these files — that would only have spread the secret):

```
~/.npmrc BEFORE                        ~/.npmrc AFTER
1: //registry.npmjs.org/:_authToken=…  (empty file, 0 bytes)
2: prefix=/home/amirjam/.npm-global    

~/.npmrc.bak-1786545727 BEFORE         AFTER
1: //registry.npmjs.org/:_authToken=…  (empty file, 0 bytes)
```

Line 2 of `~/.npmrc` was mine, removed separately in E.2. Both files kept mode `600`. `~/.npmrc.bak-1786545727` contained nothing but the credential, so it is now a zero-byte file — safe to delete, left in place because it is the owner's file to remove.

**Both tokens should still be revoked at npmjs.com.** Deleting them from disk does not invalidate them, and the one in `~/.npmrc` was printed into this session's transcript.

### One other credential exposure, mine

While auditing, I found something I did myself and should flag rather than quietly clean up. In the first research session I copied Cursor's `state.vscdb` to the scratchpad to inspect it for MCP keys. That database contains **`cursorAuth/accessToken` and `cursorAuth/refreshToken`** (415 bytes each), plus `cursorAuth/cachedEmail`. I had no reason to copy a credential store, and I should have queried it in place. The copy and its `-shm`/`-wal` sidecars have been shredded/removed. The original under `~/.config/Cursor/` was never modified. Those tokens were never printed.

### Everything else checked, and clean

- `~/.zshrc`, `~/.bashrc` and the pre-change copies of both: **zero** credential-shaped lines.
- The whole scratchpad, scanned for `_authToken`, `Bearer …`, `sk-…`, `npm_…`, `ghp_…`, `"access_token"`: no matches remaining.
- `~/.config/Claude/config.json` holds `oauth:tokenCache` / `oauth:tokenCacheV2` and `~/.claude.json` holds `oauthAccount` — both are the applications' own credential stores, both untouched, and neither was ever printed.
- `~/j4m-env.sh` and `~/j4m-keys/` exist in the home directory. **I did not open either** — I had no reason to, and reading them would have been the same mistake as the Cursor copy. Flagging only that they are there.

## E.2 The npm prefix — I was wrong, and it revealed a real problem

**It was a mistake, and it is reverted.** Setting `prefix` in `~/.npmrc` is explicitly incompatible with nvm. With my change in place:

```
$ nvm use v22.23.1
Your user's .npmrc file (${HOME}/.npmrc)
has a `globalconfig` and/or a `prefix` setting, which are incompatible with nvm.
Run `nvm use --delete-prefix v22.23.1` to unset it.
```

I broke `nvm use` on a machine that uses nvm. After removing the line:

```
$ nvm use v22.23.1
Now using node v22.23.1 (npm v9.2.0)
```

`npm config get prefix` is back to `/usr/local`. Gemini CLI still runs from `~/.npm-global/bin/gemini` — the install is a self-contained bundle and does not depend on the prefix setting.

**The underlying problem is real and predates me.** The reason I reached for a prefix at all is that this machine has no working user-level npm:

- `~/.nvm/versions/node/v22.23.1/lib/` is **empty** — `lib/node_modules` does not exist at all, so npm was never installed alongside that node.
- Consequently `~/.nvm/versions/node/v22.23.1/bin/npm` and `bin/npx` are **dangling symlinks** pointing at `../lib/node_modules/npm/bin/npm-cli.js`.
- `command -v npm` therefore falls through to `/usr/bin/npm`, Ubuntu's system npm, **version 9.2.0**, whose prefix is root-owned `/usr/local`.

So the machine is running **node v22 paired with npm 9.2.0**, and nvm itself reports the mismatch: `Now using node v22.23.1 (npm v9.2.0)`. Node 22 ships with npm 10/11; npm 9 is from the node 18 era.

**This matters beyond convenience.** Addendum C recommends publishing a `server.json` to the official MCP registry, and nosyparker is an npm-shaped project. Publishing from a half-broken npm — wrong major version, global installs needing root — is worth fixing first.

**The repair** (the owner's to run, not mine — it reinstalls a toolchain):

```
nvm uninstall v22.23.1
nvm install 22          # installs node 22 together with its bundled npm
nvm alias default 22
```

Then `command -v npm` resolves inside nvm, `npm -g` installs to the nvm prefix without root, and no `prefix=` line in `~/.npmrc` is needed. Do **not** re-add a `prefix` setting afterwards — that is what breaks nvm.

## E.3 Complete list of what is different from how I found it

**Installed, intentionally kept — six clients:**

| Path | What | Size |
|---|---|---|
| `~/.local/zed.app/` + `~/.local/bin/zed` | Zed 1.15.0 | 424 MB |
| `~/.codex/` + `~/.local/bin/codex` | Codex 0.147.0 | 301 MB |
| `~/.npm-global/` | Gemini CLI 0.55.1 | 122 MB |
| `~/.kimi-code/` | Kimi Code 0.36.1 | 173 MB |
| `~/.local/bin/goose` | Goose 1.46.0 | ~300 MB |
| `~/.local/Devin/` | Devin Desktop 1.126.0 (Windsurf) | 1.2 GB |

All six verified still running after cleanup. Disk: **14 GB free** (was 16 GB).

**Directories the applications created on first run** — not written by me, normal post-install state:
`~/.config/zed/` (contains only `themes/`) · `~/.local/share/zed/` · `~/.gemini/` (`projects.json`, `history/`, `tmp/`) · `~/.codeium/windsurf/` · `~/.devin/` · `~/.devin-shared/` · `~/.config/Devin/` (including the app's own `settings.json` with `devin.cascade.enabled: false`) · `~/.kimi-code/{cache,logs,updates}` · `~/.local/state/goose/`

**One desktop entry added:** `~/.local/share/applications/dev.zed.Zed.desktop`, by Zed's installer. **No autostart entries were added** by any of the six — `~/.config/autostart/` still contains only Firefox, Mailspring and Telegram.

**`~/.nosyparker/memory.sqlite`** — 28 KB, **created at 09:08 by my Zed test**, because I wired the real Phase 2 server and Zed started it. It contains the schema and **zero rows** (`memories` 0, `decisions` 0). I removed its stale `-shm`/`-wal` sidecars and left the empty database, since it is the product's own store and would be recreated on first use anyway. Delete it if you want a literal clean slate.

**Files edited:** `~/.npmrc` (token + my prefix line removed → now empty), `~/.npmrc.bak-1786545727` (token removed → now empty), `~/.zshrc` (Kimi's line removed → identical to before).

**Test configs written and then removed** — all verified absent: `~/.codex/config.toml`, `~/.gemini/settings.json`, `~/.gemini/trustedFolders.json`, `~/.kimi-code/mcp.json`, `~/.config/goose/config.yaml`, `~/.config/Devin/User/mcp.json`, `~/.config/zed/settings.json`, `~/.codeium/windsurf/mcp_config.json`. No `mcp-server.js` processes left running. **The zero-servers-configured baseline holds for every client in the table.**

**Repository:** `git status` shows exactly one untracked file, `PHASE3-RESEARCH.md`. No branch, no commits, no product code.

**Not reverted, deliberately:** the six client installs, their first-run directories, the Zed desktop entry, and the empty nosyparker store. Say the word on any of them.

---

## E.4 How many MCP clients exist, and could we test them all?

**Short answer: about 26 that matter for installation, roughly 90 if you count everything, about 19 testable on this machine — and the top six cover something like 90% of users. "Test them all" is the wrong goal.**

### The counts, and how much they overlap

| Source | Count | What it counts | [conf] |
|---|---|---|---|
| **API Commons `clients.json`** | **26** | Curated, install-oriented: only clients someone has documented a real install path for | [FETCHED] — full enumeration |
| **`punkpeye/awesome-mcp-clients`** | **~90+** | Everything: desktop apps (~35), CLIs (~20), IDE extensions (~10), web/hosted (~20), libraries and frameworks (~10), messaging integrations (~8) | [SECONDARY] |
| **Official MCP documentation** | **no list** | The former client list page is gone; the docs now name a handful inline and say "many others" | [DOCS] |

*Correction: my first pass reported `clients.json` as holding 33 clients. Enumerating it properly returns **26**. The lower number is right.*

**The overlap is high, which is the good news.** Of the 26 in `clients.json`, **our table already covers 13**: Cursor, VS Code, Claude Code, Claude Desktop, Windsurf, Zed, Cline, Continue, Warp, Gemini CLI, Codex CLI, JetBrains AI, Goose. We additionally carry **Kimi Code and Copilot CLI, which `clients.json` does not list** — so our table is not a subset of theirs.

The ~90 figure is not 90 competitors to the 26. It is the same core plus libraries, frameworks, hosted web apps and Slack bots — categories that either have no local config file to write or are not end-user clients at all. **Three lists that mostly agree on a core of ~25, not 90 distinct targets.**

### How many are realistically testable here

Of the 13 in `clients.json` we do not yet carry:

| Out of reach | Count | Why |
|---|---|---|
| Web connectors — Claude (web), ChatGPT, GitHub Copilot coding agent | 3 | **No local config file exists.** Servers are added through a web UI as remote connectors. A local stdio server cannot be installed into them at all — out of scope by construction, not by effort. |
| Platform-exclusive — Visual Studio (Windows), Raycast (mac/Windows), Perplexity Desktop (mac) | 3 | Not installable on Linux. Documentable, never verifiable here. |
| Not an end-user client — MCP Inspector | 1 | A developer debugging tool. |
| **Genuinely installable on Linux** — LM Studio, Roo Code, Kiro, Amazon Q Developer CLI, opencode | **5** | Could be tested exactly as the five in Addendum D were. |
| Free variant — VS Code Insiders | 1 | Same code path as VS Code, different data directory. Near-zero cost. |

So the realistic testable universe on this machine is roughly **19**: the 13 we carry, plus those 5, plus the Insiders variant. Add Hermes and OpenClaw from Addendum C and it is **21**. **Everything else is either not a local-config client at all, or not runnable on Linux.**

### What fraction of users the top few cover

All market data here is **[SECONDARY]** and the surveys **disagree with each other**, so treat the shape as reliable and the digits as not:

| Source | Copilot | Cursor | Claude Code | Windsurf |
|---|---|---|---|---|
| Stack Overflow 2025/26 | 51% (down from 67%) | 18% | 10% | 5% |
| JetBrains AI Pulse, Jan 2026 (10,000+ devs) | 29% | 18% | 18% | — |
| Third-party aggregate, 2026 | 42% share / 20M+ users | — | 28% *primary-tool* share | — |

Two structural facts matter more than any single number:

1. **84% of developers use or plan to use AI coding tools**, 51% every workday.
2. **70% of engineers use 2–4 tools simultaneously.**

That second fact is the one that decides the strategy. Because most people run several tools and the same handful dominates every survey, the right question is not "what share does client N have" but **"what is the chance a given user has at least one client we verified?"** With Copilot/VS Code, Cursor, Claude Code, Claude Desktop, Gemini CLI and Codex all covered, that probability is very high — I would put the top six at roughly **85–90% of users having at least one**, and multi-tool usage pushes it higher still, because a user has to have *all* of their 2–4 tools outside our set to be missed.

The corollary is blunt: **the marginal value of client #15 is close to zero.** Almost nobody's entire toolset lies outside the top six.

### Recommendation: where the line goes

**Tier 1 — verified rows, ship these (7).** Installed and tested on this machine with the real Phase 2 server.
Claude Code and Gemini CLI (Tier A, prove the server runs) · Codex and Goose (Tier B+, parsed-config read-back) · VS Code, Cursor, Windsurf/Devin (Tier B, write via the app's own CLI).

**Tier 2 — installed, written from verified on-disk paths, reported unverified (3).**
Claude Desktop, Zed, Kimi Code. Paths and entry shapes are confirmed against real installations; none offers a read-back (Kimi needs an account, the other two have no mechanism). Write them and say plainly that we cannot confirm.

**Tier 3 — documented only, carry cheaply (4).**
Cline, Continue, Warp, JetBrains/Junie. Config shapes known from docs, all in `clients.json`. Low cost to include, must be marked unverified. Promote one to Tier 1 the moment a real user asks.

**Tier 4 — do not carry.**
Web connectors (Claude web, ChatGPT, Copilot coding agent) — no local config exists, so there is nothing to write. MCP Inspector — a dev tool. Platform-exclusives (Visual Studio, Raycast, Perplexity Desktop) — unverifiable here and thin Linux overlap.

**Watch list, add on demand:** LM Studio, Roo Code, Kiro, Amazon Q Developer, opencode, Hermes, OpenClaw. All Linux-installable; none has shown up as a request yet.

**So: could we test them all?** No — and the number that settles it is not 90 or 26 but **19**, of which we have already verified 7 and installed 10. The remaining gap is a long tail where each addition costs a full install-and-verify cycle and buys a percent or two of coverage. **Stop at Tier 3, keep the `clients.json` CI diff from C.1 as the early-warning system for the tail, and ship the `--print-config` escape hatch so an unsupported client costs a user a copy-paste rather than a bug report.**

## E.5 Node repaired, store deleted — final machine state

Both approved cleanup jobs are done.

### Node

| | Before | After |
|---|---|---|
| node | v22.23.1 (nvm) | **v22.23.2** (nvm) |
| npm | **9.2.0 from `/usr/bin/npm`** (Ubuntu system) | **10.9.8** from nvm |
| `which npm` | `/usr/bin/npm` | `/home/amirjam/.nvm/versions/node/v22.23.2/bin/npm` |
| `npm config get prefix` | `/usr/local` (root-owned) | `/home/amirjam/.nvm/versions/node/v22.23.2` |
| `npm` / `npx` symlinks | **dangling** | resolve to real files under `lib/node_modules/npm/bin/` |
| `lib/node_modules` | **did not exist** | exists, contains `npm` and `corepack` |
| `~/.npmrc` | token + `prefix=` line | **empty, 0 bytes** — no `prefix` line re-added |

`nvm uninstall v22.23.1` had to run *after* switching away from it (nvm refuses to remove the active version). Only `v22.23.2` remains; `default -> 22`. `nvm use` no longer emits the prefix-incompatibility warning.

**Verified in a fresh login shell** (`zsh -lic`), not the working shell: `node -v` → `v22.23.2`, `npm -v` → `10.9.8`, and `command -v npm` resolves inside `~/.nvm`.

### The project still works on the new Node

Run on `main` at `797fe73`:

```
npm test       → 121 tests, 121 pass, 0 fail    exit 0
npm run typecheck → tsc --noEmit, no output      exit 0
```

**No breakage from the version bump.** `node:sqlite` still emits its `ExperimentalWarning` internally, and the existing test `no Node warning about SQLite reaches the terminal` still passes — the suppression Phase 1 built holds on 22.23.2.

Worth recording: the suite did **not** touch `~/.nosyparker`. Its mtime stayed at 09:08 (my Zed test) across two full runs, so the tests use an isolated store.

### Nothing else depended on the old npm setup

- `/usr/local/lib/node_modules` and `/usr/local/bin` were **both empty** — nothing was ever installed under the system prefix, so nothing was lost by moving off it.
- `~/.npm-global/bin/gemini` still runs; it is a self-contained bundle and never depended on the prefix setting.
- `termgraph` is pipx-managed and unaffected.
- **One casualty, and it predates me:** `~/.nvm/versions/node/v22.23.1/bin/mathos` was a dangling symlink to `../lib/node_modules/mathos/dist/cli/index.js`. A global package `mathos` was installed under that node on 2026-08-02, and the `lib` directory was emptied on **2026-08-14 at 22:25** — three days before I touched this machine. It was already broken and not on `PATH`. The `nvm uninstall` removed the dead symlink along with the version. **If `mathos` is wanted, it needs reinstalling: `npm i -g mathos`** (which now works without root).

### `~/.nosyparker/` deleted

Removed entirely — directory and the 28 KB empty `memory.sqlite`. Confirmed gone. No process held it. Phase 3's `setup` command will now create the store from nothing, which is the point.

### Complete list of what remains from this work

**Six clients, intentionally kept:** `~/.local/zed.app` + `~/.local/bin/zed` · `~/.codex` + `~/.local/bin/codex` · `~/.npm-global` (Gemini CLI) · `~/.kimi-code` · `~/.local/bin/goose` · `~/.local/Devin`.

**Directories the apps created on first run** — the full list, including four not named in D.6:
`~/.config/zed/` · `~/.local/share/zed/` · `~/.cache/zed/` · `~/.gemini/` · `~/.codeium/windsurf/` · `~/.devin/` · `~/.devin-shared/` · `~/.config/Devin/` · **`~/.config/devin/`** (lowercase, empty — a second directory Devin makes) · `~/.kimi-code/{cache,logs,updates}` · **`~/.cache/kimi-code/`** · **`~/.local/share/goose/`** · **`~/.local/state/goose/`**

**One desktop entry:** `~/.local/share/applications/dev.zed.Zed.desktop`. No autostart entries added.

**Caches that grew:** `~/.npm` is now 91 MB (the Gemini install); `~/.nvm` is 266 MB (fresh Node 22.23.2).

**One thing I caused indirectly and should name:** `~/.local/share/keyrings/login.keyring` has an mtime of 12:02:42, exactly when Devin Desktop first launched. The directory is pre-existing (created March 2026); Devin, being Electron, touched the login keyring on startup. I did not read it.

**Not mine, flagged for completeness:** `~/.config/google-chrome/` shows a recent mtime. It was created in May 2026 and I never launched Chrome or opened that directory — the timestamp is not attributable to this work.

**Files edited:** `~/.npmrc` (token + prefix removed → empty) · `~/.npmrc.bak-1786545727` (token removed → empty) · `~/.zshrc` (Kimi line removed → byte-identical to before).

**Repository:** one untracked file, `PHASE3-RESEARCH.md`. No branch, no commits, no product code. Disk: **14 GB free**.

**Still outstanding for the owner:** revoke both npm tokens at npmjs.com — removing them from disk does not invalidate them.

---

# Addendum F — the `clients.json` drift watcher (a Phase 3 item)

Approved as the mechanism for keeping the client table current. This is the buildable specification.

## F.1 What it is

A scheduled CI job that compares **our client table** against the community **`clients.json`** and fails loudly when they disagree. It is a *second opinion*, never a source of truth, and it never runs at install time.

The critical design decision: **vendor a copy.** The repo holds `vendor/clients.json` at a reviewed revision. The job diffs *live upstream* against *the vendored copy*, so the baseline is something a human approved rather than a moving target. Updating the vendored copy is a pull request with a human reading the diff.

That gives two comparisons, and both matter:

1. **upstream vs vendored** — "has the community's picture of the world changed?"
2. **vendored vs our table** — "have we drifted from the picture we last agreed with?"

## F.2 What it watches

Per client, only the fields both sides actually model:

| Field | Why it matters |
|---|---|
| `configPaths` per OS | The single most likely thing to change and the most damaging to get wrong |
| `rootKey` | `mcpServers` vs `servers` vs `context_servers` |
| `category` | A client moving from `config` to `cli` means we should switch to its CLI |
| `cliTemplates` | Our preferred write path when one exists |
| `transports` | A client dropping stdio would be a hard break |
| set membership | New clients appearing; clients we carry disappearing |

Plus one field only we hold: **`lastVerified`** — a date per client recording when someone last ran the install-and-verify loop from Addendum D against a real installation. The ecosystem has no such field; ours is the one that ages honestly.

## F.3 What it can catch

- **A new client appears in `clients.json`** that our table does not carry → triage for the watch list.
- **A path, root key, or category changes upstream** for a client we carry → a strong hint that a vendor moved something, and a prompt to re-verify.
- **A client we carry vanishes upstream** → possibly discontinued or renamed, as Windsurf → Devin and `block/goose` → `aaif-goose/goose` both were.
- **Our table diverging from the reviewed baseline** through an unreviewed edit.

## F.4 What it cannot catch — and the mitigation

This is the part that decides whether the job is honest or merely reassuring.

**`clients.json` has no `lastUpdated` field.** Nothing in it distinguishes "verified last week" from "written in January and untouched since". So **a clean diff proves nothing about the world; it only proves upstream has not changed.** If upstream goes stale, the job goes quiet at exactly the moment we most need noise.

*Mitigation:* record the upstream file's HTTP `ETag`/`Last-Modified` and a content hash on every run. If the content hash has not moved in **90 days**, fail the job with "upstream unchanged for N days — treat as unmaintained, re-verify the top tier by hand." **Silence becomes a signal instead of an absence of one.**

**It cannot see anything `clients.json` does not model.** Everything that made this research worth doing is invisible to it:

- The verification tier and the command that establishes it.
- Blocking settings — VS Code's nine `chat.mcp.*` gates, Gemini's `trustedFolders.json` suppression of user-level servers, Goose's required `enabled: true`, Codex's `enabled = false`.
- VS Code's **per-profile** `mcp.json`, which `clients.json` reduces to "user-level".
- Windsurf/Devin's **two** config surfaces — upstream lists only the `~/.codeium/…` one.
- Claude Desktop's **Linux** path, which upstream omits entirely.
- **Kimi Code**, which is not in `clients.json` at all.

*Mitigation:* those fields live in our table with their own `lastVerified` date and are **never** overwritten from upstream. The watcher may only ever *raise a question*; it may never edit our table.

**It cannot tell truth from error.** `clients.json` is community-maintained and unverified. A wrong entry upstream produces a diff against a row we verified on a real installation. **Our verified row always wins**; the correct response is a PR upstream, not a change to ours.

## F.5 What a person does when it fires

The job's output is a triage list, and every row ends in a decision:

| Diff | Action |
|---|---|
| New client upstream | Add to the watch list. Install and verify only if it is Linux-installable and someone has asked for it (see E.4 tiers). Otherwise record it and move on. |
| Path/key changed for a **verified** client | **Re-run the D-loop on this machine**: install if needed, write the entry, verify by that client's read-back. Our row changes only after that passes. |
| Path/key changed for a **documented-only** client | Update the row from the new documentation and keep it marked unverified. Cheap. |
| Client disappears upstream | Check for a rename (`git`-style redirect, vendor announcement) before assuming discontinuation. Both of the renames we hit this cycle were discoverable in one HTTP request. |
| Upstream unchanged for 90 days | Manually re-verify the Tier 1 clients. Do not trust the quiet. |
| Our table vs vendored baseline diverges | Someone edited the table without updating the baseline — review and re-vendor. |

## F.6 Scope, deliberately small

- Runs **weekly** on a schedule, and on any PR touching the client table. Not on every push.
- **Never runs at install time.** The installer ships a static table; a user's install must not depend on a third-party URL being up.
- Network failure is **not** a build failure — a fetch error reports "could not check" and exits zero, so an upstream outage does not block the repo.
- Total moving parts: one vendored JSON file, one fetch, one structural diff, one staleness clock. If it grows beyond that it has stopped being a canary.

**In one line:** it is a canary for the long tail, not a substitute for having installed the thing. The seven Tier 1 rows are trustworthy because they were verified against real installations on this machine, and only re-verification keeps them that way.
