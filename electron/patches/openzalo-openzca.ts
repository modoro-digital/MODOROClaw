import { spawn } from "node:child_process";
import * as fsSync from "node:fs";
import * as pathModule from "node:path";

// On Windows with shell:true, args containing spaces must be quoted.
// MODOROClaw PATCH: newlines/quotes in args cause cmd.exe to silently truncate messages
// (group bot replies never arrived). We avoid shell:true entirely when possible.
function shellSafeArgs(args: string[]): string[] {
  if (process.platform !== "win32") return args;
  return args.map(a => (a.includes(" ") || a.includes("&") || a.includes("|")) ? `"${a}"` : a);
}

// MODOROClaw PATCH: resolve openzca binary to direct `node <cli.js>` so we can use shell:false
// This avoids cmd.exe corrupting multi-line / special-char arguments.
let _cachedCliJsPath: string | null = null;
function resolveOpenzcaCliJs(binary: string): string | null {
  if (_cachedCliJsPath !== null) return _cachedCliJsPath;
  if (process.platform !== "win32") { _cachedCliJsPath = ""; return null; }
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const candidates = [
    pathModule.join(home, "AppData", "Roaming", "npm", "node_modules", "openzca", "dist", "cli.js"),
    pathModule.join(home, "AppData", "Local", "npm", "node_modules", "openzca", "dist", "cli.js"),
    "C:\\Program Files\\nodejs\\node_modules\\openzca\\dist\\cli.js",
  ];
  for (const p of candidates) {
    try { if (fsSync.existsSync(p)) { _cachedCliJsPath = p; return p; } } catch {}
  }
  _cachedCliJsPath = "";
  return null;
}

import { parseJsonOutput } from "./json-output.js";
import type { ResolvedOpenzaloAccount } from "./types.js";

type OpenzcaRunOptions = {
  binary?: string;
  profile: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
};

type OpenzcaRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type OpenzcaStreamingOptions = {
  binary?: string;
  profile: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onJsonLine?: (payload: Record<string, unknown>) => void | Promise<void>;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
};

function makeExecError(params: {
  binary: string;
  args: string[];
  exitCode: number;
  stderr: string;
  stdout: string;
}): Error {
  const stderr = params.stderr.trim();
  const stdout = params.stdout.trim();
  const detail = stderr || stdout || `process exited with code ${params.exitCode}`;
  return new Error(`${params.binary} ${params.args.join(" ")} failed: ${detail}`);
}

function normalizeError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  return new Error(typeof err === "string" ? err : String(err));
}

export function resolveOpenzcaExec(account: ResolvedOpenzaloAccount): {
  binary: string;
  profile: string;
} {
  return {
    binary: account.zcaBinary,
    profile: account.profile,
  };
}

export async function runOpenzcaCommand(options: OpenzcaRunOptions): Promise<OpenzcaRunResult> {
  const binary = options.binary?.trim() || "openzca";
  // MODOROClaw PATCH: prefer direct node invocation to avoid cmd.exe arg corruption
  const cliJs = resolveOpenzcaCliJs(binary);
  let spawnCmd: string;
  let spawnArgs: string[];
  let useShell: boolean;
  if (cliJs) {
    spawnCmd = "node";
    spawnArgs = [cliJs, "--profile", options.profile, ...options.args];
    useShell = false;
  } else {
    spawnCmd = binary;
    spawnArgs = shellSafeArgs(["--profile", options.profile, ...options.args]);
    useShell = true;
  }
  const args = spawnArgs;

  return await new Promise<OpenzcaRunResult>((resolve, reject) => {
    const child = spawn(spawnCmd, spawnArgs, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      shell: useShell,
    });

    let stdout = "";
    let stderr = "";
    let timeout: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;

    const finish = (fn: () => void) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (abortHandler && options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      fn();
    };

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      }, options.timeoutMs);
    }

    if (options.signal) {
      abortHandler = () => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      };
      options.signal.addEventListener("abort", abortHandler, { once: true });
      if (options.signal.aborted) {
        abortHandler();
      }
    }

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });

    child.on("error", (err) => {
      finish(() => reject(err));
    });

    child.on("close", (code) => {
      const exitCode = code ?? 0;
      if (exitCode !== 0) {
        finish(() =>
          reject(
            makeExecError({
              binary,
              args,
              exitCode,
              stderr,
              stdout,
            }),
          ),
        );
        return;
      }
      finish(() =>
        resolve({
          stdout,
          stderr,
          exitCode,
        }),
      );
    });
  });
}

export async function runOpenzcaInteractive(
  options: Omit<OpenzcaRunOptions, "timeoutMs" | "signal">,
): Promise<OpenzcaRunResult> {
  const binary = options.binary?.trim() || "openzca";
  // MODOROClaw PATCH: prefer direct node invocation
  const cliJs = resolveOpenzcaCliJs(binary);
  let spawnCmd: string;
  let spawnArgs: string[];
  let useShell: boolean;
  if (cliJs) {
    spawnCmd = "node";
    spawnArgs = [cliJs, "--profile", options.profile, ...options.args];
    useShell = false;
  } else {
    spawnCmd = binary;
    spawnArgs = shellSafeArgs(["--profile", options.profile, ...options.args]);
    useShell = true;
  }
  const args = spawnArgs;

  return await new Promise<OpenzcaRunResult>((resolve, reject) => {
    const child = spawn(spawnCmd, spawnArgs, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["inherit", "inherit", "pipe"],
      shell: useShell,
    });

    let stderr = "";

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
      // Keep stderr visible in interactive mode while still capturing for errors.
      process.stderr.write(chunk);
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code) => {
      const exitCode = code ?? 0;
      if (exitCode !== 0) {
        reject(
          makeExecError({
            binary,
            args,
            exitCode,
            stderr,
            stdout: "",
          }),
        );
        return;
      }
      resolve({
        stdout: "",
        stderr,
        exitCode,
      });
    });
  });
}

export async function runOpenzcaJson<T = unknown>(options: OpenzcaRunOptions): Promise<T> {
  const result = await runOpenzcaCommand(options);
  return parseJsonOutput(result.stdout, { strict: true }) as T;
}

export async function runOpenzcaStreaming(options: OpenzcaStreamingOptions): Promise<{ exitCode: number }> {
  const binary = options.binary?.trim() || "openzca";
  // MODOROClaw PATCH: prefer direct node invocation
  const cliJs = resolveOpenzcaCliJs(binary);
  let spawnCmd: string;
  let spawnArgs: string[];
  let useShell: boolean;
  if (cliJs) {
    spawnCmd = "node";
    spawnArgs = [cliJs, "--profile", options.profile, ...options.args];
    useShell = false;
  } else {
    spawnCmd = binary;
    spawnArgs = shellSafeArgs(["--profile", options.profile, ...options.args]);
    useShell = true;
  }
  const args = spawnArgs;

  return await new Promise<{ exitCode: number }>((resolve, reject) => {
    const child = spawn(spawnCmd, spawnArgs, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      shell: useShell,
    });

    let stdoutRemainder = "";
    let stderrRemainder = "";
    let abortHandler: (() => void) | undefined;
    let streamHandlerError: unknown;

    const emitStdoutLine = async (line: string) => {
      options.onStdoutLine?.(line);
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // Non-JSON line from child output; ignore.
        return;
      }
      await options.onJsonLine?.(parsed);
    };

    const flushRemainder = async () => {
      if (stdoutRemainder.trim()) {
        await emitStdoutLine(stdoutRemainder);
      }
      if (stderrRemainder.trim()) {
        options.onStderrLine?.(stderrRemainder);
      }
      stdoutRemainder = "";
      stderrRemainder = "";
    };

    if (options.signal) {
      abortHandler = () => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      };
      options.signal.addEventListener("abort", abortHandler, { once: true });
      if (options.signal.aborted) {
        abortHandler();
      }
    }

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutRemainder += String(chunk);
      const lines = stdoutRemainder.split(/\r?\n/);
      stdoutRemainder = lines.pop() ?? "";
      void Promise.all(lines.map((line) => emitStdoutLine(line))).catch((err) => {
        if (streamHandlerError) {
          return;
        }
        streamHandlerError = err;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      });
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrRemainder += String(chunk);
      const lines = stderrRemainder.split(/\r?\n/);
      stderrRemainder = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        options.onStderrLine?.(line);
      }
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", async (code) => {
      if (abortHandler && options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      try {
        await flushRemainder();
      } catch (err) {
        if (!streamHandlerError) {
          streamHandlerError = err;
        }
      }
      const exitCode = code ?? 0;
      if (streamHandlerError && !options.signal?.aborted) {
        reject(normalizeError(streamHandlerError));
        return;
      }
      if (exitCode !== 0 && !options.signal?.aborted) {
        reject(new Error(`${binary} ${args.join(" ")} exited with code ${exitCode}`));
        return;
      }
      resolve({ exitCode });
    });
  });
}
