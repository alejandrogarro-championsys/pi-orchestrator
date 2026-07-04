import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Pi Orchestrator Extension - Working Implementation
 * Uses widget + sendMessage for non-blocking orchestration
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

    if (indent === 0 && !inTasks) {
      const m = trimmed.match(/^(\w[\w_]*):\s*(.+)/);
      if (m) { result[m[1]] = parseValue(m[2]); currentSection = null; }
      continue;
    }

    if (indent > 0 && !inTasks && currentSection) {
      const m = trimmed.match(/^(\w[\w_]*):\s*(.+)/);
      if (m) currentSection[m[1]] = parseValue(m[2]);
      continue;
    }

    if (trimmed.startsWith("- ") && inTasks) {
      if (currentTask?.id) result.tasks = [...(result.tasks || []), currentTask];
      currentTask = {};
      const m = trimmed.slice(2).match(/^(\w[\w_]*):\s*(.*)/);
      if (m) currentTask[m[1]] = parseValue(m[2]);
      continue;
    }

    if (indent > 0 && inTasks && currentTask) {
      const m = trimmed.match(/^(\w[\w_]*):\s*(.+)/);
      if (m) {
        currentTask[m[1]] = m[1] === "dependencies" ? parseArray(m[2]) : parseValue(m[2]);
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
  if (!isNaN(Number(v)) && v !== "") return Number(v);
  return v;
}

function parseArray(raw: string): any[] {
  const v = raw.trim();
  if (v.startsWith("[")) return v.slice(1, -1).split(",").map(s => parseValue(s));
  return [parseValue(v)];
}

// ─── State ─────────────────────────────────────────────────────
interface TaskInfo {
  id: string;
  title: string;
  tier: string;
  prompt: string;
  dependencies: string[];
  status: "pending" | "running" | "done" | "fail";
}

let currentPlan: {
  id: string;
  models: { light: string; medium: string; heavy: string };
  tasks: Map<string, TaskInfo>;
  specPath: string;
  planPath: string;
} | null = null;

// ─── Extension ─────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {

  // ─── /orchestrate command ──────────────────────────────────
  pi.registerCommand("orchestrate", {
    description: "Orquesta ejecución multi-agente de un plan",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);

      // Help
      if (parts[0] === "--help" || parts[0] === "-h") {
        ctx.ui.notify("Uso: /orchestrate <spec.md> <plan.md> [--dry-run]", "info");
        return;
      }

      if (parts.length < 2) {
        ctx.ui.notify("Uso: /orchestrate <spec.md> <plan.md>", "error");
        return;
      }

      const specPath = resolve(ctx.cwd, parts[0]);
      const planPath = resolve(ctx.cwd, parts[1]);
      const dryRun = parts.includes("--dry-run") || parts.includes("-d");

      // Validate
      if (!existsSync(specPath)) { ctx.ui.notify(`❌ ${parts[0]} no encontrado`, "error"); return; }
      if (!existsSync(planPath)) { ctx.ui.notify(`❌ ${parts[1]} no encontrado`, "error"); return; }

      // Parse
      const parsed = parseFrontmatter(readFileSync(planPath, "utf-8"));
      if (!parsed?.tasks?.length) { ctx.ui.notify("❌ YAML inválido o sin tareas", "error"); return; }

      // Build state
      const models = {
        light: parsed.models?.light || "haiku",
        medium: parsed.models?.medium || "sonnet",
        heavy: parsed.models?.heavy || "opus",
      };

      const tasks = new Map<string, TaskInfo>();
      for (const t of parsed.tasks) {
        tasks.set(t.id, {
          id: t.id,
          title: t.title,
          tier: t.tier || "medium",
          prompt: t.prompt || t.title,
          dependencies: t.dependencies || [],
          status: "pending",
        });
      }

      currentPlan = {
        id: parsed.plan_id || `plan-${Date.now()}`,
        models,
        tasks,
        specPath,
        planPath,
      };

      // Dry run
      if (dryRun) {
        const ready = Array.from(tasks.values()).filter(t => t.dependencies.length === 0);
        let msg = `\n📋 Plan: ${currentPlan.id}\n📊 ${tasks.length} tareas\n\n`;
        for (const t of tasks.values()) {
          const deps = t.dependencies.length > 0 ? ` ← [${t.dependencies.join(", ")}]` : "";
          msg += `  • ${t.id}: ${t.title} (${t.tier})${deps}\n`;
        }
        msg += `\n🚀 Listas: ${ready.map(t => t.id).join(", ")}\n`;
        ctx.ui.notify(msg, "info");
        return;
      }

      // Show widget with plan status
      updateWidget(ctx);

      // Find ready tasks (no dependencies)
      const ready = Array.from(tasks.values()).filter(t => t.dependencies.length === 0);

      if (ready.length === 0) {
        ctx.ui.notify("❌ No hay tareas para ejecutar (todas tienen dependencias pendientes)", "error");
        return;
      }

      // Build execution message for LLM
      const specContent = readFileSync(specPath, "utf-8").substring(0, 3000);

      let execMsg = `## 🐙 Plan de Orquestación: ${currentPlan.id}\n\n`;
      execMsg += `Modelos: light=${models.light}, medium=${models.medium}, heavy=${models.heavy}\n\n`;
      execMsg += `### Ejecuta estas tareas en orden:\n\n`;

      // All tasks with their dependencies
      for (const t of tasks.values()) {
        const model = models[t.tier as keyof typeof models] || models.medium;
        const deps = t.dependencies.length > 0 ? `\nDepende de: ${t.dependencies.join(", ")}` : "";
        execMsg += `**${t.id}** (${t.tier}→${model}): ${t.prompt}${deps}\n\n`;
      }

      execMsg += `### Especificación del Proyecto\n\n${specContent}\n\n`;
      execMsg += `### Instrucciones\n`;
      execMsg += `1. Ejecuta las tareas que NO tienen dependencias primero\n`;
      execMsg += `2. Cuando completes una tarea, ejecuta las que dependen de ella\n`;
      execMsg += `3. Usa subagentes para paralelizar cuando sea posible\n`;
      execMsg += `4. Al terminar, reporta el estado de cada tarea\n`;

      // Send to LLM
      ctx.ui.notify(`🚀 Iniciando orquestación: ${ready.length} tareas listas`, "info");

      pi.sendMessage({
        customType: "orchestrator-plan",
        content: execMsg,
        display: true,
      }, {
        deliverAs: "followUp",
        triggerTurn: true,
      });
    },
  });

  // ─── orchestrate tool ──────────────────────────────────────
  pi.registerTool({
    name: "orchestrate",
    label: "Orchestrate",
    description: "Ejecuta un plan multi-agente desde spec.md y plan.md",
    parameters: Type.Object({
      spec_file: Type.String({ description: "Ruta al spec.md" }),
      plan_file: Type.String({ description: "Ruta al plan.md" }),
      dry_run: Type.Optional(Type.Boolean({ description: "Solo mostrar plan" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const planPath = resolve(ctx.cwd, params.plan_file);
      if (!existsSync(planPath)) return { content: [{ type: "text", text: "Error: no encontrado" }], details: {} };

      const parsed = parseFrontmatter(readFileSync(planPath, "utf-8"));
      if (!parsed?.tasks) return { content: [{ type: "text", text: "Error: YAML inválido" }], details: {} };

      const list = parsed.tasks.map((t: any) => `• ${t.id}: ${t.title} [${t.tier}]`).join("\n");
      return {
        content: [{ type: "text", text: `${parsed.tasks.length} tareas:\n${list}\n\nPara ejecutar: /orchestrate ${params.spec_file} ${params.plan_file}` }],
        details: { task_count: parsed.tasks.length },
      };
    },
  });

  // ─── Session hooks ─────────────────────────────────────────
  pi.on("session_start", async (_e, ctx) => {
    ctx.ui.setStatus("orchestrator", "🐙 Ready | /orchestrate spec.md plan.md");
  });

  pi.on("session_shutdown", async () => {
    currentPlan = null;
  });
}

// ─── Widget Update ─────────────────────────────────────────────
function updateWidget(ctx: any) {
  if (!currentPlan) {
    ctx.ui.setWidget("orchestrator", undefined);
    return;
  }

  const tasks = Array.from(currentPlan.tasks.values());
  const done = tasks.filter(t => t.status === "done").length;
  const running = tasks.filter(t => t.status === "running").length;
  const pending = tasks.filter(t => t.status === "pending").length;

  const lines = [
    `🐙 ${currentPlan.id} | ${done}/${tasks.length} done | ${running} running | ${pending} pending`,
  ];

  ctx.ui.setWidget("orchestrator", lines);
}
