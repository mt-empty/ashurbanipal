import type { Sibling } from "./config.js";

// Bounds each individual health check so one dead sibling can't stall the
// /api/siblings response (spec/protocol.md §5.6).
const SIBLING_TIMEOUT_MS = 3000;

export interface SiblingStatus {
  name: string;
  base_url: string;
  healthy: boolean;
}

// Resolves healthPath against baseUrl's origin (scheme + host + port),
// not its path — spec/protocol.md §5.6.
function siblingHealthUrl(baseUrl: string, healthPath: string): string | undefined {
  try {
    const parsed = new URL(baseUrl);
    return new URL(healthPath, parsed.origin).toString();
  } catch {
    return undefined;
  }
}

/**
 * Fans health checks out in parallel, one GET per sibling against its
 * resolved health URL. A check failure (network error, non-2xx, timeout,
 * unresolvable URL) yields healthy=false, never an error response
 * (spec/protocol.md §5.6).
 */
export async function checkSiblings(siblings: Sibling[]): Promise<SiblingStatus[]> {
  return Promise.all(
    siblings.map(async (sibling): Promise<SiblingStatus> => {
      const status: SiblingStatus = {
        name: sibling.name,
        base_url: sibling.baseUrl,
        healthy: false,
      };
      const healthUrl = siblingHealthUrl(sibling.baseUrl, sibling.healthPath);
      if (!healthUrl) return status;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SIBLING_TIMEOUT_MS);
      try {
        const res = await fetch(healthUrl, { signal: controller.signal });
        status.healthy = res.status >= 200 && res.status < 300;
      } catch {
        status.healthy = false;
      } finally {
        clearTimeout(timer);
      }
      return status;
    }),
  );
}
