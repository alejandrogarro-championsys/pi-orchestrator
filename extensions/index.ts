import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Component } from "@earendil-works/pi-tui";

/**
 * Pi Orchestrator Extension - Full Implementation
 */

// ─── YAML Parser ───────────────────────────────────────────────
function parseFrontmatter(content: string): any {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  const result: any = {};
  let currentSection: any = null;
  let currentKey = "";
  let tasks: any[] = [];
  let currentTask: any = null;
  let inTasks = false;

  for (const rawLine of yaml.split("\n")) {
    const line = rawLine.replace(/\t/g, "  ");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;

    // Top-level key: section header (no value)
    const sectionMatch = trimmed.match(/^(\w[\w_]*):\s*$/);
    if (sectionMatch && indent === 0) {
      const key = sectionMatch[1];
      if (key === "tasks") {
        inTasks = true;
        currentTask = null;
      } else {
        inTasks = false;
        currentKey = key;
        result[key] = {};
        currentSection = result[key];
      }
      continue;
    }

    // Top-level key: with value
    const kvMatch = trimmed.match(/^(\w[\w_]*):\s*(.+)/);
    if (kvMatch && indent === 0 && !inTasks) {
      const [, key, rawValue] = kvMatch;
      result[key] = parseYamlValue(rawValue);
      currentSection = null;
      continue;
    }

    // Inside a section (indent > 0, not in tasks)
    if (kvMatch && indent > 0 && !inTasks && currentSection) {
      const [, key, rawValue] = kvMatch;
      currentSection[key] = parseYamlValue(rawValue);
      continue;
    }

    // Array item in tasks
    if (trimmed.startsWith("- ") && inTasks) {
      // Save previous task
      if (currentTask && currentTask.id) {
        tasks.push(currentTask);
      }
      currentTask = {};

      const itemStr = trimmed.slice(2);
      const itemMatch = itemStr.match(/^(\w[\w_]*):\s*(.*)/);
      if (itemMatch) {
        const [, key, val] = itemMatch;
        if (val === "" || val === undefined) {
          currentTask[key] = {};
        } else {
          currentTask[key] = parseYamlValue(val);
        }
      }
      continue;
    }

    // Property of current task (indented under - )
    if (kvMatch && inTasks && currentTask) {
      const [, key, rawValue] = kvMatch;
      if (key === "dependencies") {
        currentTask[key] = parseYamlArray(rawValue);
      } else {
        currentTask[key] = parseYamlValue(rawValue);
      }
      continue;
    }
  }

  // Push last task
  if (currentTask && currentTask.id) {
    tasks.push(currentTask);
  }

  if (tasks.length > 0) {
    result.tasks = tasks;
  }

  return result;
}

function parseYamlValue(raw: string): any {
  const val = raw.trim();
  // Remove quotes
  if ((val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  if (val === "true") return true;
  if (val === "false") return false;
  if (val === "null" || val === "~") return null;
  if (!isNaN(Number(val)) && val !== "") return Number(val);
  return val;
}

function parseYamlArray(raw: string): any[] {
  const val = raw.trim();
  if (val.startsWith("[")) {
    return val.slice(1, -1).split(",").map(s => parseYamlValue(s));
  }
  return [parseYamlValue(val)];
}

// ─── Types ─────────────────────────────────────────────────────
interface TaskState {
  id: string;
  title: string;
  tier: "light" | "medium" | "heavy";
  model?: string;
  dependencies: string[];
  prompt: string;
  status: "queued" | "running" | "done" | "fail" | "blocked" | "cancelled";
  retryCount: number;
  output?: string;
  error?: string;
}

interface PlanState {
  planId: string;
  specFile: string;
  planFile: string;
  models: { light: string; medium: string; heavy: string };
  config: { maxConcurrentWorkers: number; maxRetries: number; timeoutPerTaskMs: number };
  tasks: Map<string, TaskState>;
  status: "idle" | "running" | "completed" | "failed";
  startTime: number;
}

// ─── Global State ──────────────────────────────────────────────
let plan: PlanState | null = null;

// ─── TUI Dashboard Component ───────────────────────────────────
class OrchestratorTUI implements Component {
  private cursor = 0;
  private doneCb: ((action: string) => void) | null = null;

  constructor(private theme: any) {}

  setDoneCallback(cb: (action: string) => void) { this.doneCb = cb; }

  getState(): PlanState | null { return plan; }

  render(width: number): string[] {
    if (!plan) return [this.theme.fg("red", "No plan loaded")];

    const lines: string[] = [];
    const elapsed = Math.floor((Date.now() - plan.startTime) / 1000);
    const mins = Math.floor(elapsed / 60).toString().padStart(2, "0");
    const secs = (elapsed % 60).toString().padStart(2, "0");

    const tasks = Array.from(plan.tasks.values());
    const done = tasks.filter(t => t.status === "done").length;
    const running = tasks.filter(t => t.status === "running").length;
    const queued = tasks.filter(t => t.status === "queued").length;
    const blocked = tasks.filter(t => t.status === "blocked").length;
    const failed = tasks.filter(t => t.status === "fail").length;

    // Header
    lines.push(this.theme.fg("accent", "🐙 PI ORCHESTRATOR"));
    lines.push("");

    // Plan info
    lines.push(`  Plan: ${this.theme.fg("muted", plan.planId)}`);

    let statusText: string;
    let statusIcon: string;
    if (plan.status === "completed") {
      statusIcon = this.theme.fg("green", "✅");
      statusText = this.theme.fg("green", "Completed");
    } else if (plan.status === "failed") {
      statusIcon = this.theme.fg("red", "❌");
      statusText = this.theme.fg("red", "Failed");
    } else if (running > 0) {
      statusIcon = this.theme.fg("yellow", "▶");
      statusText = this.theme.fg("yellow", "In Progress");
    } else {
      statusIcon = this.theme.fg("dim", "○");
      statusText = this.theme.fg("muted", "Ready");
    }
    lines.push(`  Status: ${statusIcon} ${statusText}`);
    lines.push(`  Tasks: ${this.theme.fg("accent", `${done}/${tasks.length}`)} done | Elapsed: ${mins}:${secs}`);
    lines.push("");

    // Models
    lines.push(`  Models: light=${this.theme.fg("dim", plan.models.light)} | medium=${this.theme.fg("muted", plan.models.medium)} | heavy=${this.theme.fg("bright", plan.models.heavy)}`);
    lines.push("");

    // Tasks
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const isSelected = i === this.cursor;
      const prefix = isSelected ? this.theme.fg("accent", "▶ ") : "  ";

      let icon: string;
      switch (task.status) {
        case "done": icon = this.theme.fg("green", "✅"); break;
        case "running": icon = this.theme.fg("yellow", "🔄"); break;
        case "fail": icon = this.theme.fg("red", "❌"); break;
        case "blocked": icon = this.theme.fg("red", "🚫"); break;
        case "cancelled": icon = this.theme.fg("muted", "❌"); break;
        default: icon = this.theme.fg("dim", "⏳");
      }

      const model = task.model || plan.models[task.tier];
      let line = `${prefix}${icon} ${task.id}: ${task.title}`;
      line += ` ${this.theme.fg("dim", `[${task.tier}→${model}]`)}`;

      if (task.status === "done" && task.output) {
        line += ` ${this.theme.fg("green", "✓")}`;
      } else if (task.status === "fail" && task.error) {
        line += ` ${this.theme.fg("red", task.error.substring(0, 30))}`;
      }

      lines.push(line);
    }

    lines.push("");

    // Stats
    const stats = [
      this.theme.fg("green", `Done: ${done}`),
      this.theme.fg("yellow", `Running: ${running}`),
      this.theme.fg("muted", `Queued: ${queued}`),
    ];
    if (blocked > 0) stats.push(this.theme.fg("red", `Blocked: ${blocked}`));
    if (failed > 0) stats.push(this.theme.fg("red", `Failed: ${failed}`));
    lines.push(`  ${stats.join(" | ")}`);

    // Controls
    lines.push("");
    lines.push(this.theme.fg("dim", "  [↑↓] Navigate  [Enter] Execute  [c] Cancel  [p] Pause  [r] Resume  [Esc] Close"));

    return lines;
  }

  handleInput(data: string): void {
    const tasks = plan ? Array.from(plan.tasks.values()) : [];

    if (data === "up" || data === "k") {
      this.cursor = Math.max(0, this.cursor - 1);
    } else if (data === "down" || data === "j") {
      this.cursor = Math.min(tasks.length - 1, this.cursor + 1);
    } else if (data === "return") {
      this.doneCb?.("execute");
    } else if (data === "escape") {
      this.doneCb?.("close");
    } else if (data === "c") {
      const task = tasks[this.cursor];
      if (task && (task.status === "queued" || task.status === "running")) {
        task.status = "cancelled";
        this.doneCb?.(`cancel:${task.id}`);
      }
    } else if (data === "p") {
      const task = tasks[this.cursor];
      if (task && task.status === "running") {
        task.status = "queued";
        this.doneCb?.(`pause:${task.id}`);
      }
    } else if (data === "r") {
      const task = tasks[this.cursor];
      if (task && task.status === "blocked") {
        task.status = "queued";
        task.retryCount = 0;
        this.doneCb?.(`resume:${task.id}`);
      }
    }
  }
}

// ─── Main Extension ────────────────────────────────────────────
export default function (pi: ExtensionAPI) {

  // ─── /orchestrate command ────────────────────────────────────
  pi.registerCommand("orchestrate", {
    description: "Orquesta ejecución multi-agente de un plan",
    handler: async (args, ctx) => {
      try {
        const parts = args.trim().split(/\s+/);

        if (parts.length < 2 || !parts[0] || !parts[1]) {
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
        const parsed = parseFrontmatter(planContent);

        if (!parsed) {
          ctx.ui.notify("❌ plan.md no tiene YAML frontmatter válido", "error");
          return;
        }

        if (!parsed.tasks || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
          ctx.ui.notify("❌ plan.md no tiene tareas válidas", "error");
          return;
        }

        // Build plan state
        const models = {
          light: parsed.models?.light || "haiku",
          medium: parsed.models?.medium || "sonnet",
          heavy: parsed.models?.heavy || "opus",
        };

        const config = {
          maxConcurrentWorkers: parsed.config?.max_concurrent_workers || 4,
          maxRetries: parsed.config?.max_retries || 3,
          timeoutPerTaskMs: parsed.config?.timeout_per_task_ms || 300000,
        };

        const tasks = new Map<string, TaskState>();
        for (const t of parsed.tasks) {
          tasks.set(t.id, {
            id: t.id,
            title: t.title,
            tier: t.tier || "medium",
            model: t.model,
            dependencies: t.dependencies || [],
            prompt: t.prompt || t.title,
            status: "queued",
            retryCount: 0,
          });
        }

        plan = {
          planId: parsed.plan_id || `plan-${Date.now()}`,
          specFile: specPath,
          planFile: planPath,
          models,
          config,
          tasks,
          status: "idle",
          startTime: Date.now(),
        };

        // Dry run
        if (dryRun) {
          showDryRun(ctx);
          return;
        }

        // Show TUI
        const proceed = await showTUI(ctx);

        if (proceed) {
          await executePlan(pi, ctx);
        }

      } catch (error: any) {
        ctx.ui.notify(`❌ Error: ${error.message}`, "error");
        console.error("Orchestrator error:", error);
      }
    },
  });

  // ─── orchestrate tool ────────────────────────────────────────
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
        const planPath = resolve(ctx.cwd, params.plan_file);
        if (!existsSync(planPath)) {
          return { content: [{ type: "text", text: `Error: ${params.plan_file} no encontrado` }], details: {} };
        }

        const content = readFileSync(planPath, "utf-8");
        const parsed = parseFrontmatter(content);

        if (!parsed?.tasks) {
          return { content: [{ type: "text", text: "Error: YAML inválido o sin tareas" }], details: {} };
        }

        const summary = parsed.tasks.map((t: any) =>
          `• ${t.id}: ${t.title} [${t.tier || "medium"}]`
        ).join("\n");

        return {
          content: [{ type: "text", text: `📋 ${parsed.tasks.length} tareas:\n\n${summary}\n\nPara ejecutar: /orchestrate ${params.spec_file} ${params.plan_file}` }],
          details: { task_count: parsed.tasks.length },
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
    plan = null;
  });
}

// ─── Dry Run ───────────────────────────────────────────────────
function showDryRun(ctx: any) {
  if (!plan) return;

  const tasks = Array.from(plan.tasks.values());
  const ready = tasks.filter(t => t.status === "queued" && t.dependencies.length === 0);

  let msg = `\n📋 Plan: ${plan.planId}\n`;
  msg += `📊 Total: ${tasks.length} tareas\n`;
  msg += `⚡ Concurrencia: ${plan.config.maxConcurrentWorkers}\n\n`;

  for (const task of tasks) {
    const model = task.model || plan.models[task.tier];
    const deps = task.dependencies.length > 0 ? ` ← [${task.dependencies.join(", ")}]` : "";
    msg += `  • ${task.id}: ${task.title} (${task.tier}→${model})${deps}\n`;
  }

  msg += `\n🚀 Listas ahora: ${ready.map(t => t.id).join(", ") || "ninguna"}\n`;

  ctx.ui.notify(msg, "info");
}

// ─── Show TUI ──────────────────────────────────────────────────
async function showTUI(ctx: any): Promise<boolean> {
  const tui = new OrchestratorTUI(ctx.ui.theme);

  const result = await ctx.ui.custom<boolean>((tuiTheme, theme, keybindings, done) => {
    tui.setDoneCallback((action) => {
      if (action === "close") done(false);
      else if (action === "execute") done(true);
    });
    return tui;
  });

  return result === true;
}

// ─── Execute Plan ──────────────────────────────────────────────
async function executePlan(pi: ExtensionAPI, ctx: any) {
  if (!plan) return;

  plan.status = "running";
  ctx.ui.setStatus("orchestrator", `🐙 Executing: ${plan.planId}`);

  // Get spec content
  const specContent = existsSync(plan.specFile)
    ? readFileSync(plan.specFile, "utf-8").substring(0, 3000)
    : "";

  // Build execution message
  const msg = buildExecutionMessage(specContent);

  // Send to LLM for execution
  ctx.ui.notify(`🚀 Enviando plan al orquestador...`, "info");

  pi.sendMessage({
    customType: "orchestrator-execution",
    content: msg,
    display: true,
  }, {
    deliverAs: "followUp",
    triggerTurn: true,
  });
}

function buildExecutionMessage(specContent: string): string {
  if (!plan) return "";

  const tasks = Array.from(plan.tasks.values());
  const ready = tasks.filter(t => t.status === "queued" && t.dependencies.length === 0);
  const pending = tasks.filter(t => t.status === "queued" && t.dependencies.length > 0);

  let msg = `## 🐙 Orquestador Multi-Agente\n\n`;
  msg += `Plan: ${plan.planId}\n\n`;

  msg += `### Configuración\n`;
  msg += `- Modelos: light=${plan.models.light}, medium=${plan.models.medium}, heavy=${plan.models.heavy}\n`;
  msg += `- Max workers: ${plan.config.maxConcurrentWorkers}\n`;
  msg += `- Max reintentos: ${plan.config.maxRetries}\n\n`;

  if (ready.length > 0) {
    msg += `### Tareas para ejecutar AHORA (sin dependencias)\n\n`;
    for (const task of ready) {
      const model = task.model || plan.models[task.tier];
      msg += `#### ${task.id}: ${task.title}\n`;
      msg += `- Modelo: ${model}\n`;
      msg += `- Instrucción: ${task.prompt}\n\n`;
    }
  }

  if (pending.length > 0) {
    msg += `### Tareas pendientes (ejecutar cuando dependencias terminen)\n\n`;
    for (const task of pending) {
      const model = task.model || plan.models[task.tier];
      msg += `#### ${task.id}: ${task.title}\n`;
      msg += `- Modelo: ${model}\n`;
      msg += `- Depende de: ${task.dependencies.join(", ")}\n`;
      msg += `- Instrucción: ${task.prompt}\n\n`;
    }
  }

  if (specContent) {
    msg += `### Especificación del Proyecto\n\n${specContent}\n\n`;
  }

  msg += `### Instrucciones\n`;
  msg += `1. Ejecuta las tareas en orden de dependencias\n`;
  msg += `2. Usa subagentes para paralelizar tareas independientes\n`;
  msg += `3. Al terminar cada tarea, reporta el resultado\n`;
  msg += `4. Si falla, reporta el error y continúa con las demás\n`;

  return msg;
}
