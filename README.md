# pi-omp-session-sync

Bidirectional session sync between vanilla Pi (`@earendil-works/pi-coding-agent`) and OMP (`@oh-my-pi/pi-coding-agent`).

Adds a `/pi-omp-sync` slash command to whichever runtime you're in. When run inside Pi it imports OMP sessions; when run inside OMP it imports Pi sessions. Sessions get rewritten into the target runtime's native JSONL format with the model entry shape and title metadata each runtime expects.

## Features

- `/pi-omp-sync` slash command in both runtimes
- Interactive session selector
- `list`, `status`, `all`, `all --dry-run`, `open <session-id>` subcommands
- Filters: `--cwd`, `--since`, `--updated-since`, `--limit`, `--source-dir`
- Idempotent registry keyed by source session id + source mtime
- Stale-source detection: re-imports automatically when the source file changes
- OMP-only entry types (`mode_change`, `service_tier_change`, `session_init`) skipped on OMP→Pi
- `model_change` reshaped both directions (`{provider, modelId}` ↔ `model: "provider/modelId"`)
- Title round-tripped: Pi's `session_info` entry ↔ OMP's header `title`

## Install

### Vanilla Pi

```bash
pi install /path/to/pi-omp-session-sync
```

…or add the absolute repo path to `~/.pi/agent/settings.json:packages[]`.

### OMP

Add the package as a `file:` dependency in `~/.omp/plugins/package.json` and symlink the repo into `~/.omp/plugins/node_modules/pi-omp-session-sync`:

```bash
ln -s /path/to/pi-omp-session-sync ~/.omp/plugins/node_modules/pi-omp-session-sync
```

Then update `~/.omp/plugins/package.json`:

```json
{
  "dependencies": {
    "pi-omp-session-sync": "file:/path/to/pi-omp-session-sync"
  }
}
```

Verify with `omp plugin doctor`.

## Usage

```text
/pi-omp-sync                          # interactive selector
/pi-omp-sync <session-id>             # sync a specific session
/pi-omp-sync list [search]            # list source-runtime sessions
/pi-omp-sync status                   # show registry + pending counts
/pi-omp-sync all --dry-run            # preview bulk sync
/pi-omp-sync all                      # bulk sync, idempotent
/pi-omp-sync open <session-id>        # switch to a synced session
```

Flags:

```text
--source-dir /path/to/sessions
--registry /path/to/registry.json
--limit 100
--cwd /repo/path
--since 2026-05-01
--updated-since 2026-05-15
--force
--dry-run
```

## Behavior

When running inside **Pi**, the command imports **OMP** sessions into Pi.
When running inside **OMP**, the command imports **Pi** sessions into OMP.

Each imported session becomes a new native session file in the target runtime. The source file is never modified. The registry (`~/.pi/agent/pi-omp-sync-registry.json` or `~/.omp/agent/pi-omp-sync-registry.json`) tracks source session id → target session file, mtime, and conversion version. A bulk re-run skips sessions whose source mtime hasn't changed; `--force` overrides.

## What's preserved

| Concept | Pi format | OMP format | Round-trip |
|---|---|---|---|
| Title | `session_info.name` entry | header `title` + `titleSource` | yes |
| Model | `model_change {provider, modelId}` | `model_change {model: "provider/modelId"}` | yes |
| Messages | `message.message` (AgentMessage) | same | yes |
| Thinking level | `thinking_level_change` | same | yes |
| Custom messages | `custom_message` | same | yes |
| OMP-only entries | n/a | `mode_change`, `service_tier_change`, `session_init` | dropped on OMP→Pi |

## Tests

```bash
bun test
```
