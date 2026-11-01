import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseModelConfig, type ModelConfig } from "./model-config.ts";
import { parseStatusConfig, type StatusConfig } from "./status.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_CONFIG_PATH = join(PACKAGE_ROOT, "config.json");
const CONFIG_EXAMPLE_PATH = join(PACKAGE_ROOT, "config.json.example");

export interface EnvironmentConfig {
  allowOutsideHerdr: boolean;
}

export interface BehaviorConfig {
  closeOnDone: boolean;
}

export interface SubagentConfig {
  status: StatusConfig;
  models: ModelConfig;
  environment: EnvironmentConfig;
  behavior: BehaviorConfig;
}

const DEFAULT_ENVIRONMENT: EnvironmentConfig = { allowOutsideHerdr: false };
const DEFAULT_BEHAVIOR: BehaviorConfig = { closeOnDone: true };

function parseEnvironmentConfig(raw: unknown, source: string): EnvironmentConfig {
  if (raw == null) return DEFAULT_ENVIRONMENT;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid subagent config in ${source}: environment must be an object`);
  }
  const value = raw as Record<string, unknown>;
  const unsupported = Object.keys(value).filter((key) => key !== "allowOutsideHerdr");
  if (unsupported.length > 0) {
    throw new Error(
      `Invalid subagent config in ${source}: environment has unsupported key(s): ${unsupported.join(", ")}`,
    );
  }
  if (value.allowOutsideHerdr != null && typeof value.allowOutsideHerdr !== "boolean") {
    throw new Error(
      `Invalid subagent config in ${source}: environment.allowOutsideHerdr must be a boolean`,
    );
  }
  return { allowOutsideHerdr: value.allowOutsideHerdr === true };
}

function parseBehaviorConfig(raw: unknown, source: string): BehaviorConfig {
  if (raw == null) return DEFAULT_BEHAVIOR;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid subagent config in ${source}: behavior must be an object`);
  }
  const value = raw as Record<string, unknown>;
  const unsupported = Object.keys(value).filter((key) => key !== "closeOnDone");
  if (unsupported.length > 0) {
    throw new Error(
      `Invalid subagent config in ${source}: behavior has unsupported key(s): ${unsupported.join(", ")}`,
    );
  }
  if (value.closeOnDone != null && typeof value.closeOnDone !== "boolean") {
    throw new Error(
      `Invalid subagent config in ${source}: behavior.closeOnDone must be a boolean`,
    );
  }
  return { closeOnDone: value.closeOnDone !== false };
}

function parseSubagentConfig(raw: unknown, source = "config.json"): SubagentConfig {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid subagent config in ${source}: root must be an object`);
  }
  const config = raw as Record<string, unknown>;
  return {
    status: parseStatusConfig(config, source),
    models: parseModelConfig(config, source),
    environment: parseEnvironmentConfig(config.environment, source),
    behavior: parseBehaviorConfig(config.behavior, source),
  };
}

function readConfigSource(configPath: string, examplePath: string): { sourcePath: string; raw: string } {
  try {
    return { sourcePath: configPath, raw: readFileSync(configPath, "utf8") };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "ENOENT") throw error;
  }

  try {
    return { sourcePath: examplePath, raw: readFileSync(examplePath, "utf8") };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      throw new Error(`Missing subagent config. Expected ${configPath} or ${examplePath}.`);
    }
    throw error;
  }
}

function loadSubagentConfig(): SubagentConfig {
  const { sourcePath, raw } = readConfigSource(DEFAULT_CONFIG_PATH, CONFIG_EXAMPLE_PATH);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in subagent config ${sourcePath}: ${detail}`);
  }
  return parseSubagentConfig(parsed, sourcePath);
}

let cachedConfig: SubagentConfig | undefined;

export function getSubagentConfig(): SubagentConfig {
  cachedConfig ??= loadSubagentConfig();
  return cachedConfig;
}

export function getEnvironmentConfig(): EnvironmentConfig {
  try {
    return getSubagentConfig().environment;
  } catch {
    return DEFAULT_ENVIRONMENT;
  }
}

export function getBehaviorConfig(): BehaviorConfig {
  try {
    return getSubagentConfig().behavior;
  } catch {
    return DEFAULT_BEHAVIOR;
  }
}
