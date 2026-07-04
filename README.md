# Pi Orchestrator

Multi-agent orchestrator for [Pi Agent](https://pi.dev) — parallel task execution with TUI dashboard.

## What is this?

Pi Orchestrator solves **Context Rot** and **excessive token consumption** by delegating tasks to isolated subagents. Each worker runs in a clean session with minimal context, maximizing parallelism while maintaining quality.

## Features

- **Parallel Execution** — Multiple workers run simultaneously
- **Isolated Sessions** — Each worker gets a clean context (no Context Rot)
- **TUI Dashboard** — Real-time visualization of task progress
- **Circuit Breaker** — Automatic failure detection and recovery
- **Model Tiers** — Auto-assign models by task complexity (light/medium/heavy)
- **Atomic Persistence** — Race-condition-free state updates

## Installation

```bash
pi install npm:@pi-orch/orchestrator
```

## Usage

### Basic

```bash
/orchestrate spec.md plan.md
```

### With Custom Models

```bash
/orchestrate spec.md plan.md --models light=haiku,medium=sonnet,heavy=opus
```

### Dry Run (Preview)

```bash
/orchestrate spec.md plan.md --dry-run
```

### All Options

```bash
/orchestrate <spec.md> <plan.md> [opciones]

Opciones:
  --models <config>    Asignación de modelos por tier
  --concurrency <n>    Workers concurrentes (default: 4)
  --timeout <ms>       Timeout por tarea (default: 300000)
  --retries <n>        Reintentos máximos (default: 3)
  --dry-run            Solo parsear, no ejecutar
  --resume             Reanudar plan existente
```

## Plan Format

Your `plan.md` must have a YAML frontmatter:

```yaml
---
version: "1.0"
plan_id: "plan-auth-module"
status: "queued"

models:
  light: haiku
  medium: sonnet
  heavy: opus

config:
  max_concurrent_workers: 4
  max_retries: 3
  timeout_per_task_ms: 300000

tasks:
  - id: "task-001"
    title: "Define schema"
    tier: "light"
    dependencies: []
  - id: "task-002"
    title: "Implement API"
    tier: "medium"
    dependencies: ["task-001"]
---

# Business Description

[Your spec content here...]
```

## Model Tiers

| Tier | Default Model | Use Case |
|---|---|---|
| `light` | haiku | CRUD, config, simple docs |
| `medium` | sonnet | APIs, business logic, tests |
| `heavy` | opus | Architecture, algorithms, security |

## How It Works

1. **Parse** — Reads spec.md and plan.md, validates YAML
2. **DAG** — Resolves task dependencies
3. **Spawn** — Creates isolated workers per task
4. **Validate** — Validators verify each worker's output
5. **Persist** — Updates plan.md with atomic writes
6. **TUI** — Renders real-time dashboard

## Security

- Workers **cannot** spawn other workers (no recursion)
- File I/O restricted to `./output/{task_id}/`
- Circuit Breaker: max 3 retries per task
- Global timeout per task

## Development

```bash
# Clone
git clone https://github.com/pi-orch/pi-orchestrator.git
cd pi-orchestrator

# Install dependencies
npm install

# Test locally
pi -e ./extensions/index.ts
```

## License

MIT
