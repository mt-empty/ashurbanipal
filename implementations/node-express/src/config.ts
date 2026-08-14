// Config mirrors the Rust reference's TOML config as a plain object the
// host populates however it likes (env vars, its own config loader) —
// this module imposes no file format.
//
// The empty/undefined case MUST mean disabled: an absent `enabledFor`
// (or a Config the host never constructs at all) means IsEnabled() is
// false regardless of `environment` (spec/protocol.md §4).

// Compared case-insensitively; "production" itself is deliberately
// unrepresentable in EnabledFor — validate() rejects it at construction
// time rather than letting it reach a running server.
const PRODUCTION_ALIASES = ["production", "prod", "prd", "live"];

export function isProductionLike(value: string): boolean {
  const lower = value.toLowerCase();
  return PRODUCTION_ALIASES.includes(lower);
}

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
  environment?: string;
  /** Allow-list of environments the viewer is enabled for. Undefined/empty means disabled everywhere. */
  enabledFor?: string[];
  /** Mount point; undefined means "/__ashurbanipal" (spec/protocol.md §3). */
  basePath?: string;
  limits?: Limits;
  siblings?: Sibling[];
}

/** Thrown by validate()/createRouter() when enabledFor names a production-like value. */
export class ProductionEnabledError extends Error {
  constructor(public readonly value: string) {
    super(`ashurbanipal must never be enabled in production: enabledFor contains "${value}"`);
    this.name = "ProductionEnabledError";
  }
}

/**
 * Rejects a production-like value in enabledFor. createRouter() calls this
 * itself; a host constructing Config outside createRouter (e.g. to inspect
 * isEnabled before merging routes) should call it too.
 */
export function validateConfig(config: Config): void {
  for (const value of config.enabledFor ?? []) {
    if (isProductionLike(value)) {
      throw new ProductionEnabledError(value);
    }
  }
}

/**
 * Reports whether the viewer is enabled for the configured environment. A
 * production-like environment is always disabled, regardless of
 * enabledFor (including "any") — spec/protocol.md §4.
 */
export function isEnabled(config: Config): boolean {
  const environment = config.environment ?? "";
  if (isProductionLike(environment)) {
    return false;
  }
  for (const enabled of config.enabledFor ?? []) {
    if (enabled.toLowerCase() === "any" || enabled.toLowerCase() === environment.toLowerCase()) {
      return true;
    }
  }
  return false;
}

export function basePath(config: Config): string {
  return config.basePath && config.basePath.length > 0 ? config.basePath : "/__ashurbanipal";
}
