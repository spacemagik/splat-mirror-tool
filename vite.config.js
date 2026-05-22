import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    open: true,
    // Serve .spz files from the project root so the existing splat can auto-load
    fs: {
      allow: [".."],
    },
  },
  // Treat .spz as a static asset (served as-is, not parsed)
  assetsInclude: ["**/*.spz"],
});
