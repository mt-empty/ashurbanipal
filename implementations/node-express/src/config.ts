// Config mirrors the Rust reference's TOML config as a plain object the
// host populates however it likes (env vars, its own config loader) —
// this module imposes no file format.
//
// The empty/undefined case MUST mean disabled: an absent `enabled` (or a
// Config the host never constructs at all) means isEnabled() is false.
// Ashurbanipal has zero opinion on what environment it's running in —
// that decision is entirely the host's (spec/protocol.md §4).

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

export interface Sibling {
  name: string;
  dbviewerUrl: string;
  healthPath: string;
}

export interface Config {
  /** Off unless the host sets this explicitly; undefined means disabled. */
  enabled?: boolean;
  /** Mount point; undefined means "/__ashurbanipal" (spec/protocol.md §3). */
  basePath?: string;
  limits?: Limits;
  siblings?: Sibling[];
}

/** Reports whether the viewer is enabled — a bare passthrough of `config.enabled`. */
export function isEnabled(config: Config): boolean {
  return config.enabled ?? false;
}

export function basePath(config: Config): string {
  return config.basePath && config.basePath.length > 0 ? config.basePath : "/__ashurbanipal";
}
