import { defineConfig } from "vitest/config";

// The env-loader smoke uses node:test; the package test script runs it separately.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
