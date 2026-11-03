import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

const runtimeTarget = `http://${process.env.TIDU_HOST ?? "127.0.0.1"}:${process.env.TIDU_RUNTIME_PORT ?? process.env.TIDU_PORT ?? "9639"}`;
const managerTarget = `http://127.0.0.1:${process.env.TIDU_MANAGER_PORT ?? process.env.TIDU_RUNTIME_PORT ?? process.env.TIDU_PORT ?? "9639"}`;

const loopbackHosts = new Set(["127.0.0.1", "[::1]", "localhost"]);
const createLocalProxy = (target: string): ProxyOptions => ({
  target,
  configure: (proxy) => {
    proxy.on("proxyReq", (outgoing, incoming) => {
      const origin = incoming.headers.origin;
      if (origin === undefined) return;
      let source: URL;
      try {
        source = new URL(origin);
      } catch {
        return;
      }
      if (
        source.origin !== origin ||
        source.protocol !== "http:" ||
        !loopbackHosts.has(source.hostname) ||
        source.host !== incoming.headers.host ||
        Number(source.port || "80") !== incoming.socket.localPort
      )
        return;
      // Translate only verified frontend same-origin requests to the upstream's own origin.
      const upstream = new URL(target);
      outgoing.setHeader("host", upstream.host);
      outgoing.setHeader("origin", upstream.origin);
    });
  },
});

export default defineConfig({
  root: fileURLToPath(new URL("./ui", import.meta.url)),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api/services": createLocalProxy(managerTarget),
      "/api": createLocalProxy(runtimeTarget),
      "/health": createLocalProxy(runtimeTarget),
      "/v1": createLocalProxy(runtimeTarget),
    },
  },
  build: {
    emptyOutDir: true,
    outDir: fileURLToPath(new URL("./dist/ui", import.meta.url)),
    target: ["es2015", "safari10"],
  },
});
