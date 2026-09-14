import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where this instance keeps its state.
 *
 * A constant until the day the harness had to test its own product: then two gateways run
 * at once — the one doing the testing and the one being tested — and they must not share a
 * database, or a self-test that creates and deletes projects would be deleting the real
 * ones. `TP_DATA_DIR` is what keeps them apart.
 */
const __dirname = resolve(fileURLToPath(import.meta.url), "..");

export const DATA_DIR = process.env.TP_DATA_DIR
  ? resolve(process.env.TP_DATA_DIR)
  : resolve(__dirname, "..", ".data");

// Whoever opens a database first should not have to remember to create the directory.
mkdirSync(DATA_DIR, { recursive: true });

export const dataPath = (name: string): string => resolve(DATA_DIR, name);

/** Instances announce themselves, so a screenshot of the wrong one is recognisable. */
export const INSTANCE = process.env.TP_INSTANCE ?? "main";
