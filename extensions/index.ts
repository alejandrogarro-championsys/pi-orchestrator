import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Component } from "@earendil-works/pi-tui";

/**
 * Pi Orchestrator Extension
 * Valid theme colors: accent, success, error, warning, muted, dim, text
 */

// ─── YAML Parser ───────────────────────────────────────────────
function parseFrontmatter(content: string): any {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const result: any = {};
  let inTasks = false;
  let currentTask: any = null;
  let currentSection: any = null;

  for (const rawLine of match[1].split("\n")) {
    const line = rawLine.replace(/\t/g, "  ");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;

    // Top-level section header (no value)
    if (indent === 0 && trimmed.match(/^(\w[\w_]*):\s*$/)) {
      const key = trimmed.match(/^(\w[\w_]*):/)?.[1];
      if (key === "tasks") {
        inTasks = true;
        currentTask = null;
      } else {
        inTasks = false;
        result[key] = {};
        currentSection = result[key];
      }
      continue;
    }

    // Top-level key with value
    if (indent === 0 && !inTasks) {
      const m = trimmed.match(/^(\w[\w_]*):\s*(.+)/);
      if (m) {
        result[m[1]] = parseValue(m[2]);
        currentSection = null;
        continue;
      }
    }

    // Inside section
    if (indent > 0 && !inTasks && currentSection) {
      const m = trimmed.match(/^(\w[\w_]*):\s*(.+)/);
      if (m) currentSection[m[1]] = parseValue(m[2]);
      continue;
    }

    // Task array item
    if (trimmed.startsWith("- ") && inTasks) {
      if (currentTask?.id) result.tasks = [...(result.tasks || []), currentTask];
      currentTask = {};
      const m = trimmed.slice(2).match(/^(\w[\w_]*):\s*(.*)/);
      if (m) currentTask[m[1]] = parseValue(m[2]);
      continue;
    }

    // Task property
    if (indent > 0 && inTasks && currentTask) {
      const m = trimmed.match(/^(\w[\w_]*):\s*(.+)/);
      if (m) {
        if (m[1] === "dependencies") {
          currentTask[m[1]] = parseArray(m[2]);
        } else {
          currentTask[m[1]] = parseValue(m[2]);
        }
      }
    }
  }

  if (currentTask?.id) result.tasks = [...(result.tasks || []), currentTask];
  return result;
}

function parseValue(raw: string): any {
  const v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (!isNaN(Number(v)) && v !== "") return Number(v);
  return v;
}

function parseArray(raw: string): any[] {
  const v = raw.trim();
  if (v.startsWith("[")) return v.slice(1, -1).split(",").map(s => parseValue(s));
  return [parseValue(v)];
}

// ─── Task State ────────────────────────────────────────────────
interface TaskState {
  id: string;
  title: string;
  tier: string;
  model?: string;
  dependencies: string[];
  prompt: string;
  status: "queued" | "running" | "done" | "fail" | "blocked";
  retryCount: number;
  error?: string;
}

interface PlanState {
  planId: string;
  specFile: string;
  planFile: string;
  models: { light: string; medium: string; heavy: string };
  tasks: Map<string, TaskState>;
  startTime: number;
  status: string;
}

let plan: PlanState | null = null;

// ─── TUI Component ─────────────────────────────────────────────
class OrchestratorDashboard implements Component {
  private cursor = 0;
  private cb: ((action: string) => void) | null = null;

  constructor(private theme: any) {}

  setCallback(fn: (action: string) => void) { this.cb = fn; }

  render(width: number): string[] {
    if (!plan) return ["No plan loaded"];

    const lines: string[] = [];
    const tasks = Array.from(plan.tasks.values());
    const done = tasks.filter(t => t.status === "done").length;
    const running = tasks.filter(t => t.status === "running").length;
    const queued = tasks.filter(t => t.status === "queued").length;
    const elapsed = Math.floor((Date.now() - plan.startTime) / 1000);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const secs = String(elapsed % 60).padStart(2, "0");

    // Use only valid theme colors: accent, success, error, warning, muted, dim, text
    lines.push(this.theme.fg("accent", "🐙 PI ORCHESTRATOR"));
    lines.push("");
    lines.push(`  Plan: ${this.theme.fg("dim", plan.planId)}`);
    lines.push(`  Status: ${plan.status === "completed" ? this.theme.fg("success", "Done") : this.theme.fg("warning", "Running")}`);
    lines.push(`  Tasks: ${done}/${tasks.length} done | Elapsed: ${mins}:${secs}`);
    lines.push("");
    lines.push(`  Models: light=${plan.models.light} | medium=${plan.models.medium} | heavy=${plan.models.heavy}`);
    lines.push("");

    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      const sel = i === this.cursor;
      const pre = sel ? this.theme.fg("accent", "▶ ") : "  ";

      let icon: string;
      switch (t.status) {
        case "done": icon = "✅"; break;
        case "running": icon = "🔄"; break;
        case "fail": icon = "❌"; break;
        case "blocked": icon = "🚫"; break;
        default: icon = "⏳";
      }

      lines.push(`${pre}${icon} ${t.id}: ${t.title} [${t.tier}]`);
    }

    lines.push("");
    lines.push(this.theme.fg("dim", `  Done: ${done} | Running: ${running} | Queued: ${queued}`));
    lines.push("");
    lines.push(this.theme.fg("dim", "  [↑↓] Nav  [Enter] Execute  [c] Cancel  [p] Pause  [Esc] Close"));

    return lines;
  }

  handleInput(data: string): void {
    const tasks = plan ? Array.from(plan.tasks.values()) : [];

    if (data === "up" || data === "k") this.cursor = Math.max(0, this.cursor - 1);
    else if (data === "down" || data === "j") this.cursor = Math.min(tasks.length - 1, this.cursor + 1);
    else if (data === "return") this.cb?.("execute");
    else if (data === "escape") this.cb?.("close");
    else if (data === "c") {
      const t = tasks[this.cursor];
      if (t && (t.status === "queued" || t.status === "running")) {
        t.status = "blocked";
        this.cb?.(`cancel:${t.id}`);
      }
    } else if (data === "p") {
      const t = tasks[this.cursor];
      if (t?.status === "running") {
        t.status = "queued";
        this.cb?.(`pause:${t.id}`);
      }
    }
  }
}

// ─── Extension ─────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {

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

        if (!existsSync(specPath)) { ctx.ui.notify(`❌ No encontrado: ${parts[0]}`, "error"); return; }
        if (!existsSync(planPath)) { ctx.ui.notify(`❌ No encontrado: ${parts[1]}`, "error"); return; }

        const parsed = parseFrontmatter(readFileSync(planPath, "utf-8"));
        if (!parsed?.tasks?.length) { ctx.ui.notify("❌ YAML inválido o sin tareas", "error"); return; }

        const models = {
          light: parsed.models?.light || "haiku",
          medium: parsed.models?.medium || "sonnet",
          heavy: parsed.models?.heavy || "opus",
        };

        const tasks = new Map<string, TaskState>();
        for (const t of parsed.tasks) {
          tasks.set(t.id, {
            id: t.id, title: t.title, tier: t.tier || "medium", model: t.model,
            dependencies: t.dependencies || [], prompt: t.prompt || t.title,
            status: "queued", retryCount: 0,
          });
        }

        plan = {
          planId: parsed.plan_id || `plan-${Date.now()}`,
          specFile: specPath, planFile: planPath, models, tasks,
          startTime: Date.now(), status: "ready",
        };

        if (dryRun) {
          const ready = Array.from(tasks.values()).filter(t => t.dependencies.length === 0);
          let msg = `\n📋 Plan: ${plan.planId}\n📊 ${tasks.length} tareas\n\n`;
          for (const t of tasks.values()) {
            msg += `  • ${t.id}: ${t.title} (${t.tier})\n`;
          }
          msg += `\n🚀 Listas: ${ready.map(t => t.id).join(", ") || "ninguna"}\n`;
          ctx.ui.notify(msg, "info");
          return;
        }

        // Show TUI
        const proceed = await new Promise<boolean>((resolve) => {
          const dashboard = new OrchestratorDashboard(ctx.ui.theme);
          dashboard.setCallback((action) => {
            if (action === "close") resolve(false);
            else if (action === "execute") resolve(true);
          });

          ctx.ui.custom((t, _theme, _kb, done) => {
            dashboard.setCallback((a) => {
              if (a === "close") done(false);
              else if (a === "execute") done(true);
            });
            return dashboard;
          });
        });

        if (!proceed) return;

        // Execute via LLM
        plan.status = "running";
        ctx.ui.notify("🚀 Ejecutando plan...", "info");

        const specContent = existsSync(specPath) ? readFileSync(specPath, "utf-8").substring(0, 3000) : "";
        const ready = Array.from(tasks.values()).filter(t => t.dependencies.length === 0);

        let msg = `## Orquestador Multi-Agente\n\nPlan: ${plan.planId}\n\n`;
        msg += `### Configuración\n- Modelos: light=${models.light}, medium=${models.medium}, heavy=${models.heavy}\n\n`;
        msg += `### Tareas para ejecutar AHORA\n\n`;

        for (const t of ready) {
          const model = t.model || models[t.tier as keyof typeof models] || models.medium;
          msg += `#### ${t.id}: ${t.title}\n- Modelo: ${model}\n- Instrucción: ${t.prompt}\n\n`;
        }

        const pending = Array.from(tasks.values()).filter(t => t.dependencies.length > 0);
        if (pending.length > 0) {
          msg += `### Tareas pendientes\n\n`;
          for (const t of pending) {
            msg += `#### ${t.id}: ${t.title}\n- Depende de: ${t.dependencies.join(", ")}\n- Instrucción: ${t.prompt}\n\n`;
          }
        }

        if (specContent) msg += `### Especificación\n\n${specContent}\n\n`;
        msg += `### Instrucciones\n1. Ejecuta tareas en orden de dependencias\n2. Reporta resultados\n`;

        pi.sendMessage({ customType: "orchestrator", content: msg, display: true }, { deliverAs: "followUp", triggerTurn: true });

      } catch (error: any) {
        ctx.ui.notify(`❌ Error: ${error.message}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "orchestrate",
    label: "Orchestrate",
    description: "Ejecuta un plan multi-agente",
    parameters: Type.Object({
      spec_file: Type.String({ description: "Ruta al spec.md" }),
      plan_file: Type.String({ description: "Ruta al plan.md" }),
      dry_run: Type.Optional(Type.Boolean({ description: "Solo mostrar plan" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        const planPath = resolve(ctx.cwd, params.plan_file);
        if (!existsSync(planPath)) return { content: [{ type: "text", text: "Error: no encontrado" }], details: {} };

        const parsed = parseFrontmatter(readFileSync(planPath, "utf-8"));
        if (!parsed?.tasks) return { content: [{ type: "text", text: "Error: YAML inválido" }], details: {} };

        const list = parsed.tasks.map((t: any) => `• ${t.id}: ${t.title} [${t.tier}]`).join("\n");
        return { content: [{ type: "text", text: `${parsed.tasks.length} tareas:\n${list}\n\nUsa /orchestrate para ejecutar` }], details: {} };
      } catch (e: any) { return { content: [{ type: "text", text: `Error: ${e.message}` }], details: {} }; }
    },
  });

  pi.on("session_start", async (_e, ctx) => ctx.ui.setStatus("orchestrator", "🐙 Ready"));
  pi.on("session_shutdown", async () => { plan = null; });
}
