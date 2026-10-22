import { existsSync } from "node:fs";

if (existsSync(".env.test")) process.loadEnvFile(".env.test");

const url = process.env.DATABASE_URL ?? "";
if (!/_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run tests: DATABASE_URL must point at a *_test database (got "${url}")`);
}
