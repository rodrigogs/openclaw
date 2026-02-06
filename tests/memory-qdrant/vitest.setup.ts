import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, afterEach, afterAll } from "vitest";

// Setup global test utilities
declare global {
  function loadFixture(filename: string): string;
  function writeTempFile(filename: string, content: string): string;
  function readTempFile(filename: string): string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const TEMP_DIR = path.join(__dirname, ".temp");

// Ensure directories exist
if (!fs.existsSync(FIXTURES_DIR)) {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
}

globalThis.loadFixture = (filename: string): string => {
  const filepath = path.join(FIXTURES_DIR, filename);
  if (!fs.existsSync(filepath)) {
    throw new Error(`Fixture not found: ${filename}`);
  }
  return fs.readFileSync(filepath, "utf-8");
};

globalThis.writeTempFile = (filename: string, content: string): string => {
  const filepath = path.join(TEMP_DIR, filename);
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, content, "utf-8");
  return filepath;
};

globalThis.readTempFile = (filename: string): string => {
  const filepath = path.join(TEMP_DIR, filename);
  if (!fs.existsSync(filepath)) {
    throw new Error(`Temp file not found: ${filename}`);
  }
  return fs.readFileSync(filepath, "utf-8");
};

// Setup
beforeEach(() => {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
});

// Cleanup
afterAll(() => {
  if (fs.existsSync(TEMP_DIR)) {
    try {
      fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }
});
