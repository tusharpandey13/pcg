import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["demo/**/*.demo.ts"], setupFiles: ["test/setup.ts"] } });
