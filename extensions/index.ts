import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Pi Orchestrator Extension
 * Multi-agent task orchestration with parallel execution and TUI dashboard
 */
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

      const specFile = parts[0];
      const planFile = parts[1];
      const options = parts.slice(2);

      ctx.ui.notify(`Orchestrator: Iniciando con ${specFile} + ${planFile}`, "info");
      
      // Parse options
      const config = parseOptions(options);
      ctx.ui.notify(`Config: concurrency=${config.concurrency}, timeout=${config.timeout}ms`, "info");

      // TODO: Implement full orchestration logic
      // This is a placeholder that will be expanded
      ctx.ui.notify("Orchestrator: Funcionalidad completa en desarrollo", "info");
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

      // TODO: Implement orchestration logic
      
      return {
        content: [{ 
          type: "text", 
          text: `Orquestación completada para ${params.plan_file}` 
        }],
        details: {
          spec: params.spec_file,
          plan: params.plan_file,
          status: "placeholder",
        },
      };
    },
  });

  // Session lifecycle
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("orchestrator", "🐙 Orchestrator ready");
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    // Cleanup if needed
  });
}

/**
 * Parse CLI-style options into config object
 */
function parseOptions(args: string[]) {
  const config = {
    concurrency: 4,
    timeout: 300000,
    retries: 3,
    models: "",
    dry_run: false,
    resume: false,
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
      config.models = args[++i] || "";
    } else if (arg === "--dry-run" || arg === "-d") {
      config.dry_run = true;
    } else if (arg === "--resume") {
      config.resume = true;
    }
  }

  return config;
}
