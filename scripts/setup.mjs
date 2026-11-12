#!/usr/bin/env node
// npm bin wrapper: execute through global-bin symlinks as well as direct paths.
import { main } from "./register.mjs";
const args = process.argv.slice(2);
if (args[0] === "register") args.shift();
main(args).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
