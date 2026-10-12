import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./ui", import.meta.url)),
  plugins: [react()],
  build: {
    emptyOutDir: true,
    outDir: fileURLToPath(new URL("./dist/ui", import.meta.url)),
    target: ["es2015", "safari10"],
  },
});
