/**
 * T03: configuration loading with documented precedence.
 *
 * Precedence (lowest to highest):
 *   1. Built-in defaults (DEFAULT_CONFIG in schema.ts)
 *   2. Config file (JSON; path from options.file or KIWIFS_MEMORY_CONFIG env)
 *   3. Explicit runtime overrides (options.overrides — deep-merged last)
 *
 * The loader never resolves credential references to secret values. It reads
 * only the config file; env/secret-file references stay symbolic.
 */

import { readFileSync } from "node:fs";
import {
  DEFAULT_CONFIG,
  validateConfig,
  type MemoryConfig,
  type ValidationIssue,
} from "./schema.ts";

export interface LoadOptions {
  /** Explicit config file path; falls back to KIWIFS_MEMORY_CONFIG, then no file. */
  file?: string;
  /** Highest-precedence partial overrides (already raw JSON-shaped). */
  overrides?: Record<string, unknown>;
}

export type LoadResult =
  | { ok: true; config: MemoryConfig; file?: string }
  | { ok: false; issues?: ValidationIssue[]; file?: string; fatal?: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge: later sources win; objects merge recursively, arrays replace. */
export function deepMerge(
  base: Record<string, unknown>,
  ...sources: Record<string, unknown>[]
): Record<string, unknown> {
  let out: Record<string, unknown> = { ...base };
  for (const src of sources) {
    for (const [key, value] of Object.entries(src)) {
      const existing = out[key];
      if (isPlainObject(existing) && isPlainObject(value)) {
        out[key] = deepMerge(existing as Record<string, unknown>, value);
      } else {
        out[key] = value;
      }
    }
  }
  return out;
}

function resolveFilePath(explicit?: string): string | undefined {
  if (explicit) return explicit;
  const env = process.env["KIWIFS_MEMORY_CONFIG"];
  if (env && env.trim() !== "") return env;
  return undefined;
}

export function loadConfig(options: LoadOptions = {}): LoadResult {
  const file = resolveFilePath(options.file);
  let rawFile: Record<string, unknown> = {};
  if (file) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return {
        ok: false,
        fatal: `config file unreadable: ${file} (${code ?? (err as Error).message})`,
      };
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!isPlainObject(parsed)) {
        return {
          ok: false,
          fatal: `config file is not a JSON object: ${file}`,
          file,
        };
      }
      rawFile = parsed;
    } catch (err) {
      return {
        ok: false,
        fatal: `config file is not valid JSON: ${file} (${(err as Error).message})`,
        file,
      };
    }
  }

  const merged = deepMerge(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    rawFile,
    options.overrides ?? {},
  );
  const result = validateConfig(merged);
  if (!result.ok) {
    return file
      ? { ok: false, issues: result.issues, file }
      : { ok: false, issues: result.issues };
  }
  return file
    ? { ok: true, config: result.config, file }
    : { ok: true, config: result.config };
}
