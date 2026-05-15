# Addendum: FluxCD Deployment Model

## Decision

FluxCD is a strong fit for the remote Kubernetes environments:

- `zeko-m-alphanet`
- `zeko-m-devnet`
- `zeko-m-mainnet`

The deployment should follow **single ownership per resource**.

| Layer | Owner | Reason |
|---|---|---|
| Hetzner servers, networks, firewalls, volumes | Terraform | External infrastructure needs Terraform state and provider lifecycle management. |
| Talos machine config and cluster bootstrap | Terraform | Cluster creation must work before Kubernetes controllers exist. |
| Core cluster bootstrap required for Kubernetes to function | Terraform / Talos module | CNI, CCM, CSI, API access, and Flux itself must exist before Flux can reconcile apps. |
| Flux installation and first sync target | Terraform or `flux bootstrap` | This is the handoff point from infrastructure bootstrap to GitOps. |
| Explorer Kubernetes workloads | Flux | App state should be reconciled continuously from Git. |
| Cloudflare Workers and static assets | GitHub Actions + Wrangler | They do not run in Kubernetes. |
| Image builds and registry publishing | GitHub Actions | CI builds artifacts; Flux deploys pinned artifacts from Git or Flux image automation updates Git. |

Flux is a Kubernetes-native, CRD-first GitOps model with strong primitives for dependency ordering, Helm releases, source reconciliation, and image update automation. Flux 2.8 materially improves the operator experience through the Flux Operator ecosystem: a dedicated Web UI, better Helm health checking, faster recovery from failed deployments, PR/MR feedback providers, and an MCP server for agent-assisted operations.

## Module Support

Neither selected Talos Terraform module installs FluxCD as a built-in default component.

### `hcloud-k8s/terraform-hcloud-kubernetes`

This module bootstraps the Talos cluster and selected core/add-on components. It can apply extra Talos bootstrap manifests, but Flux should be installed intentionally rather than hidden in an opaque extra manifest.

Recommended options:

1. Terraform creates the cluster, then GitHub Actions runs `flux bootstrap github`.
2. Terraform installs Flux Operator and a `FluxInstance` after Kubernetes is reachable.
3. Terraform installs raw Flux manifests or a Flux bootstrap module after Kubernetes is reachable.

Option 1 is the standard Flux bootstrap path and writes Flux manifests back to Git. Option 2 is the stronger current option if the deployment wants the Flux Operator Web UI, Flux MCP Server, ResourceSet APIs, and operator-managed Flux lifecycle. Option 3 keeps bootstrap entirely in Terraform but requires more care to avoid Terraform owning Flux-managed objects after handoff.

### `hcloud-talos/terraform-hcloud-talos`

This module does not install Flux. If it is used, install Flux after cluster creation with the same bootstrap boundary.

## Recommended Bootstrap Flow

Flux's documented GitHub bootstrap flow installs Flux controllers and configures them to sync from a GitHub repository path. It writes Flux manifests back to Git so Flux upgrades can happen by Git change.

For a Flux CLI bootstrap:

```text
terraform-apply.yml
  -> create/update Hetzner + Talos cluster
  -> export kubeconfig securely for this workflow run
  -> run flux bootstrap github for the environment path if not bootstrapped
  -> Flux reconciles infra/gitops/flux/clusters/<env>
```

Example bootstrap:

```sh
flux bootstrap github \
  --owner=zeko-labs \
  --repository=zeko-k8s \
  --branch=main \
  --path=infra/gitops/flux/clusters/zeko-m-devnet \
  --read-write-key=false
```

If Flux image automation will write directly to Git, the deploy key must have write access or Flux must use a write-capable credential. For a stricter promotion model, keep Flux read-only and have GitHub Actions open promotion PRs instead.

Recommended initial choice: **read-only Flux deploy key plus GitHub Actions promotion PRs**. This is more auditable for `zeko-m-devnet` and `zeko-m-mainnet`.

For a Flux Operator bootstrap:

```text
terraform-apply.yml
  -> create/update Hetzner + Talos cluster
  -> install Flux Operator Helm chart
  -> create FluxInstance for the environment
  -> optionally enable Flux Web UI
  -> optionally install Flux Operator MCP Server
  -> Flux reconciles infra/gitops/flux/clusters/<env>
```

Recommended initial choice for this spike: **Flux Operator with read-only Git access, Web UI enabled for remote environments, and MCP installed in read-only mode first**. Enable Git write access only after the promotion policy is explicit.

## Repository Layout

Recommended private `zeko-k8s` repo layout:

```text
infra/
  terraform/
    modules/
      hcloud-zeko-cluster/
    envs/
      zeko-m-alphanet/
      zeko-m-devnet/
      zeko-m-mainnet/

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
```

Use separate Flux cluster directories per environment. The cluster directory defines sources and environment-specific `Kustomization` resources. Shared app definitions live under `infra/gitops/flux/apps`.

Service repos remain the source for application code, local Kubernetes, reusable chart/templates, and CI image builds. `zeko-k8s` vendors or references service charts and pins immutable image tags per environment. This spike should only create concrete app directories for explorer. NATS and SurrealDB are explorer-owned dependencies, so they live under `apps/explorer`, not `apps/platform`.

## Flux Resource Model

Flux uses composable controllers and CRDs:

| Flux CRD | Use in this spike |
|---|---|
| `GitRepository` | Points Flux at `zeko-k8s`. |
| `Kustomization` | Applies Kubernetes manifests from a path and supports dependency ordering with `dependsOn`. |
| `HelmRepository` | Defines external chart repositories if we use upstream NATS/SurrealDB/ESO charts. |
| `HelmRelease` | Installs Helm charts declaratively. |
| `ImageRepository` | Scans pushed image tags. |
| `ImagePolicy` | Selects allowed image tags. |
| `ImageUpdateAutomation` | Optionally writes selected image tags back to Git. |
| `FluxInstance` | Flux Operator-managed Flux installation and controller configuration. |
| `ResourceSet` | Flux Operator application/preview environment composition. |
| `FluxReport` | Flux Operator reporting for Web UI and status inspection. |

For explorer, use either:

- `Kustomization` wrapping a Helm-rendered chart checked into the repo; or
- `HelmRelease` pointing at an OCI/local chart source.

Recommended initial choice: use `HelmRelease` for charted components and `Kustomization` for environment assembly.

Flux 2.8 ships with Helm v4 support, server-side apply for Helm-managed resources, and kstatus-based health checking. That matters here because the explorer stack has multiple StatefulSets, Jobs, CronJobs, Deployments, and CRDs that need accurate rollout and health status.

## Flux Operator, Web UI, And MCP

Flux Operator should be included in the Flux variant when using Flux for remote environments.

Flux Operator adds:

- Flux lifecycle management through `FluxInstance`;
- Flux Web UI for cluster dashboard, sync statistics, health, search, favorites, GitOps graphs, and workload rollout visibility;
- OIDC/Kubernetes RBAC integration for multi-tenant UI access;
- `ResourceSet` APIs for application definitions and preview environments;
- Flux MCP Server for agent-assisted troubleshooting, comparison, visualization, and operations.

The Flux Web UI changes the operational tradeoff. Flux is no longer only a CLI/controller workflow. With Flux Operator, operators get visual status and GitOps graphs while retaining Flux's CRD-first model.

Flux MCP is relevant for this repo because the explorer already includes an MCP surface. For operations, Flux MCP can give agents controlled access to:

- inspect Flux installation health;
- compare desired state across `zeko-m-alphanet`, `zeko-m-devnet`, and `zeko-m-mainnet`;
- summarize failed reconciliations;
- correlate events, logs, and GitOps configuration;
- trigger reconciliations or suspend/resume resources when allowed by RBAC;
- generate dependency diagrams for Flux-managed resources.

MCP should start in **read-only mode**. Mutating operations should require explicit RBAC and environment policy. For `zeko-m-mainnet`, agent-triggered reconciliation should be allowed only through tightly scoped service accounts or disabled until incident-response policy is defined.

Flux Operator is not part of the core Talos modules. It must be installed after the cluster exists, either by Terraform Helm release or a bootstrap GitOps step.

Before adoption, review Flux Operator licensing and support. The Flux Operator documentation identifies the operator project as AGPL-3.0 licensed, with enterprise distribution available from ControlPlane. This is separate from the CNCF Flux controllers and should be checked before standardizing on the Web UI or MCP Server.

## Dependency Ordering

Flux uses `Kustomization.spec.dependsOn`, health checks, and `wait` for dependency ordering.

Recommended dependency graph:

```text
namespaces
  -> external-secrets
  -> cloudflare-tunnel
  -> data-plane
       -> nats
       -> surrealdb
  -> setup-jobs
       -> nats-stream-setup
       -> db-migrations
  -> ingest
       -> zeko-indexer
       -> l1-watcher
       -> backfill
  -> api
       -> explorer-api
       -> bridge-api
  -> private-routes
  -> smoke-tests
```

Example:

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: explorer-api
  namespace: flux-system
spec:
  interval: 5m
  path: ./infra/gitops/flux/apps/explorer/api
  prune: true
  wait: true
  timeout: 5m
  dependsOn:
    - name: setup-jobs
    - name: data-plane
  sourceRef:
    kind: GitRepository
    name: zeko-explorer
  healthChecks:
    - apiVersion: apps/v1
      kind: Deployment
      name: explorer-api
      namespace: zeko-m-devnet
```

This is a good fit for this spike because the explorer has real ordering requirements: NATS and SurrealDB must exist before migrations/setup jobs; setup jobs must finish before APIs and indexers are treated as healthy.

## Jobs And Migrations

Flux can apply Kubernetes Jobs, but Jobs need careful reconciliation semantics.

For one-time deploy-blocking tasks:

- use stable, idempotent Jobs;
- include a version/hash in the Job name if the job must re-run for each release;
- use Flux health checks to block dependent `Kustomization` resources until the Job succeeds;
- avoid non-idempotent migration logic.

Recommended tasks:

| Task | Flux model |
|---|---|
| NATS stream setup | Job in `setup-jobs` Kustomization; idempotent create/update of streams. |
| SurrealDB migration | Job in `setup-jobs`; versioned or release-hash named if it must re-run. |
| Smoke tests | Separate Kustomization depending on `api` and `private-routes`; Job with health check. |
| R2 archival | CronJob managed by Flux after data plane exists. |
| SurrealDB export | CronJob managed by Flux after SurrealDB exists. |

Use explicit Kustomizations and dependencies for deploy-blocking setup and post-deploy validation.

## CI And Promotion With Flux

There are two viable promotion models.

### Option A: GitHub Actions Promotion PRs

GitHub Actions:

1. builds images with immutable SHA tags;
2. pushes images to Docker Hub or GCR;
3. opens a promotion PR in `zeko-k8s` updating environment values;
4. Flux reconciles after merge.

This is the recommended initial model because it preserves manual review for promotion to `zeko-m-devnet` and `zeko-m-mainnet`.

```text
merge to main
  -> images.yml builds zeko/*:<sha>
  -> zeko-k8s promote.yml opens PR for zeko-m-alphanet values
  -> merge promotion PR
  -> Flux reconciles zeko-m-alphanet
  -> validate zeko-m-alphanet
  -> promote same SHA set to zeko-m-devnet
  -> validate zeko-m-devnet
  -> promote same SHA set to zeko-m-mainnet
```

### Option B: Flux Image Automation

Flux can scan image tags using `ImageRepository`, select tags with `ImagePolicy`, and write updates back to Git with `ImageUpdateAutomation`.

This is powerful but should be used carefully:

- acceptable for `zeko-m-alphanet`;
- probably too automatic for `zeko-m-devnet` and `zeko-m-mainnet` unless policy requires PR review or a protected branch workflow;
- requires write-capable Git credentials in the cluster.

Recommended initial stance:

- use GitHub Actions PR promotion for all environments;
- revisit Flux image automation for `zeko-m-alphanet` after the basic GitOps flow works;
- consider Flux Operator ResourceSet image automation for preview environments only after the promotion model is stable.

## Image Tags

Flux should deploy immutable image tags from Git values:

```yaml
images:
  explorerApi:
    repository: zeko/explorer-api
    tag: "8f31c2a"
  bridgeApi:
    repository: zeko/bridge-api
    tag: "8f31c2a"
  indexer:
    repository: zeko/zeko-indexer
    tag: "8f31c2a"
```

Do not deploy `latest`. Do not rely on mutable branch tags for `zeko-m-devnet` or `zeko-m-mainnet`.

## Secrets

Preferred runtime model:

1. Git stores ExternalSecret manifests, not secret values.
2. Infisical stores secret values.
3. External Secrets Operator materializes Kubernetes Secrets.
4. Flux reconciles the ExternalSecret resources.

Flux supports SOPS-based secret workflows, but the primary recommendation remains Infisical + ESO, with GitHub Actions secrets only for bootstrap.

Bootstrap credentials:

- Flux needs Git read credentials.
- Flux image automation needs Git write credentials.
- Prefer read-only deploy keys for the initial model.

## Cloudflare Boundary

Flux owns Kubernetes resources for private cluster routing:

- Cloudflare Tunnel controller;
- tunnel route objects;
- `cloudflared` deployment if required by the controller;
- private service routing resources for Explorer API and Bridge API.

Flux does not deploy:

- frontend static assets;
- Hive Gateway Worker;
- MCP Worker.

Those stay in `cloudflare.yml` with Wrangler.

## Local Development

Do not use Flux for `zeko-m-local`.

Local development remains:

```text
moon run infra:build-local-images
moon run infra:k8s-local-up
moon run infra:k8s-local-forward
moon run infra:dev
```

Developers should not need Flux controllers locally to work on the explorer.

## Failure And Rollback Behavior

Flux gives:

- continuous reconciliation from Git;
- dependency-aware readiness with `dependsOn` and health checks;
- controller-level status on each `Kustomization` and `HelmRelease`;
- Web UI visibility through Flux Operator;
- MCP-based agent-assisted investigation through Flux Operator MCP;
- optional image update automation;
- PR/MR status feedback through notification providers.

Rollback should be Git-based:

1. revert the promotion commit or open a rollback PR;
2. Flux reconciles the previous image tag set;
3. smoke-test Kustomization verifies API and tunnel health.

Do not use manual `kubectl set image` against Flux-managed Deployments. Flux will revert drift on the next reconciliation.

## Recommendation

FluxCD is viable for this deployment. The best Flux model for Zeko Explorer is:

- Terraform creates Hetzner/Talos infrastructure.
- Flux Operator and Flux are bootstrapped once per remote environment.
- Flux owns Kubernetes app/platform resources via `Kustomization` and `HelmRelease`.
- GitHub Actions builds images and opens `zeko-k8s` promotion PRs with pinned SHA tags.
- Flux image automation is optional later, not part of the first production path.
- Flux Web UI is enabled for remote environments.
- Flux MCP starts in read-only mode for investigation and environment comparison.
- Cloudflare Workers/static assets remain deployed by Wrangler.
- `zeko-m-local` stays outside Flux.

## Sources

- [Flux bootstrap for GitHub](https://fluxcd.io/flux/installation/bootstrap/github/)
- [Announcing Flux 2.8 GA](https://fluxcd.io/blog/2026/02/flux-v2.8.0/)
- [Flux GitOps Toolkit components](https://fluxcd.io/flux/components/)
- [Flux Kustomization dependencies and health checks](https://fluxcd.io/flux/components/kustomize/kustomizations/)
- [Flux ImageUpdateAutomation](https://fluxcd.io/flux/components/image/imageupdateautomations/)
- [Flux Operator Web UI standalone install](https://fluxoperator.dev/docs/web-ui/standalone-install/)
- [Flux Operator MCP Server](https://fluxoperator.dev/mcp-server/)
- [`hcloud-k8s/terraform-hcloud-kubernetes`](https://github.com/hcloud-k8s/terraform-hcloud-kubernetes)
- [`hcloud-talos/terraform-hcloud-talos`](https://github.com/hcloud-talos/terraform-hcloud-talos)
