import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Component } from "@earendil-works/pi-tui";

/**
 * Pi Orchestrator Extension - TUI Dashboard
 */

// Simple YAML parser
function parseSimpleYaml(content: string): any {
  const result: any = {};
  const lines = content.split("\n");
  let inTasks = false;
  let currentTask: any = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const topMatch = trimmed.match(/^(\w[\w_]*):\s*$/);
    if (topMatch) {
      if (topMatch[1] === "tasks") {
        inTasks = true;
        result.tasks = [];
      } else {
        inTasks = false;
        result[topMatch[1]] = {};
      }
      continue;
    }

    const kvMatch = trimmed.match(/^(\w[\w_]*):\s*(.+)/);
    if (kvMatch) {
      const [, key, value] = kvMatch;
      let val: any = value.trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      } else if (val === "true") val = true;
      else if (val === "false") val = false;
      else if (!isNaN(Number(val))) val = Number(val);

      if (inTasks) {
        if (!currentTask) currentTask = {};
        if (key === "dependencies" && val.startsWith("[")) {
          currentTask[key] = val.slice(1, -1).split(",").map((s: string) => s.trim().replace(/['"]/g, ""));
        } else {
          currentTask[key] = val;
        }
      } else if (result[Object.keys(result).pop() || ""]) {
        result[Object.keys(result).pop()!][key] = val;
      } else {
        result[key] = val;
      }
    }

    if (trimmed.startsWith("- ") && inTasks) {
      if (currentTask?.id) result.tasks.push(currentTask);
      currentTask = {};
      const itemMatch = trimmed.slice(2).trim().match(/^(\w[\w_]*):\s*(.+)/);
      if (itemMatch) {
        let val: any = itemMatch[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        currentTask[itemMatch[1]] = val;
      }
    }
  }
  if (currentTask?.id) result.tasks.push(currentTask);
  return result;
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

// Orchestrator Dashboard Component
class OrchestratorDashboard implements Component {
  private tasks: TaskState[] = [];
  private planId: string = "";
  private models: any = {};
  private cursor: number = 0;
  private startTime: number = Date.now();
  private doneCallback: ((action: string) => void) | null = null;
  private statusMessage: string = "";
  private private_keybindings: any;

  constructor(private theme: any) {}

  setDoneCallback(cb: (action: string) => void) {
    this.doneCallback = cb;
  }

  setKeybindings(kb: any) {
    this.private_keybindings = kb;
  }

  updateState(plan: any, taskStates: Map<string, TaskState>) {
    this.planId = plan.plan_id || "unknown";
    this.models = plan.models || {};
    this.tasks = Array.from(taskStates.values());
  }

  setStatus(msg: string) {
    this.statusMessage = msg;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const mins = Math.floor(elapsed / 60).toString().padStart(2, "0");
    const secs = (elapsed % 60).toString().padStart(2, "0");

    const done = this.tasks.filter(t => t.status === "done").length;
    const running = this.tasks.filter(t => t.status === "running").length;
    const queued = this.tasks.filter(t => t.status === "queued").length;
    const blocked = this.tasks.filter(t => t.status === "blocked").length;

    // Header
    lines.push(this.theme.fg("accent", "🐙 PI ORCHESTRATOR"));
    lines.push("");

    // Plan info
    lines.push(`  Plan: ${this.theme.fg("muted", this.planId)}`);
    lines.push(`  Status: ${this.getStatusIcon()} ${this.getStatusText()}`);
    lines.push(`  Tasks: ${this.theme.fg("accent", `${done}/${this.tasks.length}`)} done | Elapsed: ${mins}:${secs}`);
    lines.push("");

    // Models
    lines.push(`  Models: light=${this.theme.fg("dim", this.models.light || "haiku")} | medium=${this.theme.fg("muted", this.models.medium || "sonnet")} | heavy=${this.theme.fg("bright", this.models.heavy || "opus")}`);
    lines.push("");

    // Tasks
    for (let i = 0; i < this.tasks.length; i++) {
      const task = this.tasks[i];
      const isSelected = i === this.cursor;
      const prefix = isSelected ? this.theme.fg("accent", "▶ ") : "  ";
      const icon = this.getTaskIcon(task.status);
      const model = task.model || this.models[task.tier] || "medium";

      let line = `${prefix}${icon} ${task.id}: ${task.title}`;
      line += ` ${this.theme.fg("dim", `[${task.tier}→${model}]`)}`;

      if (task.status === "done") {
        line += ` ${this.theme.fg("green", "✓")}`;
      } else if (task.status === "fail") {
        line += ` ${this.theme.fg("red", "✗")}`;
      } else if (task.status === "running") {
        line += ` ${this.theme.fg("yellow", "●")}`;
      }

      lines.push(line);
    }

    lines.push("");

    // Stats bar
    const stats = [
      this.theme.fg("dim", `Done: ${done}`),
      this.theme.fg("yellow", `Running: ${running}`),
      this.theme.fg("muted", `Queued: ${queued}`),
    ];
    if (blocked > 0) {
      stats.push(this.theme.fg("red", `Blocked: ${blocked}`));
    }
    lines.push(`  ${stats.join(" | ")}`);

    // Status message
    if (this.statusMessage) {
      lines.push("");
      lines.push(`  ${this.theme.fg("accent", this.statusMessage)}`);
    }

    // Footer with controls
    lines.push("");
    lines.push(this.theme.fg("dim", "  [↑↓] Navigate  [c] Cancel  [p] Pause  [r] Resume  [Enter] Execute  [Esc] Close"));

    return lines;
  }

  handleInput(data: string): void {
    if (data === "up" || data === "k") {
      this.cursor = Math.max(0, this.cursor - 1);
    } else if (data === "down" || data === "j") {
      this.cursor = Math.min(this.tasks.length - 1, this.cursor + 1);
    } else if (data === "return") {
      // Execute selected task or all ready
      this.doneCallback?.("execute");
    } else if (data === "c") {
      // Cancel selected task
      const task = this.tasks[this.cursor];
      if (task) {
        this.doneCallback?.(`cancel:${task.id}`);
      }
    } else if (data === "p") {
      // Pause
      this.doneCallback?.(`pause:${this.tasks[this.cursor]?.id}`);
    } else if (data === "r") {
      // Resume
      this.doneCallback?.(`resume:${this.tasks[this.cursor]?.id}`);
    } else if (data === "escape") {
      this.doneCallback?.("close");
    }
  }

  private getStatusIcon(): string {
    const running = this.tasks.some(t => t.status === "running");
    const allDone = this.tasks.every(t => t.status === "done" || t.status === "blocked");

    if (allDone) return this.theme.fg("green", "✓");
    if (running) return this.theme.fg("yellow", "▶");
    return this.theme.fg("dim", "○");
  }

  private getStatusText(): string {
    const allDone = this.tasks.every(t => t.status === "done" || t.status === "blocked");
    const running = this.tasks.some(t => t.status === "running");
    const blocked = this.tasks.some(t => t.status === "blocked");

    if (allDone) return this.theme.fg("green", "Completed");
    if (blocked) return this.theme.fg("red", "Blocked");
    if (running) return this.theme.fg("yellow", "In Progress");
    return this.theme.fg("muted", "Ready");
  }

  private getTaskIcon(status: string): string {
    switch (status) {
      case "done": return this.theme.fg("green", "✅");
      case "running": return this.theme.fg("yellow", "🔄");
      case "fail": return this.theme.fg("red", "❌");
      case "blocked": return this.theme.fg("red", "🚫");
      default: return this.theme.fg("dim", "⏳");
    }
  }
}

// Global state
let currentPlan: any = null;
let taskStates: Map<string, TaskState> = new Map();
let dashboard: OrchestratorDashboard | null = null;

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

        // Dry run - simple list
        if (dryRun) {
          let msg = `\n📋 Plan: ${planYaml.plan_id || "sin-id"}\n`;
          msg += `📊 Total: ${planYaml.tasks.length} tareas\n\n`;

          for (const task of planYaml.tasks) {
            const deps = task.dependencies?.length > 0 ? ` ← [${task.dependencies.join(", ")}]` : "";
            msg += `  • ${task.id}: ${task.title} (${task.tier || "medium"})${deps}\n`;
          }

          const ready = Array.from(taskStates.values()).filter(t =>
            t.status === "queued" && (!t.dependencies || t.dependencies.length === 0)
          );
          msg += `\n🚀 Listas ahora: ${ready.map(t => t.id).join(", ") || "ninguna"}\n`;

          ctx.ui.notify(msg, "info");
          return;
        }

        // Show TUI Dashboard
        await showDashboard(pi, ctx, planYaml, planPath);

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
    dashboard = null;
  });
}

/**
 * Show TUI Dashboard
 */
async function showDashboard(
  pi: ExtensionAPI,
  ctx: any,
  plan: any,
  planPath: string
) {
  const specPath = resolve(ctx.cwd, "spec.md");

  // Create dashboard
  dashboard = new OrchestratorDashboard(ctx.ui.theme);
  dashboard.updateState(plan, taskStates);

  // Show custom UI
  const result = await ctx.ui.custom<boolean>((tui, theme, keybindings, done) => {
    dashboard!.setDoneCallback((action) => {
      if (action === "close") {
        done(false);
      } else if (action === "execute") {
        done(true);
      } else if (action.startsWith("cancel:")) {
        const taskId = action.split(":")[1];
        const task = taskStates.get(taskId);
        if (task) {
          task.status = "queued";
          task.retryCount = 0;
          dashboard!.updateState(plan, taskStates);
          dashboard!.setStatus(`Task ${taskId} cancelled`);
        }
      } else if (action.startsWith("pause:")) {
        const taskId = action.split(":")[1];
        const task = taskStates.get(taskId);
        if (task && task.status === "running") {
          task.status = "queued";
          dashboard!.updateState(plan, taskStates);
          dashboard!.setStatus(`Task ${taskId} paused`);
        }
      }
    });

    dashboard!.setKeybindings(keybindings);

    return dashboard!;
  });

  if (result) {
    // User pressed Enter - execute plan
    ctx.ui.notify(`🚀 Ejecutando plan...`, "info");
    await executePlan(pi, ctx, plan, planPath, specPath);
  }
}

/**
 * Execute plan
 */
async function executePlan(
  pi: ExtensionAPI,
  ctx: any,
  plan: any,
  planPath: string,
  specPath: string
) {
  const models = plan.models || { light: "haiku", medium: "sonnet", heavy: "opus" };
  const specContent = existsSync(specPath) ? readFileSync(specPath, "utf-8") : "";

  // Build execution message for LLM
  let msg = `## Orquestador Multi-Agente\n\n`;
  msg += `Ejecuta las siguientes tareas en orden de dependencias.\n\n`;
  msg += `## Configuración\n`;
  msg += `- Modelos: light=${models.light}, medium=${models.medium}, heavy=${models.heavy}\n\n`;

  // Ready tasks
  const ready = Array.from(taskStates.values()).filter(t =>
    t.status === "queued" && (!t.dependencies || t.dependencies.length === 0)
  );

  msg += `## Tareas para ejecutar AHORA (sin dependencias)\n\n`;
  for (const task of ready) {
    const model = task.model || models[task.tier] || models.medium;
    msg += `### ${task.id}: ${task.title}\n`;
    msg += `- Modelo sugerido: ${model}\n`;
    msg += `- Instrucción: ${task.prompt}\n\n`;
  }

  // Pending tasks
  const pending = Array.from(taskStates.values()).filter(t =>
    t.status === "queued" && t.dependencies && t.dependencies.length > 0
  );

  if (pending.length > 0) {
    msg += `## Tareas pendientes (ejecutar cuando sus dependencias terminen)\n\n`;
    for (const task of pending) {
      const model = task.model || models[task.tier] || models.medium;
      msg += `### ${task.id}: ${task.title}\n`;
      msg += `- Modelo: ${model}\n`;
      msg += `- Depende de: ${task.dependencies.join(", ")}\n`;
      msg += `- Instrucción: ${task.prompt}\n\n`;
    }
  }

  if (specContent) {
    msg += `## Especificación del Proyecto\n\n${specContent.substring(0, 2000)}\n\n`;
  }

  msg += `## Importante\n`;
  msg += `- Al terminar cada tarea, reporta el resultado\n`;
  msg += `- Marca tareas como done cuando terminen\n`;
  msg += `- Si falla, reporta el error\n`;

  // Send to LLM
  pi.sendMessage({
    customType: "orchestrator-execution",
    content: msg,
    display: true,
  }, {
    deliverAs: "followUp",
    triggerTurn: true,
  });
}
