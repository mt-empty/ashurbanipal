import type { Sibling, SiblingInstance, SiblingsResponse } from "../core/types.js";

// One cell of the service × label grid.
export type MatrixCell =
  | { kind: "here" }
  | { kind: "missing" }
  // `sameView`: this service in another label, so the link carries the current view.
  | { kind: "link"; sibling: Sibling; sameView: boolean };

export interface SiblingMatrix {
  labels: string[];
  // The instance's own label, so its column can be marked; null without one.
  ownLabel: string | null;
  rows: { name: string; isInstance: boolean; cells: MatrixCell[] }[];
  // Siblings without a label, listed under the grid.
  unlabelled: Sibling[];
}

type Labelled = Sibling & { label: string };

export function isOwnEntry(instance: SiblingInstance | undefined, s: Sibling): boolean {
  return instance !== undefined && s.name === instance.name && s.label === instance.label;
}

// Rows and columns follow first appearance in `siblings`, so every instance
// sharing one list shows the same grid; an instance its own list leaves out
// goes first. null when nothing is labelled: the caller keeps the flat list.
export function buildSiblingMatrix({ instance, siblings }: SiblingsResponse): SiblingMatrix | null {
  const labelled = siblings.filter((s): s is Labelled => s.label !== undefined);
  if (!instance && labelled.length === 0) return null;

  const labels = [...new Set(labelled.map((s) => s.label))];
  const names = [...new Set(labelled.map((s) => s.name))];
  if (instance && !labels.includes(instance.label)) labels.unshift(instance.label);
  if (instance && !names.includes(instance.name)) names.unshift(instance.name);

  const rows = names.map((name) => {
    const isInstance = instance?.name === name;
    const cells = labels.map((label): MatrixCell => {
      if (isInstance && instance?.label === label) return { kind: "here" };
      const sibling = labelled.find((s) => s.name === name && s.label === label);
      return sibling ? { kind: "link", sibling, sameView: isInstance } : { kind: "missing" };
    });
    return { name, isInstance, cells };
  });
  return {
    labels,
    ownLabel: instance?.label ?? null,
    rows,
    unlabelled: siblings.filter((s) => s.label === undefined),
  };
}

// A link to the same view elsewhere: the target's base plus this page's query
// parameters, which already hold source, schema, table, filter and sort. The
// page is served at exactly the mount, so a trailing slash on base_url is
// dropped; any query or fragment base_url already has is kept.
export function sameViewHref(baseUrl: string, search: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return baseUrl;
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  for (const [key, value] of new URLSearchParams(search)) url.searchParams.set(key, value);
  return url.toString();
}
