import { loadConfig } from "./config.js";
import { describeL1Watcher } from "./service.js";

const config = loadConfig();

console.log(JSON.stringify(describeL1Watcher(config), null, 2));
