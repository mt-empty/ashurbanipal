// The demos' /api/siblings answer: labelled, so they show the service × label
// grid (spec/protocol.md §5.6). Hosts are example.com (RFC 2606), never real.

export const SIBLINGS_INSTANCE = { name: "shop (demo)", label: "dev" };
export const SIBLINGS = [
  { name: "shop (demo)", label: "dev", base_url: "https://shop-dev.example.com/__ashurbanipal", healthy: true },
  { name: "shop (demo)", label: "int", base_url: "https://shop-int.example.com/__ashurbanipal", healthy: true },
  { name: "billing (demo)", label: "dev", base_url: "https://billing-dev.example.com/__ashurbanipal", healthy: true },
  { name: "billing (demo)", label: "int", base_url: "https://billing-int.example.com/__ashurbanipal", healthy: true },
  {
    name: "notifications (demo)",
    label: "dev",
    base_url: "https://notifications-dev.example.com/__ashurbanipal",
    healthy: false,
  },
  ...["search", "analytics", "inventory"].flatMap((service) =>
    ["dev", "int"].map((label) => ({
      name: `${service} (demo)`,
      label,
      base_url: `https://${service}-${label}.example.com/__ashurbanipal`,
      healthy: false,
    })),
  ),
];
