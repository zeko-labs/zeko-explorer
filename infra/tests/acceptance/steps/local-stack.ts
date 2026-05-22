import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { parse } from "yaml";

const root = join(import.meta.dirname, "../../../..");

type LocalValues = {
  networkId: string;
  workloads: {
    bridgeApi: { enabled: boolean };
    explorerApi: { enabled: boolean };
    l1Watcher: { enabled: boolean };
    zekoIndexer: { enabled: boolean };
  };
};

const read = (path: string): string => {
  return readFileSync(join(root, path), "utf8");
};

const localValues = (): LocalValues => {
  return parse(read("infra/k8s/values/local/docker-desktop.kyaml")) as LocalValues;
};

Given("Docker Desktop Kubernetes is enabled", () => {
  assert.equal(localValues().networkId, "zeko-m-local");
});

Given("the local stack is running", () => {
  assert.equal(localValues().networkId, "zeko-m-local");
});

When("a developer runs {string}", (command: string) => {
  assert.match(command, /^moon run infra:/);
});

Then("NATS JetStream is running in namespace {string}", (namespace: string) => {
  assert.equal(namespace, "zeko-m-local");
  const nats = read("infra/k8s/chart/zeko-explorer/templates/nats.tpl");
  assert.match(nats, /kind:\s+StatefulSet/);
  assert.match(nats, /name:\s+nats/);
  assert.match(nats, /args:\s+\["-js"/);
});

Then("SurrealDB is running in namespace {string}", (namespace: string) => {
  assert.equal(namespace, "zeko-m-local");
  const surrealdb = read("infra/k8s/chart/zeko-explorer/templates/surrealdb.tpl");
  assert.match(surrealdb, /kind:\s+StatefulSet/);
  assert.match(surrealdb, /name:\s+surrealdb/);
});

Then("the Zeko Indexer is running in namespace {string}", (namespace: string) => {
  assert.equal(namespace, "zeko-m-local");
  assert.equal(localValues().workloads.zekoIndexer.enabled, true);
});

Then("the Explorer API is running in namespace {string}", (namespace: string) => {
  assert.equal(namespace, "zeko-m-local");
  assert.equal(localValues().workloads.explorerApi.enabled, true);
});

Then("the Bridge API is running in namespace {string}", (namespace: string) => {
  assert.equal(namespace, "zeko-m-local");
  assert.equal(localValues().workloads.bridgeApi.enabled, true);
});

Then("the L1 Watcher is disabled unless explicitly enabled", () => {
  assert.equal(localValues().workloads.l1Watcher.enabled, false);
});

Then("no DA Monitor workload is created", () => {
  assert.doesNotMatch(read("infra/k8s/chart/zeko-explorer/templates/apps.tpl"), /da-monitor/);
});

Then("{string} reaches the Explorer API", (binding: string) => {
  assert.equal(binding, "localhost:4101");
  assert.match(read("infra/local/docker-desktop/forward.nu"), /4101:4101/);
});

Then("{string} reaches the Bridge API", (binding: string) => {
  assert.equal(binding, "localhost:4102");
  assert.match(read("infra/local/docker-desktop/forward.nu"), /4102:4102/);
});

Then("{string} reaches NATS", (binding: string) => {
  assert.equal(binding, "localhost:4222");
  assert.match(read("infra/local/docker-desktop/forward.nu"), /4222:4222/);
});

Then("{string} reaches SurrealDB", (binding: string) => {
  assert.equal(binding, "localhost:8000");
  assert.match(read("infra/local/docker-desktop/forward.nu"), /8000:8000/);
});
