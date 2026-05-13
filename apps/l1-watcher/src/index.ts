import { loadConfig } from "./config";
import { describeL1Watcher } from "./service";

const config = loadConfig();

console.log(JSON.stringify(describeL1Watcher(config), null, 2));
