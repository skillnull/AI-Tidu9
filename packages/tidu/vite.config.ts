import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./ui", import.meta.url)),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: `http://${process.env.TIDU_HOST ?? "127.0.0.1"}:${process.env.TIDU_PORT ?? "9639"}`,
      },
    },
  },
  build: {
    emptyOutDir: true,
    outDir: fileURLToPath(new URL("./dist/ui", import.meta.url)),
    target: ["es2015", "safari10"],
  },
});
