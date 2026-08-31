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

export interface Sibling {
  name: string;
  baseUrl: string;
  healthPath: string;
}

export interface Config {
  /** Fail-closed unless the host enables it (`spec/protocol.md` §4). */
  enabled?: boolean;
  /** Mount point; undefined means "/__ashurbanipal" (spec/protocol.md §3). */
  basePath?: string;
  limits?: Limits;
  siblings?: Sibling[];
}

export function isEnabled(config: Config): boolean {
  return config.enabled ?? false;
}

export function basePath(config: Config): string {
  return config.basePath && config.basePath.length > 0 ? config.basePath : "/__ashurbanipal";
}
