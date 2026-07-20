import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

const REPO_ROOT = new URL("../../../..", import.meta.url).pathname;

/** An OS-assigned free TCP port, same technique tests/black_box/common.rs
 * uses on the Rust side — avoids hardcoding ports that might collide with
 * another worker's spawned process. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("could not determine a free port")));
      }
    });
  });
}

export interface SpawnedDemo {
  baseUrl: string;
  stop: () => Promise<void>;
}

/** Spawns a second `demo` example process, mirroring `mise run demo-sibling`
 * (PORT/SIBLING_PORT env vars) — only siblings.spec.ts needs this; every
 * other spec shares the one server Playwright's webServer config starts
 * (see playwright.config.ts and the design doc §3 for why). */
export async function spawnDemo(opts: {
  port: number;
  siblingPort?: number;
}): Promise<SpawnedDemo> {
  const baseUrl = `http://localhost:${opts.port}`;
  const child: ChildProcess = spawn("cargo", ["run", "--example", "demo"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(opts.port),
      SIBLING_PORT: opts.siblingPort ? String(opts.siblingPort) : "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => (stdout += d.toString()));
  child.stderr?.on("data", (d) => (stderr += d.toString()));

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `demo process on port ${opts.port} exited early (code ${child.exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    try {
      const resp = await fetch(`${baseUrl}/health`);
      if (resp.ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (Date.now() >= deadline) {
    child.kill();
    throw new Error(`demo process on port ${opts.port} did not become healthy within 120s`);
  }

  return {
    baseUrl,
    stop: async () => {
      child.kill();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
      });
    },
  };
}
