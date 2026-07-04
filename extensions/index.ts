import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Pi Orchestrator Extension
 * Parses plan.md and orchestrates task execution
 */

// Simple YAML parser (no external deps)
function parseSimpleYaml(content: string): any {
  const result: any = {};
  const lines = content.split("\n");
  let currentKey = "";
  let currentObj = result;
  let inTasks = false;
  let currentTask: any = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Top level key
    const topMatch = trimmed.match(/^(\w[\w_]*):\s*$/);
    if (topMatch) {
      const key = topMatch[1];
      if (key === "tasks") {
        inTasks = true;
        result.tasks = [];
      } else {
        inTasks = false;
        currentKey = key;
        result[key] = {};
        currentObj = result[key];
      }
      continue;
    }

    // Key with value
    const kvMatch = trimmed.match(/^(\w[\w_]*):\s*(.+)/);
    if (kvMatch) {
      const [, key, value] = kvMatch;
      let val: any = value.trim();

      // Parse value
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      } else if (val === "true") val = true;
      else if (val === "false") val = false;
      else if (!isNaN(Number(val))) val = Number(val);

      if (inTasks) {
        if (key === "id" || key === "title" || key === "tier" || key === "prompt" || key === "model") {
          if (!currentTask) currentTask = {};
          currentTask[key] = val;
        } else if (key === "dependencies") {
          // Handle array format: [item1, item2]
          if (val.startsWith("[")) {
            currentTask.dependencies = val.slice(1, -1).split(",").map((s: string) => s.trim().replace(/['"]/g, ""));
          }
        }
      } else if (currentObj) {
        currentObj[key] = val;
      }
    }

    // Array item in tasks
    if (trimmed.startsWith("- ") && inTasks) {
      if (currentTask && currentTask.id) {
        result.tasks.push(currentTask);
      }
      currentTask = {};
      const item = trimmed.slice(2).trim();
      const itemMatch = item.match(/^(\w[\w_]*):\s*(.+)/);
      if (itemMatch) {
        let val: any = itemMatch[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        currentTask[itemMatch[1]] = val;
      }
    }
  }

  // Push last task
  if (currentTask && currentTask.id) {
    result.tasks.push(currentTask);
  }

  return result;
}

// Simple YAML stringify
function toSimpleYaml(obj: any): string {
  let yaml = "";
  for (const [key, value] of Object.entries(obj)) {
    if (key === "tasks" && Array.isArray(value)) {
      yaml += "tasks:\n";
      for (const task of value) {
        for (const [k, v] of Object.entries(task)) {
          yaml += `  - ${k}: ${typeof v === "string" ? `"${v}"` : v}\n`;
        }
      }
    } else if (typeof value === "object" && value !== null) {
      yaml += `${key}:\n`;
      for (const [k, v] of Object.entries(value)) {
        yaml += `  ${k}: ${typeof v === "string" ? `"${v}"` : v}\n`;
      }
    } else {
      yaml += `${key}: ${typeof value === "string" ? `"${value}"` : value}\n`;
    }
  }
  return yaml;
}

interface TaskState {
  id: string;
  title: string;
  tier: string;
  model?: string;
  dependencies: string[];
  prompt: string;
  status: "queued" | "running" | "done" | "fail" | "blocked";
  retryCount: number;
}

let currentPlan: any = null;
let taskStates: Map<string, TaskState> = new Map();

export default function (pi: ExtensionAPI) {
  // Register /orchestrate command
  pi.registerCommand("orchestrate", {
    description: "Orquesta ejecución multi-agente de un plan",
    handler: async (args, ctx) => {
      try {
        const parts = args.trim().split(/\s+/);

        if (parts.length < 2) {
          ctx.ui.notify("Uso: /orchestrate <spec.md> <plan.md> [--dry-run]", "error");
          return;
        }

        const specPath = resolve(ctx.cwd, parts[0]);
        const planPath = resolve(ctx.cwd, parts[1]);
        const dryRun = parts.includes("--dry-run") || parts.includes("-d");

        // Validate files
        if (!existsSync(specPath)) {
          ctx.ui.notify(`❌ Spec no encontrado: ${parts[0]}`, "error");
          return;
        }
        if (!existsSync(planPath)) {
          ctx.ui.notify(`❌ Plan no encontrado: ${parts[1]}`, "error");
          return;
        }

        // Parse plan
        const planContent = readFileSync(planPath, "utf-8");
        const frontmatterMatch = planContent.match(/^---\n([\s\S]*?)\n---/);

        if (!frontmatterMatch) {
          ctx.ui.notify("❌ plan.md no tiene YAML frontmatter", "error");
          return;
        }

        const planYaml = parseSimpleYaml(frontmatterMatch[1]);

        if (!planYaml?.tasks || planYaml.tasks.length === 0) {
          ctx.ui.notify("❌ No hay tareas en plan.md", "error");
          return;
        }

        // Initialize task states
        taskStates.clear();
        for (const task of planYaml.tasks) {
          taskStates.set(task.id, {
            id: task.id,
            title: task.title,
            tier: task.tier || "medium",
            model: task.model,
            dependencies: task.dependencies || [],
            prompt: task.prompt || task.title,
            status: "queued",
            retryCount: 0,
          });
        }

        currentPlan = planYaml;

        // Dry run
        if (dryRun) {
          let msg = `\n📋 Plan: ${planYaml.plan_id || "sin-id"}\n`;
          msg += `📊 Total: ${planYaml.tasks.length} tareas\n\n`;

          for (const task of planYaml.tasks) {
            const deps = task.dependencies?.length > 0 ? ` ← [${task.dependencies.join(", ")}]` : "";
            msg += `  • ${task.id}: ${task.title} (${task.tier || "medium"})${deps}\n`;
          }

          // Find ready tasks
          const ready = Array.from(taskStates.values()).filter(t =>
            t.status === "queued" && (!t.dependencies || t.dependencies.length === 0)
          );
          msg += `\n🚀 Listas ahora: ${ready.map(t => t.id).join(", ") || "ninguna"}\n`;

          ctx.ui.notify(msg, "info");
          return;
        }

        // Execute
        ctx.ui.notify(`🚀 Orchestrator: ${planYaml.tasks.length} tareas`, "info");
        ctx.ui.setStatus("orchestrator", `🐙 ${planYaml.tasks.length} tasks`);

        // Build execution plan and let LLM execute
        const specContent = readFileSync(specPath, "utf-8");
        await executePlan(pi, ctx, planYaml, specContent, planPath);

      } catch (error: any) {
        ctx.ui.notify(`❌ Error: ${error.message}`, "error");
        console.error("Orchestrator error:", error);
      }
    },
  });

  // Register orchestrate tool
  pi.registerTool({
    name: "orchestrate",
    label: "Orchestrate",
    description: "Ejecuta un plan multi-agente desde un spec.md y plan.md",
    parameters: Type.Object({
      spec_file: Type.String({ description: "Ruta al spec.md" }),
      plan_file: Type.String({ description: "Ruta al plan.md" }),
      dry_run: Type.Optional(Type.Boolean({ description: "Solo mostrar plan" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        onUpdate?.({ content: [{ type: "text", text: `Parseando: ${params.plan_file}...` }] });

        const planPath = resolve(ctx.cwd, params.plan_file);
        if (!existsSync(planPath)) {
          return { content: [{ type: "text", text: `Error: ${params.plan_file} no encontrado` }], details: {} };
        }

        const content = readFileSync(planPath, "utf-8");
        const match = content.match(/^---\n([\s\S]*?)\n---/);
        if (!match) {
          return { content: [{ type: "text", text: "Error: YAML frontmatter no encontrado" }], details: {} };
        }

        const yaml = parseSimpleYaml(match[1]);
        const tasks = yaml?.tasks || [];

        const summary = tasks.map((t: any) =>
          `• ${t.id}: ${t.title} [${t.tier || "medium"}]`
        ).join("\n");

        return {
          content: [{ type: "text", text: `📋 ${tasks.length} tareas:\n\n${summary}\n\nPara ejecutar: /orchestrate ${params.spec_file} ${params.plan_file}` }],
          details: { task_count: tasks.length },
        };
      } catch (error: any) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], details: {} };
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("orchestrator", "🐙 Ready");
  });

  pi.on("session_shutdown", async () => {
    currentPlan = null;
    taskStates.clear();
  });
}

/**
 * Execute plan by generating task delegation for LLM
 */
async function executePlan(
  pi: ExtensionAPI,
  ctx: any,
  plan: any,
  specContent: string,
  planPath: string
) {
  const tasks = plan.tasks || [];
  const models = plan.models || { light: "haiku", medium: "sonnet", heavy: "opus" };

  // Build execution message
  let executionMsg = `## Plan de Ejecución Multi-Agente\n\n`;
  executionMsg += `Eres el orquestador. Debes ejecutar las siguientes tareas en orden de dependencias.\n\n`;
  executionMsg += `## Configuración\n`;
  executionMsg += `- Modelos: light=${models.light}, medium=${models.medium}, heavy=${models.heavy}\n`;
  executionMsg += `- Concurrencia máxima: ${plan.config?.max_concurrent_workers || 4}\n\n`;

  // Build DAG
  const ready: string[] = [];
  const pending: string[] = [];

  for (const task of tasks) {
    if (!task.dependencies || task.dependencies.length === 0) {
      ready.push(task.id);
    } else {
      pending.push(task.id);
    }
  }

  executionMsg += `## Fase 1: Tareas sin dependencias (ejecutar en paralelo)\n\n`;
  for (const taskId of ready) {
    const task = tasks.find((t: any) => t.id === taskId);
    if (task) {
      const model = task.model || models[task.tier] || models.medium;
      executionMsg += `### ${task.id}: ${task.title}\n`;
      executionMsg += `- Modelo: ${model}\n`;
      executionMsg += `- Instrucción: ${task.prompt}\n\n`;
    }
  }

  if (pending.length > 0) {
    executionMsg += `## Fase 2+: Tareas con dependencias (ejecutar cuando sus dependencias terminen)\n\n`;
    for (const taskId of pending) {
      const task = tasks.find((t: any) => t.id === taskId);
      if (task) {
        const model = task.model || models[task.tier] || models.medium;
        executionMsg += `### ${task.id}: ${task.title}\n`;
        executionMsg += `- Modelo: ${model}\n`;
        executionMsg += `- Depende de: ${task.dependencies.join(", ")}\n`;
        executionMsg += `- Instrucción: ${task.prompt}\n\n`;
      }
    }
  }

  executionMsg += `## Especificación del Proyecto\n\n${specContent.substring(0, 3000)}\n\n`;
  executionMsg += `## Instrucciones\n\n`;
  executionMsg += `1. Ejecuta las tareas de la Fase 1 en paralelo usando subagentes\n`;
  executionMsg += `2. Cuando una tarea termine, verifica si sus dependientes están listas\n`;
  executionMsg += `3. Continúa hasta completar todas las tareas\n`;
  executionMsg += `4. Al final, reporta el estado de cada tarea\n`;

  // Send to LLM for execution
  ctx.ui.notify(`📋 Enviando plan al orquestador...`, "info");

  pi.sendMessage({
    customType: "orchestrator-execution",
    content: executionMsg,
    display: true,
  }, {
    deliverAs: "followUp",
    triggerTurn: true,
  });
}
