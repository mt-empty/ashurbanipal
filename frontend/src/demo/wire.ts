// Response helpers shared by the demos' page shims, the live worker, and the
// Node build tools — no DOM, so it loads in all three.

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const API_HEADERS = { "x-ashurbanipal-protocol": "1", "x-content-type-options": "nosniff" };

export function json(body: unknown, status = 200): ApiResponse {
  return {
    status,
    headers: { ...API_HEADERS, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}

// RFC 9457 problem details, as every port answers an error (spec/protocol.md §2).
export function problem(status: number, code: string, title: string): ApiResponse {
  return {
    status,
    headers: { ...API_HEADERS, "content-type": "application/problem+json; charset=utf-8" },
    body: JSON.stringify({ type: "about:blank", title, status, code }),
  };
}
