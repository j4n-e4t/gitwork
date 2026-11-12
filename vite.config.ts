import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "web/src") } },
  build: { outDir: "../dist", emptyOutDir: true },
  // /auth must go through the proxy too, so the OAuth callback lands on the API server with the dev origin.
  server: { proxy: Object.fromEntries(["/api", "/auth"].map((p) => [p, `http://localhost:${process.env.PORT ?? 8787}`])) },
});
