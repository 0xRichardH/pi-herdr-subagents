import type { HarnessDriver } from "./types.ts";
import { PiHarnessDriver } from "./drivers/pi.ts";
import { ClaudeHarnessDriver } from "./drivers/claude.ts";
import { OpenCodeHarnessDriver } from "./drivers/opencode.ts";
import { CodexHarnessDriver } from "./drivers/codex.ts";
import { GrokHarnessDriver } from "./drivers/grok.ts";
import { GenericHarnessDriver } from "./drivers/generic.ts";

const drivers = new Map<string, HarnessDriver>();

// Register default built-in harness drivers
const defaultDrivers: HarnessDriver[] = [
  new PiHarnessDriver(),
  new ClaudeHarnessDriver(),
  new OpenCodeHarnessDriver(),
  new CodexHarnessDriver(),
  new GrokHarnessDriver(),
];

for (const driver of defaultDrivers) {
  drivers.set(driver.id.toLowerCase(), driver);
}

export function registerHarnessDriver(driver: HarnessDriver): void {
  drivers.set(driver.id.toLowerCase(), driver);
}

export function getHarnessDriver(cliName?: string): HarnessDriver {
  if (!cliName || cliName.trim() === "") {
    return drivers.get("pi")!;
  }
  const normalized = cliName.trim().toLowerCase();
  const existing = drivers.get(normalized);
  if (existing) {
    return existing;
  }
  // Return generic driver for unlisted/custom CLIs
  return new GenericHarnessDriver(normalized);
}

export function getRegisteredHarnessDrivers(): HarnessDriver[] {
  return Array.from(drivers.values());
}
