import type { Sibling, SiblingsResponse } from "../core/types.js";

// One cell of the service × label grid.
export type MatrixCell =
  | { kind: "here" }
  | { kind: "missing" }
  // `sameView`: this service in another label, so the link carries the current view.
  | { kind: "link"; sibling: Sibling; sameView: boolean };

export interface SiblingMatrix {
  labels: string[];
  rows: { name: string; isInstance: boolean; cells: MatrixCell[] }[];
  // Siblings without a label, listed under the grid as before.
  unlabelled: Sibling[];
}

// null when nothing is labelled: the caller keeps the flat list.
export function buildSiblingMatrix({ instance, siblings }: SiblingsResponse): SiblingMatrix | null {
  const labelled = siblings.filter((s) => s.label !== undefined);
  if (!instance && labelled.length === 0) return null;

  const labels: string[] = instance ? [instance.label] : [];
  const names: string[] = instance ? [instance.name] : [];
  for (const s of labelled) {
    if (!labels.includes(s.label as string)) labels.push(s.label as string);
    if (!names.includes(s.name)) names.push(s.name);
  }

  const rows = names.map((name) => {
    const isInstance = instance?.name === name;
    const cells = labels.map((label): MatrixCell => {
      if (isInstance && instance?.label === label) return { kind: "here" };
      const sibling = labelled.find((s) => s.name === name && s.label === label);
      return sibling ? { kind: "link", sibling, sameView: isInstance } : { kind: "missing" };
    });
    return { name, isInstance, cells };
  });
  return { labels, rows, unlabelled: siblings.filter((s) => s.label === undefined) };
}

// A link to the same view elsewhere: the target's base plus this page's query
// string, which already holds source, schema, table, filter and sort. The page
// is served at exactly the mount, so a trailing slash on base_url is dropped.
export function sameViewHref(baseUrl: string, search: string): string {
  return baseUrl.replace(/\/+$/, "") + search;
}
