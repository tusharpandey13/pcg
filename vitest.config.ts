import { defineConfig } from "vitest/config";
// Every test gets a temp agent dir: the governor writes its history there, never to the real ~/.pi.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], setupFiles: ["test/setup.ts"] } });
