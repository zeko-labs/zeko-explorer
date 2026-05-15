import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { parse } from "yaml";

const root = join(import.meta.dirname, "../../..");

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function localValues() {
  return parse(read("infra/k8s/values/local/docker-desktop.kyaml"));
}

Given("Docker Desktop Kubernetes is enabled", function () {
  assert.equal(localValues().networkId, "zeko-m-local");
});

Given("the local stack is running", function () {
  assert.equal(localValues().networkId, "zeko-m-local");
});

When("a developer runs {string}", function (command) {
  this.command = command;
});

Then("NATS JetStream is running in namespace {string}", function (namespace) {
  assert.equal(namespace, "zeko-m-local");
  const nats = read("infra/k8s/chart/zeko-explorer/templates/nats.tpl");
  assert.match(nats, /kind:\s+StatefulSet/);
  assert.match(nats, /name:\s+nats/);
  assert.match(nats, /args:\s+\["-js"/);
});

Then("SurrealDB is running in namespace {string}", function (namespace) {
  assert.equal(namespace, "zeko-m-local");
  const surrealdb = read("infra/k8s/chart/zeko-explorer/templates/surrealdb.tpl");
  assert.match(surrealdb, /kind:\s+StatefulSet/);
  assert.match(surrealdb, /name:\s+surrealdb/);
});

Then("the Zeko Indexer is running in namespace {string}", function (namespace) {
  assert.equal(namespace, "zeko-m-local");
  assert.equal(localValues().workloads.zekoIndexer.enabled, true);
});

Then("the Explorer API is running in namespace {string}", function (namespace) {
  assert.equal(namespace, "zeko-m-local");
  assert.equal(localValues().workloads.explorerApi.enabled, true);
});

Then("the Bridge API is running in namespace {string}", function (namespace) {
  assert.equal(namespace, "zeko-m-local");
  assert.equal(localValues().workloads.bridgeApi.enabled, true);
});

Then("the L1 Watcher is disabled unless explicitly enabled", function () {
  assert.equal(localValues().workloads.l1Watcher.enabled, false);
});

Then("no DA Monitor workload is created", function () {
  assert.doesNotMatch(read("infra/k8s/chart/zeko-explorer/templates/apps.tpl"), /da-monitor/);
});

Then("{string} reaches the Explorer API", function (binding) {
  assert.equal(binding, "localhost:4101");
  assert.match(read("infra/local/docker-desktop/forward.sh"), /4101:4101/);
});

Then("{string} reaches the Bridge API", function (binding) {
  assert.equal(binding, "localhost:4102");
  assert.match(read("infra/local/docker-desktop/forward.sh"), /4102:4102/);
});

Then("{string} reaches NATS", function (binding) {
  assert.equal(binding, "localhost:4222");
  assert.match(read("infra/local/docker-desktop/forward.sh"), /4222:4222/);
});

Then("{string} reaches SurrealDB", function (binding) {
  assert.equal(binding, "localhost:8000");
  assert.match(read("infra/local/docker-desktop/forward.sh"), /8000:8000/);
});
