# Addendum: ArgoCD Deployment Model

## Decision

ArgoCD is a valid deployment model for the remote Kubernetes environments:

- `zeko-m-alphanet`
- `zeko-m-devnet`
- `zeko-m-mainnet`

It should not replace Terraform. The best-practice boundary is:

| Layer | Owner | Reason |
|---|---|---|
| Hetzner servers, networks, firewalls, volumes | Terraform | External infrastructure needs Terraform state and provider lifecycle management. |
| Talos machine config and cluster bootstrap | Terraform | Cluster creation must work before Kubernetes controllers exist. |
| Core cluster bootstrap required for Kubernetes to function | Terraform / Talos module | CNI, CCM, CSI, API access, and ArgoCD itself must exist before ArgoCD can reconcile apps. |
| ArgoCD installation and first root Application | Terraform | This is the handoff point from infrastructure bootstrap to GitOps. |
| Explorer Kubernetes workloads | ArgoCD | App state should be reconciled continuously from Git. |
| Cloudflare Workers and static assets | GitHub Actions + Wrangler | They do not run in Kubernetes. |
| Image builds and registry publishing | GitHub Actions | CI builds artifacts; ArgoCD deploys pinned artifacts from Git. |

The key rule is **single ownership per resource**. Do not let Terraform and ArgoCD manage the same Kubernetes object after bootstrap. Terraform should install ArgoCD and the root app; ArgoCD should own the child apps.

## Module Support

Neither selected Talos Terraform module installs ArgoCD as a built-in default component.

### `hcloud-k8s/terraform-hcloud-kubernetes`

This module includes bootstrap support for core/add-on components such as Cilium, Talos backup, Talos CCM, CoreDNS, Hetzner CCM/CSI, metrics-server, Prometheus Operator CRDs, and optional cert-manager and Longhorn.

The module supports extra Talos bootstrap manifests through `talos_extra_remote_manifests` and `talos_extra_inline_manifests`. ArgoCD can technically be bootstrapped through extra manifests, but the recommended path is to install ArgoCD from Terraform using the Helm provider after the cluster is reachable.

### `hcloud-talos/terraform-hcloud-talos`

This module creates the Talos Kubernetes cluster and does not include ArgoCD as a built-in component. It should be treated as a lower-level cluster module. Terraform still needs to install ArgoCD separately.

## Recommended Bootstrap Flow

1. `terraform-plan.yml` runs for `infra/terraform/envs/<env>`.
2. `terraform-apply.yml` creates or updates the Hetzner/Talos cluster.
3. Terraform installs ArgoCD into the `argocd` namespace with `helm_release`.
4. Terraform creates:
   - ArgoCD repository credential secret;
   - ArgoCD `AppProject` for explorer apps;
   - one root `Application` for the target environment.
5. ArgoCD reconciles the root app.
6. The root app creates child applications for platform and explorer workloads.
7. GitHub Actions builds images and opens promotion PRs that update Git-pinned image tags.
8. ArgoCD applies those Git changes to the cluster.

Terraform should only create the root application once per environment. After that, normal application changes flow through Git and ArgoCD.

## Repository Layout

Recommended private `zeko-k8s` repo layout:

```text
infra/
  terraform/
    modules/
      hcloud-zeko-cluster/
      argocd-bootstrap/
    envs/
      zeko-m-alphanet/
      zeko-m-devnet/
      zeko-m-mainnet/

  gitops/
    clusters/
      zeko-m-alphanet/
        root.yaml
        values.yaml
      zeko-m-devnet/
        root.yaml
        values.yaml
      zeko-m-mainnet/
        root.yaml
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

Service repos remain the source for application code, local Kubernetes, reusable chart/templates, and CI image builds. `zeko-k8s` owns remote environment state, Terraform, ArgoCD roots, environment values, and promotion PRs. This spike should only create concrete app directories for explorer. NATS and SurrealDB are explorer-owned dependencies, so they live under `apps/explorer`, not `apps/platform`.

## Application Structure

Use one root app per environment:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: zeko-m-devnet-root
  namespace: argocd
spec:
  project: zeko-explorer
  source:
    repoURL: https://github.com/zeko-labs/zeko-k8s.git
    targetRevision: main
    path: infra/gitops/clusters/zeko-m-devnet
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

The root app owns child `Application` resources, for example:

- `external-secrets`
- `cloudflare-tunnel`
- `nats`
- `surrealdb`
- `zeko-explorer`
- `smoke-tests`

For three environments, App-of-Apps is sufficient. ApplicationSet becomes useful if we later have many networks or repeated generated apps.

## Sync Ordering

Use ArgoCD sync waves and hooks for dependency order.

Recommended order:

| Wave | Resources |
|---:|---|
| -20 | namespaces, service accounts, RBAC, ArgoCD projects |
| -10 | External Secrets Operator resources and secret stores |
| -5 | Cloudflare Tunnel controller resources |
| 0 | NATS, SurrealDB, PVCs, service accounts |
| 5 | NATS stream setup Job, schema migration Job |
| 10 | indexer, L1 Watcher, Backfill Service |
| 20 | Explorer API, Bridge API |
| 30 | Cloudflare Tunnel routes to private subgraph services |
| 40 | smoke-test Job |

Use `PreSync` hooks for deploy-blocking migration/setup jobs and `PostSync` hooks for smoke tests.

Example migration Job:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: surrealdb-migrate
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: HookSucceeded
    argocd.argoproj.io/sync-wave: "5"
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: zeko/explorer-ops:${IMAGE_TAG}
          command: ["./bin/explorer-migrate"]
```

The migration and setup Jobs are not long-running services. They should run from a small ops image only if they must execute inside Kubernetes.

## CI And Promotion With ArgoCD

With ArgoCD, CI does not deploy Kubernetes workloads directly.

GitHub Actions responsibilities:

| Workflow | Responsibility |
|---|---|
| `ci.yml` | lint, typecheck, unit tests, integration tests |
| `images.yml` | build and push Kubernetes workload images with immutable SHA tags |
| `terraform-plan.yml` | plan infra and ArgoCD bootstrap changes |
| `terraform-apply.yml` | apply infra and ArgoCD bootstrap changes |
| `promote.yml` | update Git-pinned image tags for a target environment in `zeko-k8s` |
| `cloudflare.yml` | deploy frontend, Hive Gateway Worker, and MCP Worker with Wrangler |

Promotion flow:

```text
merge to main
  -> images.yml builds zeko/*:<sha>
  -> zeko-k8s promote.yml opens/updates PR for zeko-m-alphanet image tags
  -> merge promotion PR
  -> ArgoCD syncs zeko-m-alphanet
  -> validate zeko-m-alphanet
  -> promote same SHA set to zeko-m-devnet
  -> validate zeko-m-devnet
  -> promote same SHA set to zeko-m-mainnet
```

`zeko-m-devnet` must mirror the `zeko-m-mainnet` role split, so promotion failures there are meaningful before production.

## Image Tags

ArgoCD should deploy immutable image tags from Git values:

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

Do not let ArgoCD deploy `latest`. Do not rely on mutable branch tags for `zeko-m-devnet` or `zeko-m-mainnet`.

ArgoCD Image Updater can be considered later, but it is not required initially. A promotion PR is more explicit and easier to audit.

## Secrets

Preferred runtime model:

1. Git stores ExternalSecret manifests, not secret values.
2. Infisical stores secret values.
3. External Secrets Operator materializes Kubernetes Secrets.
4. ArgoCD reconciles the ExternalSecret resources.

Bootstrap exceptions:

- Terraform/GitHub Actions may need enough credentials to install ESO and ArgoCD.
- ArgoCD repository credentials are bootstrap secrets and should be managed by Terraform or ESO once ESO is available.

Do not commit sealed literal secrets into either repo unless the team explicitly decides to use a sealed-secret workflow.

## Cloudflare Boundary

ArgoCD owns Kubernetes resources for private cluster routing, such as:

- Cloudflare Tunnel controller;
- tunnel route objects;
- `cloudflared` deployment if required by the controller;
- private service routing resources for Explorer API and Bridge API.

ArgoCD does not deploy:

- frontend static assets;
- Hive Gateway Worker;
- MCP Worker.

Those are Cloudflare artifacts deployed by `cloudflare.yml` with Wrangler.

The public flow remains:

```text
client
  -> Cloudflare route
  -> Hive Gateway Worker
  -> Cloudflare Tunnel private subgraph route
  -> cloudflared / tunnel controller in Kubernetes
  -> Explorer API or Bridge API Service
```

## Local Development

Do not use ArgoCD for `zeko-m-local`.

Local development should stay:

```text
moon run infra:build-local-images
moon run infra:k8s-local-up
moon run infra:k8s-local-forward
moon run infra:dev
```

Developers should not need a local ArgoCD control plane to work on the explorer.

## Failure And Rollback Behavior

ArgoCD gives:

- drift detection;
- self-heal for app resources;
- sync history;
- clearer promotion audit trail;
- repeatable cluster reconciliation after node replacement.

Rollback should be Git-based:

1. revert the promotion commit or open a rollback PR;
2. ArgoCD syncs the previous image tag set;
3. post-sync smoke tests verify API and tunnel health.

Do not use manual `kubectl set image` against ArgoCD-managed Deployments. ArgoCD will either revert it or record drift.

## What Not To Put Under ArgoCD

Keep these outside ArgoCD ownership:

- Hetzner servers, firewalls, networks, placement groups, and volumes;
- Talos machine configuration;
- Kubernetes API endpoint configuration;
- CNI/CCM/CSI components if installed by the Talos Terraform module;
- ArgoCD's initial installation and root app;
- Cloudflare Workers and frontend static assets;
- Docker Hub/GCR image build and publish.

This is not because ArgoCD is weak. It is because those resources either exist before ArgoCD can run, are not Kubernetes resources, or are already owned by Terraform/module lifecycle.

## Recommendation

Use ArgoCD for the remote Kubernetes environments when GitOps reconciliation, drift detection, and application visibility are required from the start.

Recommended implementation:

- Terraform installs ArgoCD with Helm after Talos cluster creation.
- Terraform creates one root `Application` per environment.
- ArgoCD owns explorer Kubernetes apps through App-of-Apps.
- GitHub Actions builds images and opens promotion PRs that update pinned image tags.
- Wrangler deploys Cloudflare Workers and frontend static assets.
- Keep `zeko-m-local` out of ArgoCD.

This is a better long-term deployment story than direct `helm upgrade` from GitHub Actions, especially because `zeko-m-devnet` must mirror `zeko-m-mainnet` and because several services must be deployed in a strict order.

## Sources

- [ArgoCD declarative setup](https://argo-cd.readthedocs.io/en/latest/operator-manual/declarative-setup/)
- [ArgoCD cluster bootstrapping](https://argo-cd.readthedocs.io/en/latest/operator-manual/cluster-bootstrapping/)
- [ArgoCD sync phases and waves](https://argo-cd.readthedocs.io/en/latest/user-guide/sync-waves/)
- [ArgoCD application specification](https://argo-cd.readthedocs.io/en/latest/user-guide/application-specification/)
- [`hcloud-k8s/terraform-hcloud-kubernetes`](https://github.com/hcloud-k8s/terraform-hcloud-kubernetes)
- [`hcloud-talos/terraform-hcloud-talos`](https://github.com/hcloud-talos/terraform-hcloud-talos)
