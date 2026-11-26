// The optional Host allow-list against DNS rebinding (spec/protocol.md §3.1).

interface HostPort {
  /** Lowercased; an IPv6 literal keeps its brackets. */
  name: string;
  port?: number;
}

export interface HostAllowList {
  /** Undefined when `allowedHosts` is absent or empty: every Host passes. Entries that failed to parse are dropped, so a list of only bad entries is empty and rejects everything. */
  entries?: HostPort[];
  warnings: string[];
}

export function hostAllowList(configured: readonly string[] | string | undefined): HostAllowList {
  // Config may come from parsed JSON: a lone value is one entry, never iterated letter by letter.
  const hosts: readonly unknown[] =
    configured === undefined || configured === null ? [] : Array.isArray(configured) ? configured : [configured];
  if (hosts.length === 0) {
    return {
      warnings: [
        "allowed_hosts is not set, so any Host header is accepted and a DNS-rebinding page can read the viewer (spec/protocol.md §3.1)",
      ],
    };
  }
  const entries: HostPort[] = [];
  const warnings: string[] = [];
  for (const entry of hosts) {
    const parsed = typeof entry === "string" ? parseHostPort(entry) : undefined;
    if (parsed) {
      entries.push(parsed);
    } else {
      warnings.push(
        `allowed_hosts entry ${JSON.stringify(entry)} is not a host name with an optional port, so it matches nothing`,
      );
    }
  }
  return { entries, warnings };
}

/** `host` is the raw Host header or HTTP/2 :authority, never a forwarded header; with the check on, a missing or malformed one is rejected. */
export function allowsHost(list: HostAllowList, host: string | undefined): boolean {
  if (!list.entries) return true;
  const req = host === undefined ? undefined : parseHostPort(host);
  if (!req) return false;
  return list.entries.some((e) => e.name === req.name && (e.port === undefined || e.port === req.port));
}

const IPV6 = /^\[[0-9a-fA-F:.]+\]$/;
const REG_NAME = /^[A-Za-z0-9._-]+$/;
const PORT = /^[0-9]{1,5}$/;

/** `name` or `name:port`, with an IPv6 literal in brackets; one trailing dot on the name is dropped. No scheme, path, userinfo or wildcard. */
function parseHostPort(text: string): HostPort | undefined {
  let name: string;
  let port: string | undefined;
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end < 0) return undefined;
    name = text.slice(0, end + 1);
    const rest = text.slice(end + 1);
    if (!IPV6.test(name)) return undefined;
    if (rest !== "") {
      if (!rest.startsWith(":")) return undefined;
      port = rest.slice(1);
    }
  } else {
    const colon = text.indexOf(":");
    name = colon < 0 ? text : text.slice(0, colon);
    port = colon < 0 ? undefined : text.slice(colon + 1);
    // billing.internal. is the same DNS name as billing.internal.
    if (name.endsWith(".")) name = name.slice(0, -1);
    if (!REG_NAME.test(name)) return undefined;
  }
  if (port === undefined) return { name: name.toLowerCase() };
  if (!PORT.test(port) || Number(port) > 65535) return undefined;
  return { name: name.toLowerCase(), port: Number(port) };
}
