# Spike 004: Production Deployment Topology - Results

**Status:** Revised results
**Date:** 2026-04-19

---

## Decision

Use **Kubernetes from the beginning** for server-side explorer workloads. Provision Hetzner clusters with **Terraform + Talos**, bootstrap **FluxCD + Flux Operator**, and let Flux reconcile remote Kubernetes workloads from Git-pinned image tags.

Primary infrastructure module: [`hcloud-k8s/terraform-hcloud-kubernetes`](https://github.com/hcloud-k8s/terraform-hcloud-kubernetes).

Reason: it is the more complete module for this use case. It provisions a production-oriented Talos Kubernetes cluster on Hetzner and includes the cluster pieces we would otherwise need to assemble ourselves: Talos, Hetzner CCM/CSI, Cilium, Gateway API, cert-manager, metrics-server, Longhorn, autoscaling support, firewalling, placement groups, and backup hooks.

Alternative module: [`hcloud-talos/terraform-hcloud-talos`](https://github.com/hcloud-talos/terraform-hcloud-talos). Use it only if we decide to manage more Kubernetes add-ons ourselves.

Use a **service repo plus org-level Kubernetes repo boundary**:

- `zeko-explorer` service repo for application code, local Kubernetes, reusable deployment contracts, CI image builds, and Cloudflare Worker/static asset code;
- private `zeko-k8s` repo for Terraform environments, Flux cluster roots, platform add-ons, app environment values, Cloudflare private routing resources, and production promotion state across Zeko services.

Reason: the explorer should be the first tenant of the org-level Kubernetes operating model, not an isolated deployment island. `zeko-k8s` gives the rest of the org a clear landing zone for future Kubernetes workloads without pre-allocating directories or ownership for services that are not part of this spike. Production infrastructure config is not a secret, but it is operationally sensitive; host topology, internal route names, tunnel routing, bucket names, NATS publish endpoints, DA/sequencer handoff config, and promotion state belong in the dedicated Kubernetes repo.

Diagrams:

- [development](./diagrams/development.html)
- [single-host zeko-m-alphanet](./diagrams/single-host.html)
- [multi-host zeko-m-devnet / zeko-m-mainnet](./diagrams/multi-host.html)

Addendums:

- [FluxCD deployment model](./addendums/gitops/flux.md)
- [ArgoCD deployment model](./addendums/gitops/argocd.md), retained as an evaluated alternative

---

## Network Topology

The PRD defines separate Zeko network instances. Each network gets its own full explorer stack: NATS, SurrealDB, indexer, watchers, APIs, jobs, and Cloudflare routes.

| Network family | Network ID | Settlement layer | Deployment target |
|---|---|---|---|
| Zeko-M | `zeko-m-local` | local/dev dependencies | Docker Desktop Kubernetes |
| Zeko-M | `zeko-m-devnet` | Mina devnet | multi-host `zeko-m-mainnet` rehearsal cluster |
| Zeko-M | `zeko-m-alphanet` | Mina devnet | single-host `zeko-m-alphanet` cluster |
| Zeko-M | `zeko-m-mainnet` | Mina mainnet | multi-host `zeko-m-mainnet` cluster |
| Zeko-E | `zeko-e-testnet` | Ethereum testnet | out of scope for this spike until Zeko-E work starts |
| Zeko-E | `zeko-e-mainnet` | Ethereum mainnet | future separate multi-host `zeko-e-mainnet` cluster |

Default isolation model: **one Kubernetes cluster per network**.

Production should not share NATS or SurrealDB across networks.

---

## Local Development

Use **Docker Desktop with Kubernetes enabled** as the default local environment.

This is opinionated on purpose. It keeps the local model close to production without asking every developer to run Talos locally.

Local requirements:

- Docker Desktop;
- Kubernetes enabled in Docker Desktop;
- `kubectl`;
- `helm`;
- `moon`;
- `proto`;
- local image builds through Docker BuildKit;
- optional `nats` and `surreal` CLIs for debugging.

Local cluster shape:

| Namespace | Purpose |
|---|---|
| `zeko-explorer-system` | shared dev helpers, optional ESO mock/secrets adapter |
| `zeko-m-local` | default local network stack |

Local workloads for `zeko-m-local`:

| Workload | Kubernetes primitive | Local behavior |
|---|---|---|
| NATS JetStream | StatefulSet + PVC | single replica; streams created by setup Job |
| SurrealDB | StatefulSet + PVC | single replica; migrations run as Job |
| Zeko Indexer | Deployment, 1 replica | consumes local NATS and writes SurrealDB |
| L1 Watcher | Deployment, disabled in base local values | opt-in integration workload; points at configured Mina endpoints |
| DA Monitor | Deployment, disabled in base local values | opt-in integration workload; points at configured DA node endpoints |
| Backfill Service | Deployment, disabled in base local values | opt-in integration workload built from `zeko`; calls configured DA node endpoints |
| Explorer API | Deployment + Service | reads SurrealDB; supports SSE |
| Bridge API | Deployment + Service | reads SurrealDB; supports SSE |
| Frontend | local dev server | Nuxt local dev during Milestone 2; production deploys to Cloudflare, not Kubernetes |
| Hive Gateway Worker | `wrangler dev` | runs outside cluster and calls port-forwarded Explorer/Bridge APIs |
| MCP Worker | `wrangler dev` | runs outside cluster and calls the local Hive Gateway Worker |

Local commands should converge on:

```text
moon run infra:build-local-images
moon run infra:k8s-local-up
moon run infra:k8s-local-forward
moon run infra:dev
```

`moon run infra:k8s-local-forward` should establish explicit local bindings, for example:

- `localhost:4101 -> service/explorer-api`;
- `localhost:4102 -> service/bridge-api`;
- `localhost:4222 -> service/nats`, only when local debugging needs direct NATS access;
- `localhost:8000 -> service/surrealdb`, only when local debugging needs direct DB access.

Wrangler uses those local URLs for the Hive Gateway and MCP Worker. Local development does not create a separate API routing layer.

Package-level tests may start only the dependencies they need, for example NATS and SurrealDB without the full cluster. The default developer workflow remains Docker Desktop Kubernetes.

Local resource target:

- default local mode should fit inside **4 CPU and 6 GB RAM** allocated to Docker Desktop;
- L1 Watcher, DA Monitor, and Backfill are opt-in profiles;
- NATS and SurrealDB use small local memory limits and short local retention;
- the frontend should normally run as a local Nuxt dev process, not inside Kubernetes;
- CI should not require Docker Desktop Kubernetes or a full local cluster. Keep CI focused on unit tests, type checks, package-level integration tests with only the dependencies they need, image builds, and deploy-time smoke jobs against real environments.

---

## CI And Build Artifacts

All server-side workloads that run in Kubernetes must be built through GitHub Actions and published as OCI images before deployment.

Kubernetes workload images:

- `l1-watcher`;
- `da-monitor`;
- `zeko-indexer`;
- `explorer-api`;
- `bridge-api`;
- Backfill Service image built from the `zeko` repo source/binary, because it is part of the explorer deployment even though its code belongs in `zeko`.

Kubernetes Jobs and CronJobs:

- schema migration Job: runs the service repo DB migration entrypoint;
- NATS stream setup Job: runs the service repo deploy script that creates the PRD-defined streams and subjects idempotently;
- R2 archival CronJob: runs the archival script for expired NATS history;
- SurrealDB export CronJob: wraps `surreal export` and uploads the result to the network-specific R2 path.

These are deployment tasks, not long-running services. They should reuse a small ops image only if running the script inside Kubernetes requires one.

Not container images:

- production frontend: built by CI and deployed to Cloudflare Workers Static Assets with Wrangler;
- Hive Gateway: built by CI and deployed as a Cloudflare Worker;
- MCP Server: built by CI and deployed as a Cloudflare Worker;
The rule is: Kubernetes workloads use OCI images; Cloudflare workloads use Wrangler artifacts; repo scripts do not need images unless they run inside Kubernetes.

Registry decision:

- Use **Docker Hub** for the initial implementation unless the org already has a GCR/Artifact Registry project ready.
- Image names should be environment-independent, for example `zeko/explorer-api`.
- Tags:
  - immutable commit SHA tag for all deployments;
  - optional branch tag for preview environments;
  - semver tag for releases.
- Kubernetes values must reference immutable SHA tags, not `latest`.

GitHub Actions workflows:

| Workflow | Trigger | Responsibility |
|---|---|---|
| `ci.yml` | service repo PR | lint, typecheck, unit tests, build images without pushing |
| `images.yml` | service repo merge to main / tag | build Kubernetes workload images and push to Docker Hub or GCR |
| `terraform-plan.yml` | `zeko-k8s` PR touching `infra/terraform/**` | Terraform plan for affected environment |
| `terraform-apply.yml` | `zeko-k8s` manual approval / protected branch | Terraform apply through GitHub Actions |
| `promote.yml` | image release / manual | open or update `zeko-k8s` promotion PRs with pinned image tags |
| `cloudflare.yml` | service repo frontend/gateway/MCP changes | Wrangler deploy for frontend, Hive Gateway Worker, and MCP Worker |

GitHub Actions secrets are sufficient for bootstrap. Keep infrastructure provider credentials in `zeko-k8s` environments. Service repos should only have registry and Cloudflare Worker deploy credentials needed for image and Worker/static asset publishing. For Kubernetes runtime secrets use Infisical + External Secrets Operator when available.

Remote Kubernetes deployment is Flux-driven. GitHub Actions builds images in service repos. Promotion is a `zeko-k8s` workflow that opens or updates PRs with Git-pinned image tags; Flux reconciles those changes into the cluster after merge. GitHub Actions should not run `helm upgrade` for remote environments.

---

## Cloudflare, Gateway, And Private API Routing

Cloudflare is not an afterthought. It owns the public edge. Explorer and Bridge APIs are **not directly exposed to the public internet**.

Use a unified gateway pattern:

- Explorer API and Bridge API are private Kubernetes services.
- Hive Gateway runs as a Cloudflare Worker.
- Contract Registry API runs as a Cloudflare Worker backed by Cloudflare KV.
- The gateway Worker composes Explorer, Bridge, and Contract Registry schemas into one public graph.
- Build the composed graph with GraphQL Mesh.
- Run the public graph with GraphQL Hive Gateway on Cloudflare Workers.
- Apply public rate limiting, WAF, CORS, bot protection, request size limits, and auth policy once at Cloudflare/gateway level.
- Keep per-service internal auth between gateway and subgraphs.

Private Cloudflare Tunnel routing:

- Use `cloudflare-kubernetes-gateway` as the Kubernetes Cloudflare Tunnel controller.
- Reason: it uses Gateway API resources, matching the Kubernetes direction of the rest of the stack, and avoids introducing an Ingress-only model we would later replace.
- The controller creates Cloudflare Tunnel routes for private subgraph services.
- Subgraph hostnames are not public API products; they are only for the gateway Worker.
- Protect subgraph routes with Cloudflare Access service tokens or equivalent service authentication.

| Component | Runs where | Deployment path | Public route |
|---|---|---|---|
| Explorer API | Kubernetes private Service | FluxCD from Git-pinned image tags | none |
| Bridge API | Kubernetes private Service | FluxCD from Git-pinned image tags | none |
| Contract Registry API | Cloudflare Worker + KV | Wrangler from GitHub Actions | none |
| Hive Gateway | Cloudflare Worker | Wrangler from GitHub Actions | `api.<network>.explorer.zeko.io` |
| Frontend | Cloudflare Workers Static Assets | Wrangler from GitHub Actions | `<network>.explorer.zeko.io` |
| MCP Server | Cloudflare Worker | Wrangler from GitHub Actions | `mcp.<network>.explorer.zeko.io` |
| R2 archival bucket | Cloudflare R2 | Terraform or Wrangler/API | private bucket per network |

Request flow:

1. User or agent calls Cloudflare route.
2. Cloudflare handles TLS, WAF/rate limits, CORS, bot protections, and caching where safe.
3. `api.<network>.explorer.zeko.io` invokes the Hive Gateway Worker.
4. Hive Gateway fetches the private Explorer and Bridge subgraphs through Cloudflare Tunnel routes and resolves `contractSchema` against the Contract Registry Worker through an internal Worker route or service binding when the query requires it.
5. `cloudflared` inside the cluster forwards Explorer and Bridge requests to the private Kubernetes Services.
6. Explorer API and Bridge API return subgraph responses to Hive Gateway.
7. Contract Registry API returns the schema response directly to Hive Gateway without traversing Cloudflare Tunnel.
8. Hive Gateway returns the unified response to the client.

Origin protection:

- Do not publish Explorer API or Bridge API as public Hetzner endpoints.
- Cloudflare Tunnel is the private API routing path.
- Explorer API and Bridge API Services must not have public routes.
- Hive Gateway should forward only approved headers to subgraphs.
- API containers still enforce internal service auth and validation, but public rate limiting should live at Cloudflare/gateway level.

MCP Worker:

- Runs on Cloudflare, not Kubernetes.
- Calls the public Hive Gateway route or shares the same internal gateway code path if needed.
- Uses an internal service token/header for elevated MCP access if needed.
- Gets schema/SDK artifacts from CI, generated from the API schemas at the same commit.

Frontend:

- Runs on Cloudflare Workers Static Assets.
- Uses network-specific API URLs from build/runtime config.
- Does not talk to NATS or SurrealDB directly.
- Is not shipped as a production container image.

R2:

- Stores NATS archival exports and optional SurrealDB exports.
- One bucket or prefix per network.
- Kubernetes CronJobs write using scoped R2 credentials from ESO/GitHub Actions bootstrap.

---

## Production Infrastructure

### Terraform Module Choice

Use `hcloud-k8s/terraform-hcloud-kubernetes` first.

Reasons:

- production-oriented Talos module;
- built-in Hetzner CCM/CSI integration;
- Cilium and Gateway API support;
- cert-manager support;
- Longhorn support;
- metrics-server support;
- cluster autoscaler support;
- placement groups and firewall primitives;
- supports HA node pools.

Keep `hcloud-talos/terraform-hcloud-talos` as a fallback if the team wants a smaller module and is willing to own more add-on composition.

### Repository Layout

Use service repos for reusable application deployment contracts and `zeko-k8s` for environment instantiation.

`zeko-explorer` service repo:

```text
packages/
  nats-protocol/
  domain/
  db/
  contract-schema/
apps/
  l1-watcher/
  da-monitor/
  zeko-indexer/
  explorer-api/
  bridge-api/
  contract-registry-api/
  frontend/
  hive-gateway/
  mcp-worker/
tests/
  acceptance/
  test-data/
infra/
  k8s/
    chart/
      zeko-explorer/
    values/
      local/
  local/
    docker-desktop/
      kustomization.yaml
      values.yaml
  scripts/
    nats-stream-setup/
    surrealdb-migrate/
.github/
  workflows/
    ci.yml
    images.yml
    cloudflare.yml
```

Private `zeko-k8s` repo:

```text
infra/
  terraform/
    modules/
      hcloud-zeko-cluster/
    envs/
      zeko-m-alphanet/
      zeko-m-devnet/
      zeko-m-mainnet/
      zeko-e-testnet/
      zeko-e-mainnet/
  gitops/
    flux/
      clusters/
        zeko-m-alphanet/
          flux-system/
          flux-instance.yaml
          sources.yaml
          kustomizations.yaml
          values.yaml
        zeko-m-devnet/
          flux-system/
          flux-instance.yaml
          sources.yaml
          kustomizations.yaml
          values.yaml
        zeko-m-mainnet/
          flux-system/
          flux-instance.yaml
          sources.yaml
          kustomizations.yaml
          values.yaml
      apps/
        platform/
          external-secrets/
          cloudflare-tunnel/
        explorer/
          nats/
          surrealdb/
          workloads/
          values/
            zeko-m-alphanet.yaml
            zeko-m-devnet.yaml
            zeko-m-mainnet.yaml
.github/
  workflows/
    terraform-plan.yml
    terraform-apply.yml
    promote.yml
```

`zeko-k8s` references service artifacts by immutable image SHA and chart version/path. It owns environment-specific values, Cloudflare Tunnel routes, NATS publish endpoints, DA endpoint configuration, ExternalSecret references, Terraform backend config, and promotion state.

Terraform runs from `zeko-k8s` GitHub Actions. State should live in an S3-compatible backend, preferably Cloudflare R2 for now, with GitHub Actions environment concurrency preventing simultaneous applies per environment.

Flux owns remote Kubernetes reconciliation from `zeko-k8s`. Local development can still use the service repo chart directly through local `moon` tasks; remote environments should not be deployed by ad hoc Helm commands.

### Org Adoption Boundary

`zeko-k8s` should be structured so other Kubernetes workloads can be added later, but this spike should only create concrete app directories for explorer. Shared platform resources are limited to cluster-level pieces such as External Secrets and Cloudflare Tunnel controllers. Explorer-owned dependencies, including NATS and SurrealDB, live under `infra/gitops/flux/apps/explorer`.

### FluxCD Ownership

Use FluxCD + Flux Operator for `zeko-m-alphanet`, `zeko-m-devnet`, and `zeko-m-mainnet`.

Terraform owns:

- Hetzner servers, networks, firewalls, placement groups, and volumes;
- Talos machine configuration and Kubernetes bootstrap;
- CNI/CCM/CSI and Longhorn when installed by the Talos module;
- Flux Operator bootstrap and the initial Flux sync target.

Flux owns:

- explorer-owned NATS;
- explorer-owned SurrealDB;
- ExternalSecret resources;
- Cloudflare Tunnel controller and private service routes;
- Zeko Indexer, L1 Watcher, DA Monitor, Backfill Service;
- Explorer API and Bridge API;
- setup Jobs, CronJobs, and smoke-test Jobs.

Flux Operator should run with:

- Flux Web UI enabled for remote environments;
- Flux MCP Server installed in read-only mode first;
- read-only Git deploy key initially;
- Git write access enabled only if image automation is explicitly adopted later.

The initial promotion model should be GitHub Actions promotion PRs, not automatic image writes from the cluster. Flux image automation can be revisited for `zeko-m-alphanet` after the basic GitOps path works.

---

## Host Mapping

These are starting sizes, not final capacity numbers. They are specific enough to build Terraform values and can be adjusted after load tests.

Use x86 nodes initially to avoid multi-arch operational friction. Add ARM node pools later only after CI publishes tested multi-arch images.

### Local

| Host | Kubernetes role | Workloads |
|---|---|---|
| Developer laptop with Docker Desktop | single local Kubernetes node | lean `zeko-m-local` stack |

Target developer allocation: **4 CPU and 6 GB RAM** assigned to Docker Desktop. The local chart must keep optional workloads disabled by default so normal API/indexer work does not require 12 GB.

### `zeko-m-alphanet`

Single-host Kubernetes means one Talos node that runs both control plane and workloads.

| Host | Suggested class | Kubernetes role | Workloads |
|---|---|---|---|
| `alpha-k8s-1` | CX32-class, 4 vCPU / 8 GB RAM | control plane + worker | NATS, SurrealDB, indexer, watcher, monitor, backfill, APIs, cloudflared, jobs |

Additional Hetzner resources:

- Hetzner volumes for NATS and SurrealDB PVCs;
- Cloudflare Tunnel routes for private APIs;
- R2 buckets/prefixes for archives and exports.

### `zeko-m-devnet`

`zeko-m-devnet` is the rehearsal environment for `zeko-m-mainnet`. It must use the same topology classes and deployment flow as `zeko-m-mainnet`, with smaller nodes and lower retention where acceptable.

| Host pool | Count | Suggested class | Kubernetes role | Workloads |
|---|---:|---|---|---|
| control-plane | 3 | CX22-class, 2 vCPU / 4 GB RAM | control plane only | Kubernetes API/etcd/system |
| stateful | 3 | CX32-class, 4 vCPU / 8 GB RAM | worker, tainted | NATS replicated stream, SurrealDB, Longhorn replicas |
| app | 1 | CX32-class, 4 vCPU / 8 GB RAM | worker | indexer, watchers, backfill, APIs, cloudflared |

This mirrors the `zeko-m-mainnet` role split while keeping capacity low. Do not use a simplified topology for `zeko-m-devnet`; otherwise it will not catch mainnet deployment and failover issues.

### `zeko-m-mainnet`

`zeko-m-mainnet` gets separate control-plane, stateful, and app capacity.

| Host pool | Count | Suggested class | Kubernetes role | Workloads |
|---|---:|---|---|---|
| control-plane | 3 | CX32-class, 4 vCPU / 8 GB RAM | control plane only | Kubernetes API/etcd/system |
| stateful | 3 | CX42-class, 8 vCPU / 16 GB RAM | worker, tainted | NATS replicated stream, SurrealDB, Longhorn replicas |
| app | 2 | CX32-class, 4 vCPU / 8 GB RAM | worker | indexer, watchers, backfill, APIs, cloudflared |

`zeko-e-testnet` and `zeko-e-mainnet` should be separate clusters with the same pattern when Ethereum support is ready.

---

## Persistence

### Storage Classes

Use two storage classes:

| Storage class | Backing | Use |
|---|---|---|
| `hcloud-volumes` | Hetzner CSI volumes | single-node `zeko-m-alphanet`, simple PVCs |
| `longhorn-replicated` | Longhorn over worker disks/volumes | `zeko-m-devnet` and `zeko-m-mainnet` stateful workloads needing node failure tolerance |

Do not treat Longhorn as a replacement for application-level replication. It protects volumes; NATS JetStream still needs stream replication.

### NATS JetStream

| Environment | Replicas | Persistence |
|---|---:|---|
| `zeko-m-local` | 1 | local PVC |
| `zeko-m-alphanet` | 1 | Hetzner CSI PVC + R2 archival |
| `zeko-m-devnet` | 3 | one PVC per pod, anti-affinity, stream replicas set to 3 |
| `zeko-m-mainnet` | 3 | one PVC per pod on stateful nodes, anti-affinity, stream replicas set to 3 |

Retention:

- start with 90 days for `zeko-l2`, `zeko-l1`, and `zeko-da`;
- tune after measuring message volume;
- export older messages to R2 before expiry as compressed NDJSON with NATS metadata.

### SurrealDB

SurrealDB is single-active for this milestone. This is acceptable because NATS is the durable source of truth and SurrealDB is a rebuildable read model.

| Environment | Persistence | Recovery |
|---|---|---|
| `zeko-m-local` | local PVC | disposable local data |
| `zeko-m-alphanet` | Hetzner CSI PVC | restore export or rebuild from NATS/R2 |
| `zeko-m-devnet` | Longhorn replicated PVC | Longhorn failover, restore export, rebuild from NATS |
| `zeko-m-mainnet` | Longhorn replicated PVC on stateful nodes | Longhorn failover, hourly export, rebuild from NATS/R2 |

Backups:

- run `surreal export` CronJob every 6h for `zeko-m-alphanet` and `zeko-m-devnet`;
- run `surreal export` CronJob every 1h for `zeko-m-mainnet`;
- push exports to R2 or another S3-compatible object storage path by network;
- keep 7 days for `zeko-m-alphanet` and `zeko-m-devnet`, 30 days for `zeko-m-mainnet`;
- run scheduled restore tests in `zeko-m-devnet`.

### Other Persistent Data

| Component | Persistence rule |
|---|---|
| indexer | no local durable state beyond SurrealDB and NATS consumer ack state |
| watcher/monitor | checkpoint in SurrealDB or NATS durable consumer state, not local disk |
| backfill | in-memory jobs acceptable; lost jobs are resubmitted by indexer |
| APIs | stateless |
| frontend/MCP | Cloudflare artifacts, no cluster persistence |

---

## Kubernetes Workload Model

| Component | Primitive | Scaling |
|---|---|---|
| NATS JetStream | StatefulSet / NATS chart | 1 in `zeko-m-local` and `zeko-m-alphanet`; 3 in `zeko-m-devnet` and `zeko-m-mainnet` |
| SurrealDB | StatefulSet | 1 active |
| Zeko Indexer | Deployment | 1 active replica; leader election before more |
| L1 Watcher | Deployment | 1 active replica per network |
| DA Monitor | Deployment | 1 active replica per network |
| Backfill Service | Deployment | 1 replica first |
| Explorer API | Deployment | 1 in `zeko-m-local` and `zeko-m-alphanet`; 2+ in `zeko-m-devnet` and `zeko-m-mainnet` |
| Bridge API | Deployment | 1 in `zeko-m-local` and `zeko-m-alphanet`; 2+ in `zeko-m-devnet` and `zeko-m-mainnet` |
| cloudflared / tunnel controller | Deployment | 1 in `zeko-m-alphanet`; 2+ in `zeko-m-devnet` and `zeko-m-mainnet` |
| migrations | Job | pre-deploy |
| NATS stream setup | Job | idempotent pre-deploy |
| R2 archival | CronJob | scheduled |
| SurrealDB export | CronJob | scheduled |
| smoke tests | Job | post-deploy |

Use node labels and taints:

- `pool=stateful` for NATS and SurrealDB;
- `pool=app` for indexer, watcher, monitor, backfill, APIs, and Cloudflare Tunnel connectors;
- `pool=control-plane` tainted for system workloads only in multi-host clusters.

Split `pool=app` into separate ingest/API pools later only if load tests show resource contention.

---

## Communication With Existing Zeko Services

The explorer stays outside current sequencer/DA/archive hosts. It integrates through explicit network contracts.

### Sequencer to NATS

The sequencer publishes directly to explorer-owned NATS when configured with `--nats-url`.

Requirements:

- per-network NATS URL and publish credentials;
- publishing failure must not stop block production;
- NATS is private or tightly firewall-restricted;
- sequencer has no SurrealDB/API access.

Current implementation detail from `branch/explorer-indexing-impl`: `src/app/zeko/sequencer/run.ml` exposes `--nats-url` as an optional CLI flag. The current sequencer infrastructure is managed outside this repo, so the handoff must be a generated per-network output, not a manual Slack copy/paste.

NATS URL handoff plan:

1. Explorer Terraform creates the per-network NATS publish endpoint.
2. Explorer Terraform outputs `explorer_nats_publish_url` and the credential secret reference.
3. GitHub Actions writes these outputs into the shared secret/config location used by the sequencer infra, or opens an automated PR against the sequencer infra repo if direct secret writes are not available.
4. Sequencer deployment consumes that value as `--nats-url`.
5. Credential rotation is driven from explorer infra and propagated through the same path.

Preferred network path:

- private Hetzner network or explicit private peering when the sequencer and explorer cluster are in the same Hetzner project/network;
- WireGuard/Tailscale tunnel if they are in separate projects or providers;
- narrowly firewalled public TCP endpoint only as a temporary fallback.

The NATS publish endpoint should be separate from internal NATS client access. It needs only publisher access to the explorer subjects used by the sequencer.

### Backfill to DA

Backfill is built as a container image from `zeko` and deployed in the explorer cluster.

Flow:

1. Indexer detects L2 gap.
2. Indexer calls private Backfill API.
3. Backfill fetches diffs from DA RPC.
4. Backfill republishes missing events to NATS.

Current implementation detail from `branch/explorer-indexing-impl`:

- `explorer_backfill_server.ml` requires `--nats-url` and one or more `--da-node` values.
- `--da-node` values are parsed with `Da_layer.Client.Config.of_string_list`.
- `explorer_backfill_service.ml` calls `Da_layer.Client.get_ledger_hashes_chain` and `Da_layer.Client.get_diff`.
- `Da_layer.Client` dispatches OCaml daemon RPCs to the configured DA node host:port.
- The backfill API defaults to port `8090`.

Deployment consequence: the backfill pod needs outbound TCP reachability from Kubernetes to the DA node host(s), which currently run outside the explorer cluster. It does not need the DA node inside Kubernetes.

DA network plan:

- store per-network DA node host:port list in Kubernetes config, sourced from GitHub Actions secrets/Infisical or generated environment values;
- allow egress from only the Backfill and DA Monitor pods to those DA node addresses;
- if private routing exists between Hetzner networks, use it;
- otherwise use a WireGuard/Tailscale tunnel or a firewall-restricted public DA RPC endpoint;
- expose the Backfill GraphQL API only as a private ClusterIP Service for the indexer.

### L1 Watcher

L1 Watcher connects outbound to L1 live/archive endpoints and publishes `zeko.l1.*` events into NATS.

### DA Monitor

DA Monitor connects outbound to DA endpoints and publishes `zeko.da.*` events into NATS.

### Bridge Migration

Current bridge actions services remain live until parity is proven:

1. New Bridge API runs in shadow mode.
2. Compare bridge records and responses against current actions indexer/API.
3. Switch bridge UI/SDK reads to new Bridge API.
4. Keep old stack for rollback during a defined window.
5. Remove old archive-scan path after parity and rollback window.

---

## Secrets

Use **Infisical + External Secrets Operator** for Kubernetes runtime secrets when available.

GitHub Actions secrets are acceptable for:

- Docker Hub or GCR push credentials;
- Hetzner API token for Terraform;
- Terraform backend credentials;
- Cloudflare API token for DNS/Workers/R2;
- bootstrap credentials needed to install ESO/Infisical references.

Kubernetes secrets managed through ESO:

- NATS credentials;
- SurrealDB credentials;
- L1 endpoint credentials;
- DA endpoint credentials;
- R2 archival credentials;
- API internal service tokens;
- Cloudflare origin credentials if needed.

---

## Terraform, Flux, And Deployment Flow

All Terraform runs through `zeko-k8s` GitHub Actions.

State:

- remote S3-compatible backend, preferably Cloudflare R2;
- one state file per network environment;
- GitHub Actions concurrency group per environment to prevent simultaneous applies.

Flow:

1. `zeko-k8s` PR changes Terraform, Flux definitions, or environment values.
2. `terraform-plan.yml` posts plan output for infrastructure changes.
3. Merge to protected branch.
4. Manual `terraform-apply.yml` approval per environment creates or updates the Hetzner/Talos cluster and bootstraps Flux Operator plus the initial Flux sync target when needed.
5. Service repo `images.yml` publishes immutable Kubernetes workload images.
6. `zeko-k8s` `promote.yml` opens or updates a promotion PR that pins image SHAs under `infra/gitops/flux/clusters/<env>` or app values.
7. Merge the promotion PR.
8. Flux reconciles Kustomizations and HelmReleases in dependency order.
9. Flux applies setup Jobs and CronJobs, rolls workloads, and updates private Cloudflare Tunnel resources.
10. A Flux-managed smoke-test Job verifies API, bridge, NATS, SurrealDB, Hive Gateway, and Cloudflare Tunnel routes.
11. `cloudflare.yml` deploys the frontend, Hive Gateway Worker, and MCP Worker with Wrangler when those artifacts change.

Flux is the remote Kubernetes deployer and reads desired state from `zeko-k8s`. GitHub Actions must not deploy remote Kubernetes workloads directly or run `helm upgrade` against remote clusters. Direct Helm remains useful only for local development and debugging through `moon` tasks.

---

## Final Recommendation

Use `hcloud-k8s/terraform-hcloud-kubernetes` for Hetzner/Talos cluster provisioning, **FluxCD + Flux Operator** for remote Kubernetes reconciliation, and a private org-level `zeko-k8s` repo for Kubernetes environment state.

Environment plan:

- **`zeko-m-local`:** Docker Desktop Kubernetes with the lean local namespace stack. No Flux required locally.
- **`zeko-m-alphanet`:** one Talos node, Hetzner volumes, Cloudflare Tunnel private API routes, Flux Operator Web UI/MCP in read-only mode, Hive Gateway Worker, and R2 backups.
- **`zeko-m-devnet`:** multi-host Talos cluster that mirrors the `zeko-m-mainnet` role split with smaller nodes. Deploy through Flux from promotion PRs.
- **`zeko-m-mainnet`:** multi-host Talos cluster. Deploy through Flux from reviewed promotion PRs and manual environment approvals. Create separate clusters for `zeko-e-testnet` and `zeko-e-mainnet` later.

This gives the explorer a real Kubernetes and GitOps operating model from day one while keeping Terraform focused on infrastructure and Cloudflare focused on the public edge.

---

## Sources Read

- `PRD.md`
- `spikes/001-sequencer-connector/results.md`
- `spikes/002-bridge-correlation/results.md`
- `spikes/004-deployment-topology/README.md`
- `zeko-machines/modules/sequencer.nix`
- `zeko-machines/modules/da-layer.nix`
- `zeko-machines/modules/vars-schema.nix`
- `zeko-machines/hosts/alphanet-sequencer/vars.nix`
- `zeko-machines/hosts/testnet-sequencer/vars.nix`
- `zeko-machines/hosts/testnet-da-node-2/vars.nix`
- `zeko/src/app/zeko/sequencer/README.md`
- `zeko/src/app/zeko/sequencer/run.ml`
- `zeko/src/app/zeko/sequencer/lib/zeko_sequencer.ml`
- `zeko/src/app/zeko/sequencer/explorer/explorer_backfill_server.ml`
- `zeko/src/app/zeko/sequencer/explorer/explorer_backfill_service.ml`
- `zeko/src/app/zeko/da_layer/lib/client.ml`
- `zeko-ui/services/actions/indexer/README.md`
- `zeko-ui/services/actions/api/wrangler.jsonc`
- [`hcloud-k8s/terraform-hcloud-kubernetes`](https://github.com/hcloud-k8s/terraform-hcloud-kubernetes)
- [`hcloud-talos/terraform-hcloud-talos`](https://github.com/hcloud-talos/terraform-hcloud-talos)
- [`pl4nty/cloudflare-kubernetes-gateway`](https://github.com/pl4nty/cloudflare-kubernetes-gateway)
- [ArgoCD declarative setup](https://argo-cd.readthedocs.io/en/latest/operator-manual/declarative-setup/)
- [ArgoCD cluster bootstrapping](https://argo-cd.readthedocs.io/en/latest/operator-manual/cluster-bootstrapping/)
- [ArgoCD sync phases and waves](https://argo-cd.readthedocs.io/en/latest/user-guide/sync-waves/)
- [Flux bootstrap for GitHub](https://fluxcd.io/flux/installation/bootstrap/github/)
- [Announcing Flux 2.8 GA](https://fluxcd.io/blog/2026/02/flux-v2.8.0/)
- [Flux GitOps Toolkit components](https://fluxcd.io/flux/components/)
- [Flux Kustomization dependencies and health checks](https://fluxcd.io/flux/components/kustomize/kustomizations/)
- [Flux ImageUpdateAutomation](https://fluxcd.io/flux/components/image/imageupdateautomations/)
- [Flux Operator Web UI standalone install](https://fluxoperator.dev/docs/web-ui/standalone-install/)
- [Flux Operator MCP Server](https://fluxoperator.dev/mcp-server/)
