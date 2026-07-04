---
name: orchestrate
description: Orquesta ejecución multi-agente de un plan de implementación
user_invocable: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# /orchestrate — Comando de Orquestación Multi-Agente

## Descripción

Ejecuta un plan de implementación delegando tareas a subagentes aislados. Resuelve Context Rot y optimiza tokens mediante paralelismo real.

## Sintaxis

```
/orchestrate <spec.md> <plan.md> [opciones]
```

## Parámetros

| Parámetro | Requerido | Descripción |
|---|---|---|
| `<spec.md>` | ✅ | Archivo de especificación del negocio |
| `<plan.md>` | ✅ | Plan de implementación con YAML frontmatter |
| `--models <config>` | ❌ | Asignación: `light=haiku,medium=sonnet,heavy=opus` |
| `--concurrency <n>` | ❌ | Workers concurrentes (default: 4) |
| `--timeout <ms>` | ❌ | Timeout por tarea (default: 300000) |
| `--retries <n>` | ❌ | Reintentos máximos (default: 3) |
| `--dry-run` | ❌ | Solo parsear, no ejecutar |
| `--resume` | ❌ | Reanudar plan existente |

## Ejemplos

```bash
# Básico
/orchestrate spec.md plan.md

# Con modelos personalizados
/orchestrate spec.md plan.md --models light=haiku,medium=sonnet,heavy=opus

# Solo vista previa
/orchestrate spec.md plan.md --dry-run

# Máxima concurrencia
/orchestrate spec.md plan.md --concurrency 8
```

## Formato Requerido de plan.md

El archivo `plan.md` DEBE tener un bloque YAML válido:

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
    title: "Definir schema"
    tier: "light"
    dependencies: []
  - id: "task-002"
    title: "Implementar API"
    tier: "medium"
    dependencies: ["task-001"]
---

# Descripción del Negocio

[Contenido Markdown aquí...]
```

## Tiers de Modelo

| Tier | Modelo Default | Caso de Uso |
|---|---|---|
| `light` | haiku | CRUD, config, docs simples |
| `medium` | sonnet | APIs, lógica de negocio, tests |
| `heavy` | opus | Arquitectura, algoritmos, seguridad |

## Flujo de Ejecución

1. **Parseo**: Lee `spec.md` y `plan.md`, valida YAML
2. **DAG**: Resuelve dependencias entre tareas
3. **Spawn**: Crea workers aislados por tarea
4. **Validación**: Validators verifican output de cada worker
5. **Persistencia**: Actualiza `plan.md` con estado atómicamente
6. **TUI**: Renderiza dashboard en tiempo real

## Seguridad

- Workers NO heredan `spawn_subagent` (sin recursión)
- I/O restringido a `./output/{task_id}/`
- Circuit Breaker: máximo 3 reintentos por tarea
- Timeout global por tarea

## Errores Comunes

| Error | Solución |
|---|---|
| `Archivo no encontrado` | Verificar rutas con `ls *.md` |
| `YAML inválido` | Revisar indentación del frontmatter |
| `Dependencias cíclicas` | Revisar `dependencies` en cada tarea |
| `Modelo no disponible` | Usar: haiku, sonnet, u opus |
