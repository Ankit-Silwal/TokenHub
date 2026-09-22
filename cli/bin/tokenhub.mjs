#!/usr/bin/env node
import { main } from "../src/main.mjs";
try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`TokenHub: ${error.message}`);
  process.exitCode = 1;
}
