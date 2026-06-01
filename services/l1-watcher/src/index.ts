import { loadConfig } from "./config.ts";
import { describeL1Watcher } from "./service.ts";

const config = loadConfig();

console.log(JSON.stringify(describeL1Watcher(config), null, 2));
