apiVersion: v1
kind: Service
metadata:
  name: surrealdb
  labels:
    app.kubernetes.io/name: surrealdb
    {{- include "zeko-explorer.labels" . | nindent 4 }}
spec:
  selector:
    app.kubernetes.io/name: surrealdb
  ports:
    - name: http
      port: 8000
      targetPort: 8000
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: surrealdb
  labels:
    app.kubernetes.io/name: surrealdb
    {{- include "zeko-explorer.labels" . | nindent 4 }}
spec:
  serviceName: surrealdb
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: surrealdb
  template:
    metadata:
      labels:
        app.kubernetes.io/name: surrealdb
    spec:
      containers:
        - name: surrealdb
          image: {{ .Values.images.surrealdb | quote }}
          args:
            - start
            - --username
            - {{ .Values.surrealdb.rootUser | quote }}
            - --password
            - {{ .Values.surrealdb.rootPassword | quote }}
            - surrealkv:/data/explorer.db
          ports:
            - name: http
              containerPort: 8000
          resources:
            {{- toYaml .Values.resources.surrealdb | nindent 12 }}
          volumeMounts:
            - name: data
              mountPath: /data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: {{ .Values.storage.className | quote }}
        resources:
          requests:
            storage: {{ .Values.storage.surrealdbSize | quote }}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: surrealdb-migrations
  labels:
    app.kubernetes.io/name: surrealdb-migrations
    {{- include "zeko-explorer.labels" . | nindent 4 }}
data:
  surrealkit.toml: |
    # SurrealKit project for the Zeko Explorer read model.
  000_schema.surql: |
    DEFINE TABLE OVERWRITE batch SCHEMAFULL;
    DEFINE FIELD network ON batch TYPE string;
    DEFINE FIELD target_ledger_hash ON batch TYPE string;
    DEFINE FIELD da_status ON batch TYPE option<string> ASSERT $value IN ['attested'];
    DEFINE FIELD da_attested_at ON batch TYPE option<datetime>;
    DEFINE FIELD da_source ON batch TYPE option<string> ASSERT $value IN ['settlement', 'proved', 'da-direct'];
    DEFINE INDEX idx_batch_target_ledger_hash ON batch FIELDS target_ledger_hash UNIQUE;
    DEFINE INDEX idx_batch_da_status ON batch FIELDS da_status;
    DEFINE TABLE pending_da_attestation SCHEMAFULL;
    DEFINE FIELD ledger_hash ON pending_da_attestation TYPE string;
    DEFINE FIELD source ON pending_da_attestation TYPE string ASSERT $value IN ['settlement', 'proved', 'da-direct'];
    DEFINE FIELD attested_at ON pending_da_attestation TYPE option<datetime>;
    DEFINE FIELD received_at ON pending_da_attestation TYPE datetime;
    DEFINE INDEX idx_pending_da_hash ON pending_da_attestation FIELDS ledger_hash UNIQUE;
---
apiVersion: batch/v1
kind: Job
metadata:
  name: surrealdb-migrate
  labels:
    app.kubernetes.io/name: surrealdb-migrate
    {{- include "zeko-explorer.labels" . | nindent 4 }}
  annotations:
    "helm.sh/hook": post-install,post-upgrade
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  template:
    metadata:
      labels:
        app.kubernetes.io/name: surrealdb-migrate
    spec:
      restartPolicy: OnFailure
      containers:
        - name: surrealdb-migrate
          image: {{ .Values.images.surrealkit | quote }}
          workingDir: /work
          command: ["/bin/sh", "-ceu"]
          args:
            - |
              surrealkit --host http://surrealdb:8000 --ns {{ .Values.surrealdb.namespace }} --db {{ .Values.surrealdb.database }} --user {{ .Values.surrealdb.rootUser }} --pass {{ .Values.surrealdb.rootPassword }} sync --fail-fast
          volumeMounts:
            - name: migrations
              mountPath: /work/surrealkit.toml
              subPath: surrealkit.toml
            - name: migrations
              mountPath: /work/database/schema/000_schema.surql
              subPath: 000_schema.surql
      volumes:
        - name: migrations
          configMap:
            name: surrealdb-migrations
