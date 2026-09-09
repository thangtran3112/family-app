import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ExpenseTax Capture",
    short_name: "ExpenseTax",
    description: "Offline-first receipt capture and quick review.",
    start_url: "/capture",
    display: "standalone",
    background_color: "#08100f",
    theme_color: "#08100f",
    orientation: "any",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
