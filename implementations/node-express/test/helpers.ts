import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Router as ExpressRouter } from "express";
import express from "express";

// Shared by every integration test file that spins up a real HTTP server
// for a createRouter() result — schema.integration.test.ts, sources.test.ts,
// killswitch.test.ts each needed this same listen-on-ephemeral-port dance.
export interface TestServer {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startServer(router: ExpressRouter): Promise<TestServer> {
  const app = express();
  app.use(router);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function getJson(baseUrl: string, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`);
  const body = res.status === 200 ? await res.json() : await res.text();
  return { status: res.status, body };
}
