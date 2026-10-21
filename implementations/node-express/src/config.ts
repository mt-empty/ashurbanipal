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

/** The instance/label rules of spec/protocol.md §5.6; throws on a violation. */
export function validateSiblings(config: Config): void {
  const { instance, siblings = [] } = config;
  // Config may come from parsed JSON, so the types are checked, not assumed.
  const nonEmpty = (v: unknown) => typeof v === "string" && v !== "";
  if (instance && (!nonEmpty(instance.name) || !nonEmpty(instance.label))) {
    throw new Error("instance needs a non-empty name and label");
  }
  const seen = new Set<string>();
  for (const s of siblings) {
    if (s.label !== undefined && !nonEmpty(s.label)) {
      throw new Error(`sibling ${JSON.stringify(s.name)} needs a non-empty string label, or none`);
    }
    const key = JSON.stringify([s.name, s.label ?? null]);
    if (seen.has(key)) throw new Error(`two siblings share the name ${JSON.stringify(s.name)} and the same label`);
    seen.add(key);
  }
}

/** Configuration order, minus the sibling that is this instance, which never probes itself. */
export function reportedSiblings(config: Config): Sibling[] {
  const { instance, siblings = [] } = config;
  return siblings.filter((s) => !(instance && s.name === instance.name && s.label === instance.label));
}
