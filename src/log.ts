import { errorText } from "./util.js";

export function log(level: "INFO" | "WARN" | "ERROR", event: string, details: Record<string, unknown> = {}): void {
  const safe = Object.fromEntries(Object.entries(details).filter(([key]) => !/token|secret|credential|buyer|address|raw|body/i.test(key)));
  console.log(JSON.stringify({ level, event, at: new Date().toISOString(), ...safe }));
}

export function logError(event: string, error: unknown, details: Record<string, unknown> = {}): void {
  log("ERROR", event, { ...details, error: errorText(error).slice(0, 1000) });
}
