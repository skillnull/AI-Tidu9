import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const runtimeTarget = `http://${process.env.TIDU_HOST ?? "127.0.0.1"}:${process.env.TIDU_RUNTIME_PORT ?? process.env.TIDU_PORT ?? "9639"}`;
const managerTarget = `http://127.0.0.1:${process.env.TIDU_MANAGER_PORT ?? process.env.TIDU_RUNTIME_PORT ?? process.env.TIDU_PORT ?? "9639"}`;

export default defineConfig({
  root: fileURLToPath(new URL("./ui", import.meta.url)),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api/services": {
        target: managerTarget,
      },
      "/api": {
        target: runtimeTarget,
      },
      "/health": {
        target: runtimeTarget,
      },
      "/v1": {
        target: runtimeTarget,
      },
    },
  },
  build: {
    emptyOutDir: true,
    outDir: fileURLToPath(new URL("./dist/ui", import.meta.url)),
    target: ["es2015", "safari10"],
  },
});
