// Host-provided configuration is fail-closed (`spec/protocol.md` §4).

export interface Limits {
  defaultPageSize?: number;
  maxPageSize?: number;
  queryTimeoutSecs?: number;
}

export interface ResolvedLimits {
  defaultPageSize: number;
  maxPageSize: number;
  queryTimeoutSecs: number;
}

const DEFAULT_LIMITS: ResolvedLimits = {
  defaultPageSize: 50,
  maxPageSize: 100,
  queryTimeoutSecs: 5,
};

export function withDefaults(limits: Limits | undefined): ResolvedLimits {
  return {
    defaultPageSize: limits?.defaultPageSize ?? DEFAULT_LIMITS.defaultPageSize,
    maxPageSize: limits?.maxPageSize ?? DEFAULT_LIMITS.maxPageSize,
    queryTimeoutSecs: limits?.queryTimeoutSecs ?? DEFAULT_LIMITS.queryTimeoutSecs,
  };
}

/** This instance's own name and label. Labels are opaque host strings: echoed, never parsed or acted on (`spec/protocol.md` §4). */
export interface Instance {
  name: string;
  label: string;
}

export interface Sibling {
  name: string;
  label?: string;
  baseUrl: string;
  healthPath: string;
}

export interface Config {
  /** Fail-closed unless the host enables it (`spec/protocol.md` §4). */
  enabled?: boolean;
  /** Mount point; undefined means "/__ashurbanipal" (spec/protocol.md §3). */
  basePath?: string;
  limits?: Limits;
  instance?: Instance;
  siblings?: Sibling[];
}

export function isEnabled(config: Config): boolean {
  return config.enabled ?? false;
}

export function basePath(config: Config): string {
  return config.basePath && config.basePath.length > 0 ? config.basePath : "/__ashurbanipal";
}

/** The sibling config after spec/protocol.md §5.6's corrections, which never reject it: each one is reported in `warnings`. */
export interface SiblingsView {
  instance?: Instance;
  siblings: Sibling[];
  warnings: string[];
}

export function siblingsView(config: Config): SiblingsView {
  const warnings: string[] = [];
  // Config may come from parsed JSON, so the types are checked, not assumed.
  const nonEmpty = (v: unknown) => typeof v === "string" && v !== "";
  let { instance } = config;
  if (instance && (!nonEmpty(instance.name) || !nonEmpty(instance.label))) {
    warnings.push("instance needs a non-empty name and label; ignored");
    instance = undefined;
  }
  const copies = new Map<string, number>();
  const siblings = (config.siblings ?? []).map((sibling) => {
    let s = sibling;
    if (s.label !== undefined && !nonEmpty(s.label)) {
      warnings.push(`sibling ${JSON.stringify(s.name)} has an empty or non-string label; treated as unlabelled`);
      const { label: _dropped, ...rest } = s;
      s = rest;
    }
    const key = JSON.stringify([s.name, s.label ?? null]);
    const n = (copies.get(key) ?? 0) + 1;
    copies.set(key, n);
    if (n === 2) {
      warnings.push(
        s.label === undefined
          ? `two siblings share the name ${JSON.stringify(s.name)} and no label`
          : `two siblings share the name ${JSON.stringify(s.name)} and the label ${JSON.stringify(s.label)}`,
      );
    }
    return s;
  });
  return { ...(instance && { instance }), siblings, warnings };
}

/** Whether `s` is this instance's own entry, which is reported healthy without a health check: it is serving the response. */
export function isInstance(instance: Instance | undefined, s: Sibling): boolean {
  return instance !== undefined && s.name === instance.name && s.label === instance.label;
}
