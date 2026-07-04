import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

/**
 * Pi Orchestrator Extension
 * Multi-agent task orchestration with parallel execution
 */

// In-memory state
interface TaskState {
  id: string;
  title: string;
  tier: "light" | "medium" | "heavy";
  model?: string;
  status: "queued" | "running" | "done" | "fail" | "blocked";
  dependencies: string[];
  prompt: string;
  retryCount: number;
  output?: string;
  error?: string;
}

interface PlanState {
  planId: string;
  specFile: string;
  planFile: string;
  config: {
    maxConcurrentWorkers: number;
    maxRetries: number;
    timeoutPerTaskMs: number;
  };
  models: {
    light: string;
    medium: string;
    heavy: string;
  };
  tasks: Map<string, TaskState>;
  outputDir: string;
}

let currentPlan: PlanState | null = null;

export default function (pi: ExtensionAPI) {
  // Register the /orchestrate command
  pi.registerCommand("orchestrate", {
    description: "Orquesta ejecución multi-agente de un plan",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);

      if (parts.length < 2 || parts[0].startsWith("-")) {
        ctx.ui.notify("Uso: /orchestrate <spec.md> <plan.md> [opciones]", "error");
        ctx.ui.notify("Ejemplo: /orchestrate spec.md plan.md --models light=haiku,medium=sonnet", "info");
        return;
      }

      const specFile = resolve(ctx.cwd, parts[0]);
      const planFile = resolve(ctx.cwd, parts[1]);
      const options = parts.slice(2);

      // Validate files exist
      if (!existsSync(specFile)) {
        ctx.ui.notify(`Error: ${parts[0]} no encontrado`, "error");
        return;
      }
      if (!existsSync(planFile)) {
        ctx.ui.notify(`Error: ${parts[1]} no encontrado`, "error");
        return;
      }

      // Parse options
      const cliConfig = parseOptions(options);

      // Parse plan.md
      const planContent = readFileSync(planFile, "utf-8");
      const parsed = parsePlanYaml(planContent);

      if (!parsed) {
        ctx.ui.notify("Error: YAML frontmatter inválido en plan.md", "error");
        return;
      }

      // Merge config: CLI > plan.md > defaults
      const models = {
        light: cliConfig.models.light || parsed.models?.light || "haiku",
        medium: cliConfig.models.medium || parsed.models?.medium || "sonnet",
        heavy: cliConfig.models.heavy || parsed.models?.heavy || "opus",
      };

      const config = {
        maxConcurrentWorkers: cliConfig.concurrency || parsed.config?.max_concurrent_workers || 4,
        maxRetries: cliConfig.retries || parsed.config?.max_retries || 3,
        timeoutPerTaskMs: cliConfig.timeout || parsed.config?.timeout_per_task_ms || 300000,
      };

      // Initialize plan state
      currentPlan = {
        planId: parsed.plan_id || `plan-${Date.now()}`,
        specFile,
        planFile,
        config,
        models,
        tasks: new Map(),
        outputDir: resolve(ctx.cwd, cliConfig.outputDir || "./output"),
      };

      // Load spec content for context
      const specContent = readFileSync(specFile, "utf-8");

      // Initialize tasks
      for (const taskDef of parsed.tasks || []) {
        const task: TaskState = {
          id: taskDef.id,
          title: taskDef.title,
          tier: taskDef.tier || "medium",
          model: taskDef.model,
          status: "queued",
          dependencies: taskDef.dependencies || [],
          prompt: taskDef.prompt || taskDef.title,
          retryCount: 0,
        };
        currentPlan.tasks.set(task.id, task);
      }

      // Dry run mode
      if (cliConfig.dryRun) {
        showDryRun(ctx, currentPlan, specContent);
        return;
      }

      // Start orchestration
      ctx.ui.notify(`🚀 Orchestrator: Iniciando ${currentPlan.tasks.size} tareas`, "info");
      ctx.ui.notify(`📊 Models: light=${models.light}, medium=${models.medium}, heavy=${models.heavy}`, "info");
      ctx.ui.setStatus("orchestrator", `🐙 Orchestrating: ${currentPlan.tasks.size} tasks`);

      // Start executing ready tasks
      await executeReadyTasks(pi, ctx, currentPlan, specContent);
    },
  });

  // Register the orchestrate tool for LLM
  pi.registerTool({
    name: "orchestrate",
    label: "Orchestrate",
    description: "Ejecuta un plan de implementación usando múltiples subagentes en paralelo",
    parameters: Type.Object({
      spec_file: Type.String({ description: "Ruta al archivo spec.md" }),
      plan_file: Type.String({ description: "Ruta al archivo plan.md" }),
      models: Type.Optional(Type.String({
        description: "Configuración de modelos: light=haiku,medium=sonnet,heavy=opus"
      })),
      concurrency: Type.Optional(Type.Number({
        description: "Máximo de workers concurrentes (default: 4)"
      })),
      dry_run: Type.Optional(Type.Boolean({
        description: "Solo parsear, no ejecutar"
      })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: `Iniciando orquestación: ${params.spec_file} → ${params.plan_file}` }] });

      const specFile = resolve(ctx.cwd, params.spec_file);
      const planFile = resolve(ctx.cwd, params.plan_file);

      if (!existsSync(specFile) || !existsSync(planFile)) {
        return {
          content: [{ type: "text", text: "Error: Archivos no encontrados" }],
          details: { error: "Files not found" },
        };
      }

      const planContent = readFileSync(planFile, "utf-8");
      const parsed = parsePlanYaml(planContent);

      if (!parsed) {
        return {
          content: [{ type: "text", text: "Error: YAML inválido en plan.md" }],
          details: { error: "Invalid YAML" },
        };
      }

      const taskCount = (parsed.tasks || []).length;
      const taskList = (parsed.tasks || []).map((t: any) =>
        `• ${t.id}: ${t.title} (${t.tier || "medium"})`
      ).join("\n");

      return {
        content: [{
          type: "text",
          text: `Plan parseado: ${taskCount} tareas encontradas\n\n${taskList}\n\nUse /orchestrate ${params.spec_file} ${params.plan_file} para ejecutar.`
        }],
        details: {
          plan_id: parsed.plan_id,
          task_count: taskCount,
          tasks: parsed.tasks,
        },
      };
    },
  });

  // Session lifecycle
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("orchestrator", "🐙 Orchestrator ready");
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    currentPlan = null;
  });
}

/**
 * Parse CLI-style options into config object
 */
function parseOptions(args: string[]) {
  const config = {
    concurrency: 0,
    timeout: 0,
    retries: 0,
    models: {} as Record<string, string>,
    dryRun: false,
    resume: false,
    outputDir: "",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--concurrency" || arg === "-c") {
      config.concurrency = parseInt(args[++i], 10) || 4;
    } else if (arg === "--timeout" || arg === "-t") {
      config.timeout = parseInt(args[++i], 10) || 300000;
    } else if (arg === "--retries" || arg === "-r") {
      config.retries = parseInt(args[++i], 10) || 3;
    } else if (arg === "--models" || arg === "-m") {
      const modelStr = args[++i] || "";
      for (const pair of modelStr.split(",")) {
        const [tier, model] = pair.split("=");
        if (tier && model) {
          config.models[tier.trim()] = model.trim();
        }
      }
    } else if (arg === "--dry-run" || arg === "-d") {
      config.dryRun = true;
    } else if (arg === "--resume") {
      config.resume = true;
    } else if (arg === "--output" || arg === "-o") {
      config.outputDir = args[++i] || "";
    }
  }

  return config;
}

/**
 * Parse YAML frontmatter from plan.md
 */
function parsePlanYaml(content: string): any {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  try {
    // Simple YAML parser for frontmatter
    const yamlStr = match[1];
    const result: any = {};
    let currentSection: any = result;
    let currentKey = "";

    const lines = yamlStr.split("\n");
    for (const line of lines) {
      const indent = line.search(/\S/);
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) continue;

      const kvMatch = trimmed.match(/^(\w[\w_]*):\s*(.*)/);
      if (kvMatch) {
        const [, key, value] = kvMatch;

        if (value === "" || value === undefined) {
          // This is a section header
          currentSection[key] = {};
          currentSection = currentSection[key];
          currentKey = key;
        } else {
          // Parse value
          let parsedValue: any = value;

          // Remove quotes
          if ((value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))) {
            parsedValue = value.slice(1, -1);
          } else if (value === "true") {
            parsedValue = true;
          } else if (value === "false") {
            parsedValue = false;
          } else if (!isNaN(Number(value))) {
            parsedValue = Number(value);
          }

          currentSection[key] = parsedValue;
        }
      } else if (trimmed.startsWith("- ") && currentKey) {
        // Array item
        const item = trimmed.slice(2).trim();
        if (!Array.isArray(currentSection)) {
          // Find parent and convert to array
          const parentKey = Object.keys(result).find(k => result[k] === currentSection);
          if (parentKey) {
            result[parentKey] = [];
            currentSection = result[parentKey];
          }
        }
        if (Array.isArray(currentSection)) {
          // Parse object item
          const itemObj: any = {};
          const itemKv = item.match(/^(\w[\w]*):\s*(.*)/);
          if (itemKv) {
            let val: any = itemKv[2];
            if ((val.startsWith('"') && val.endsWith('"')) ||
                (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            } else if (val === "true") val = true;
            else if (val === "false") val = false;
            else if (!isNaN(Number(val))) val = Number(val);
            itemObj[itemKv[1]] = val;
          }
          currentSection.push(itemObj);
        }
      }
    }

    return result;
  } catch (e) {
    console.error("YAML parse error:", e);
    return null;
  }
}

/**
 * Show dry run output
 */
function showDryRun(ctx: any, plan: PlanState, specContent: string) {
  const tasks = Array.from(plan.tasks.values());
  const ready = tasks.filter(t => t.status === "queued" && t.dependencies.length === 0);

  let output = `\n📋 Plan: ${plan.planId}\n`;
  output += `📊 Total tareas: ${tasks.length}\n`;
  output += `⚡ Workers concurrentes: ${plan.config.maxConcurrentWorkers}\n\n`;

  output += `Tareas:\n`;
  for (const task of tasks) {
    const model = task.model || plan.models[task.tier];
    const deps = task.dependencies.length > 0 ? ` (deps: ${task.dependencies.join(", ")})` : "";
    output += `  • ${task.id}: ${task.title} [${task.tier} → ${model}]${deps}\n`;
  }

  output += `\n🚀 Tareas listas para ejecutar: ${ready.length}\n`;
  for (const task of ready) {
    output += `  → ${task.id}: ${task.title}\n`;
  }

  ctx.ui.notify(output, "info");
}

/**
 * Execute tasks that are ready (no pending dependencies)
 */
async function executeReadyTasks(
  pi: ExtensionAPI,
  ctx: any,
  plan: PlanState,
  specContent: string
) {
  const tasks = Array.from(plan.tasks.values());

  // Find ready tasks
  const ready = tasks.filter(t => {
    if (t.status !== "queued") return false;
    return t.dependencies.every(dep => {
      const depTask = plan.tasks.get(dep);
      return depTask?.status === "done";
    });
  });

  if (ready.length === 0) {
    // Check if all done or blocked
    const allDone = tasks.every(t => t.status === "done" || t.status === "blocked");
    if (allDone) {
      ctx.ui.notify("✅ Plan completado!", "info");
      ctx.ui.setStatus("orchestrator", "✅ Plan completed");
      return;
    }

    // Check for blocked tasks
    const blocked = tasks.filter(t => t.status === "blocked");
    if (blocked.length > 0) {
      ctx.ui.notify(`🚫 ${blocked.length} tareas bloqueadas`, "error");
    }
    return;
  }

  // Limit concurrency
  const running = tasks.filter(t => t.status === "running").length;
  const toExecute = ready.slice(0, plan.config.maxConcurrentWorkers - running);

  ctx.ui.notify(`🚀 Ejecutando ${toExecute.length} tareas...`, "info");

  // Execute each task as a subagent session
  for (const task of toExecute) {
    const model = task.model || plan.models[task.tier];
    task.status = "running";
    ctx.ui.setStatus("orchestrator", `🐙 Running: ${task.title}`);

    // Create isolated session for worker
    try {
      const workerPrompt = buildWorkerPrompt(task, specContent, plan);

      // Use newSession to create isolated worker
      await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        setup: async (sm) => {
          // Add system context
          sm.appendMessage({
            role: "user",
            content: [{ type: "text", text: workerPrompt }],
            timestamp: Date.now(),
          });
        },
        withSession: async (workerCtx) => {
          // Send the task to the worker
          await workerCtx.sendUserMessage(workerPrompt);

          // Wait for completion
          await workerCtx.waitForIdle();

          // Get the result
          const entries = workerCtx.sessionManager.getEntries();
          const lastAssistant = entries
            .filter((e: any) => e.role === "assistant")
            .pop();

          if (lastAssistant) {
            task.output = typeof lastAssistant.content === "string"
              ? lastAssistant.content
              : JSON.stringify(lastAssistant.content);
            task.status = "done";
            ctx.ui.notify(`✅ ${task.id}: ${task.title} completado`, "info");
          } else {
            task.status = "fail";
            task.error = "No output from worker";
            ctx.ui.notify(`❌ ${task.id}: ${task.title} falló`, "error");
          }
        },
      });
    } catch (error: any) {
      task.retryCount++;

      if (task.retryCount < plan.config.maxRetries) {
        ctx.ui.notify(`⚠️ ${task.id}: Error, reintentando (${task.retryCount}/${plan.config.maxRetries})`, "error");
        task.status = "queued"; // Will retry
      } else {
        task.status = "blocked";
        task.error = error.message || "Unknown error";
        ctx.ui.notify(`🚫 ${task.id}: ${task.title} bloqueado (max reintentos)`, "error");
      }
    }
  }

  // Persist state
  persistPlanState(plan);

  // Continue with next batch
  setTimeout(() => {
    executeReadyTasks(pi, ctx, plan, specContent);
  }, 1000);
}

/**
 * Build the worker prompt for a specific task
 */
function buildWorkerPrompt(task: TaskState, specContent: string, plan: PlanState): string {
  return `Eres un worker de Pi Orchestrator. Tu tarea es ejecutar una tarea específica de forma aislada.

## Tu Tarea
- ID: ${task.id}
- Título: ${task.title}
- Tier: ${task.tier}
- Modelo asignado: ${task.model || plan.models[task.tier]}

## Instrucción
${task.prompt}

## Contexto del Proyecto (spec.md)
${specContent.substring(0, 2000)}

## Reglas EstRICTAS
1. Ejecuta SOLO la tarea asignada
2. NO modifiques archivos fuera de tu directorio de trabajo
3. Genera el output especificado
4. Al terminar, responde con el resultado en formato JSON:
   {
     "task_id": "${task.id}",
     "status": "done",
     "output": {
       "files_created": ["lista de archivos creados"],
       "summary": "resumen de lo hecho",
       "tokens_used": 0
     }
   }

Si hay un error, responde:
   {
     "task_id": "${task.id}",
     "status": "fail",
     "error": "descripción del error"
   }`;
}

/**
 * Persist plan state back to plan.md
 */
function persistPlanState(plan: PlanState) {
  try {
    const content = readFileSync(plan.planFile, "utf-8");
    const match = content.match(/^(---\n[\s\S]*?\n---)/);

    if (!match) return;

    // Update task statuses in YAML
    let updatedYaml = match[1];
    for (const task of plan.tasks.values()) {
      const statusRegex = new RegExp(`(id:\\s*["']?${task.id}["']?[\\s\\S]*?status:\\s*["']?)[^"'\n]+(["']?)`, "g");
      updatedYaml = updatedYaml.replace(statusRegex, `$1${task.status}$2`);
    }

    // Write back
    const newContent = content.replace(match[1], updatedYaml);
    writeFileSync(plan.planFile, newContent, "utf-8");
  } catch (error) {
    console.error("Failed to persist plan state:", error);
  }
}
