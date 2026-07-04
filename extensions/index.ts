import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parse as parseYAML, stringify as stringifyYAML } from "yaml";

/**
 * Pi Orchestrator Extension
 * Multi-agent task orchestration with parallel execution
 */

interface TaskDef {
  id: string;
  title: string;
  tier: "light" | "medium" | "heavy";
  model?: string;
  dependencies: string[];
  prompt: string;
}

interface TaskState extends TaskDef {
  status: "queued" | "running" | "done" | "fail" | "blocked";
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
  status: "idle" | "running" | "completed" | "failed";
}

let currentPlan: PlanState | null = null;

export default function (pi: ExtensionAPI) {
  // Register /orchestrate command
  pi.registerCommand("orchestrate", {
    description: "Orquesta ejecución multi-agente de un plan",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);

      if (parts.length < 2) {
        ctx.ui.notify("Uso: /orchestrate <spec.md> <plan.md> [opciones]", "error");
        ctx.ui.notify("Opciones: --models light=haiku,medium=sonnet --concurrency 4 --dry-run", "info");
        return;
      }

      const specPath = resolve(ctx.cwd, parts[0]);
      const planPath = resolve(ctx.cwd, parts[1]);
      const cliConfig = parseOptions(parts.slice(2));

      // Validate files
      if (!existsSync(specPath)) {
        ctx.ui.notify(`❌ Spec no encontrado: ${parts[0]}`, "error");
        return;
      }
      if (!existsSync(planPath)) {
        ctx.ui.notify(`❌ Plan no encontrado: ${parts[1]}`, "error");
        return;
      }

      // Parse plan.md
      const planContent = readFileSync(planPath, "utf-8");
      const frontmatterMatch = planContent.match(/^---\n([\s\S]*?)\n---/);

      if (!frontmatterMatch) {
        ctx.ui.notify("❌ plan.md no tiene YAML frontmatter válido", "error");
        return;
      }

      let planYaml: any;
      try {
        planYaml = parseYAML(frontmatterMatch[1]);
      } catch (e: any) {
        ctx.ui.notify(`❌ Error parseando YAML: ${e.message}`, "error");
        return;
      }

      if (!planYaml?.tasks || !Array.isArray(planYaml.tasks)) {
        ctx.ui.notify("❌ plan.md no tiene lista de tareas válida", "error");
        return;
      }

      // Merge config: CLI > plan.md > defaults
      const models = {
        light: cliConfig.models.light || planYaml.models?.light || "haiku",
        medium: cliConfig.models.medium || planYaml.models?.medium || "sonnet",
        heavy: cliConfig.models.heavy || planYaml.models?.heavy || "opus",
      };

      const config = {
        maxConcurrentWorkers: cliConfig.concurrency || planYaml.config?.max_concurrent_workers || 4,
        maxRetries: cliConfig.retries || planYaml.config?.max_retries || 3,
        timeoutPerTaskMs: cliConfig.timeout || planYaml.config?.timeout_per_task_ms || 300000,
      };

      const outputDir = resolve(ctx.cwd, cliConfig.outputDir || "./output");
      mkdirSync(outputDir, { recursive: true });

      // Initialize plan
      currentPlan = {
        planId: planYaml.plan_id || `plan-${Date.now()}`,
        specFile: specPath,
        planFile: planPath,
        config,
        models,
        tasks: new Map(),
        outputDir,
        status: "idle",
      };

      // Load tasks
      for (const taskDef of planYaml.tasks) {
        currentPlan.tasks.set(taskDef.id, {
          id: taskDef.id,
          title: taskDef.title,
          tier: taskDef.tier || "medium",
          model: taskDef.model,
          dependencies: taskDef.dependencies || [],
          prompt: taskDef.prompt || taskDef.title,
          status: "queued",
          retryCount: 0,
        });
      }

      const specContent = readFileSync(specPath, "utf-8");

      // Dry run
      if (cliConfig.dryRun) {
        showDryRun(ctx, currentPlan);
        return;
      }

      // Execute
      ctx.ui.notify(`🚀 Orchestrator: ${currentPlan.tasks.size} tareas`, "info");
      ctx.ui.notify(`📊 Modelos: light=${models.light}, medium=${models.medium}, heavy=${models.heavy}`, "info");
      ctx.ui.setStatus("orchestrator", `🐙 ${currentPlan.tasks.size} tasks`);

      currentPlan.status = "running";
      await runOrchestration(pi, ctx, currentPlan, specContent);
    },
  });

  // Register orchestrate tool for LLM
  pi.registerTool({
    name: "orchestrate",
    label: "Orchestrate",
    description: "Ejecuta un plan multi-agente desde un spec.md y plan.md",
    parameters: Type.Object({
      spec_file: Type.String({ description: "Ruta al spec.md" }),
      plan_file: Type.String({ description: "Ruta al plan.md" }),
      models: Type.Optional(Type.String({ description: "light=haiku,medium=sonnet,heavy=opus" })),
      concurrency: Type.Optional(Type.Number({ description: "Workers máximos (default: 4)" })),
      dry_run: Type.Optional(Type.Boolean({ description: "Solo mostrar plan" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
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

      const yaml = parseYAML(match[1]);
      const tasks = yaml?.tasks || [];

      const summary = tasks.map((t: any) =>
        `• ${t.id}: ${t.title} [${t.tier || "medium"}]`
      ).join("\n");

      return {
        content: [{ type: "text", text: `📋 ${tasks.length} tareas encontradas:\n\n${summary}\n\nPara ejecutar: /orchestrate ${params.spec_file} ${params.plan_file}` }],
        details: { task_count: tasks.length },
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("orchestrator", "🐙 Ready");
  });

  pi.on("session_shutdown", async () => {
    currentPlan = null;
  });
}

/**
 * Run orchestration loop
 */
async function runOrchestration(
  pi: ExtensionAPI,
  ctx: any,
  plan: PlanState,
  specContent: string
) {
  while (plan.status === "running") {
    // Find ready tasks
    const ready = getReadyTasks(plan);

    if (ready.length === 0) {
      const allDone = Array.from(plan.tasks.values()).every(
        t => t.status === "done" || t.status === "blocked"
      );

      if (allDone) {
        plan.status = "completed";
        ctx.ui.notify("✅ ¡Plan completado!", "info");
        ctx.ui.setStatus("orchestrator", "✅ Done");
        persistPlan(plan);
        break;
      }

      // Wait and check again
      await sleep(500);
      continue;
    }

    // Execute ready tasks in parallel
    const running = Array.from(plan.tasks.values()).filter(t => t.status === "running").length;
    const slots = plan.config.maxConcurrentWorkers - running;
    const toExecute = ready.slice(0, Math.max(1, slots));

    ctx.ui.notify(`▶ Ejecutando: ${toExecute.map(t => t.id).join(", ")}`, "info");

    // Run tasks in parallel
    const promises = toExecute.map(task =>
      executeTask(pi, ctx, task, plan, specContent).catch(err => {
        console.error(`Task ${task.id} error:`, err);
      })
    );

    await Promise.all(promises);

    // Persist after each batch
    persistPlan(plan);
  }
}

/**
 * Get tasks ready to execute (queued with all deps done)
 */
function getReadyTasks(plan: PlanState): TaskState[] {
  return Array.from(plan.tasks.values()).filter(task => {
    if (task.status !== "queued") return false;
    return task.dependencies.every(depId => {
      const dep = plan.tasks.get(depId);
      return dep?.status === "done";
    });
  });
}

/**
 * Execute a single task
 */
async function executeTask(
  pi: ExtensionAPI,
  ctx: any,
  task: TaskState,
  plan: PlanState,
  specContent: string
) {
  task.status = "running";
  ctx.ui.setStatus("orchestrator", `🐙 ${task.title}`);

  const workerPrompt = buildWorkerPrompt(task, specContent, plan);
  const taskDir = resolve(plan.outputDir, task.id);
  mkdirSync(taskDir, { recursive: true });

  try {
    // Create isolated session for worker
    let workerResult = "";

    await ctx.newSession({
      parentSession: ctx.sessionManager.getSessionFile(),
      setup: async (sm) => {
        sm.appendMessage({
          role: "user",
          content: [{ type: "text", text: workerPrompt }],
          timestamp: Date.now(),
        });
      },
      withSession: async (workerCtx) => {
        // Notify user
        ctx.ui.notify(`🔄 Worker: ${task.title}`, "info");

        // Send task
        await workerCtx.sendUserMessage(workerPrompt);

        // Wait for completion
        await workerCtx.waitForIdle();

        // Get result
        const entries = workerCtx.sessionManager.getEntries();
        const lastAssistant = entries
          .filter((e: any) => e.role === "assistant")
          .pop();

        if (lastAssistant) {
          workerResult = typeof lastAssistant.content === "string"
            ? lastAssistant.content
            : JSON.stringify(lastAssistant.content);

          // Try to parse JSON result
          const jsonMatch = workerResult.match(/\{[\s\S]*"task_id"[\s\S]*\}/);
          if (jsonMatch) {
            try {
              const result = JSON.parse(jsonMatch[0]);
              if (result.status === "done") {
                task.status = "done";
                task.output = result.output?.summary || workerResult;
                ctx.ui.notify(`✅ ${task.id}: Completado`, "info");
              } else {
                task.status = "fail";
                task.error = result.error || "Worker returned fail";
                ctx.ui.notify(`❌ ${task.id}: Falló - ${task.error}`, "error");
              }
            } catch {
              // JSON parse failed, assume success
              task.status = "done";
              task.output = workerResult;
              ctx.ui.notify(`✅ ${task.id}: Completado (output raw)`, "info");
            }
          } else {
            task.status = "done";
            task.output = workerResult;
            ctx.ui.notify(`✅ ${task.id}: Completado`, "info");
          }
        } else {
          task.status = "fail";
          task.error = "No output from worker";
          ctx.ui.notify(`❌ ${task.id}: Sin output`, "error");
        }
      },
    });
  } catch (error: any) {
    task.retryCount++;

    if (task.retryCount < plan.config.maxRetries) {
      task.status = "queued";
      ctx.ui.notify(`⚠️ ${task.id}: Error, retry ${task.retryCount}/${plan.config.maxRetries}`, "error");
    } else {
      task.status = "blocked";
      task.error = error.message || "Max retries exceeded";
      ctx.ui.notify(`🚫 ${task.id}: Bloqueado`, "error");
    }
  }
}

/**
 * Build worker prompt
 */
function buildWorkerPrompt(task: TaskState, specContent: string, plan: PlanState): string {
  const model = task.model || plan.models[task.tier];
  const doneTasks = Array.from(plan.tasks.values())
    .filter(t => t.status === "done" && t.output)
    .map(t => `### ${t.title}\n${t.output}`)
    .join("\n\n");

  return `Eres un worker de Pi Orchestrator. Ejecuta esta tarea de forma aislada.

## Tarea Asignada
- ID: ${task.id}
- Título: ${task.title}
- Modelo: ${model}

## Instrucción
${task.prompt}

## Contexto del Proyecto
${specContent.substring(0, 3000)}

${doneTasks ? `\n## Tareas Completadas Anteriormente\n${doneTasks}` : ""}

## Reglas
1. Ejecuta SOLO esta tarea
2. Usa las herramientas bash, read, write, edit
3. Al terminar, responde EXACTAMENTE con este JSON:
\`\`\`json
{"task_id": "${task.id}", "status": "done", "output": {"summary": "resumen", "files_created": []}}
\`\`\`

Si hay error:
\`\`\`json
{"task_id": "${task.id}", "status": "fail", "error": "descripción"}
\`\`\``;
}

/**
 * Show dry run
 */
function showDryRun(ctx: any, plan: PlanState) {
  const tasks = Array.from(plan.tasks.values());
  const ready = getReadyTasks(plan);

  let msg = `\n📋 Plan: ${plan.planId}\n`;
  msg += `📊 Total: ${tasks.length} tareas\n`;
  msg += `⚡ Concurrencia: ${plan.config.maxConcurrentWorkers}\n\n`;

  msg += `Tareas:\n`;
  for (const task of tasks) {
    const model = task.model || plan.models[task.tier];
    const deps = task.dependencies.length > 0 ? ` ← [${task.dependencies.join(", ")}]` : "";
    msg += `  • ${task.id}: ${task.title} (${task.tier} → ${model})${deps}\n`;
  }

  msg += `\n🚀 Listas ahora: ${ready.map(t => t.id).join(", ") || "ninguna"}\n`;

  ctx.ui.notify(msg, "info");
}

/**
 * Persist plan state
 */
function persistPlan(plan: PlanState) {
  try {
    const content = readFileSync(plan.planFile, "utf-8");
    const match = content.match(/^(---\n[\s\S]*?\n---)/);
    if (!match) return;

    let yaml = parseYAML(match[1]);

    // Update task statuses
    if (yaml?.tasks) {
      for (const task of yaml.tasks) {
        const state = plan.tasks.get(task.id);
        if (state) {
          task.status = state.status;
        }
      }
    }

    const newYaml = stringifyYAML(yaml);
    const newContent = `---\n${newYaml}---` + content.slice(match[0].length);
    writeFileSync(plan.planFile, newContent, "utf-8");
  } catch (e) {
    console.error("Persist error:", e);
  }
}

/**
 * Parse CLI options
 */
function parseOptions(args: string[]) {
  const config = {
    concurrency: 0,
    timeout: 0,
    retries: 0,
    models: {} as Record<string, string>,
    dryRun: false,
    outputDir: "",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "--concurrency" || arg === "-c") && args[i + 1]) {
      config.concurrency = parseInt(args[++i], 10) || 4;
    } else if ((arg === "--timeout" || arg === "-t") && args[i + 1]) {
      config.timeout = parseInt(args[++i], 10) || 300000;
    } else if ((arg === "--retries" || arg === "-r") && args[i + 1]) {
      config.retries = parseInt(args[++i], 10) || 3;
    } else if ((arg === "--models" || arg === "-m") && args[i + 1]) {
      for (const pair of args[++i].split(",")) {
        const [tier, model] = pair.split("=");
        if (tier && model) config.models[tier.trim()] = model.trim();
      }
    } else if (arg === "--dry-run" || arg === "-d") {
      config.dryRun = true;
    } else if ((arg === "--output" || arg === "-o") && args[i + 1]) {
      config.outputDir = args[++i];
    }
  }

  return config;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
