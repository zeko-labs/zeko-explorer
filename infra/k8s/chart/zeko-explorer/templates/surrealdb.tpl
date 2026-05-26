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
  name: surrealdb-surrealkit
  labels:
    app.kubernetes.io/name: surrealdb-surrealkit
    {{- include "zeko-explorer.labels" . | nindent 4 }}
data:
  surrealkit.toml: |-
{{ .Files.Get "surrealkit/surrealkit.toml" | indent 4 }}
  setup.surql: |-
{{ .Files.Get "surrealkit/database/setup.surql" | indent 4 }}
  000_schema.surql: |-
{{ .Files.Get "surrealkit/database/schema/000_schema.surql" | indent 4 }}
  seed.surql: |-
{{ .Files.Get "surrealkit/database/seed/seed.surql" | indent 4 }}
{{- range $path, $_ := .Files.Glob "surrealkit/migrations/*.surql" }}
  {{ base $path }}: |-
{{ $.Files.Get $path | indent 4 }}
{{- end }}
---
apiVersion: batch/v1
kind: Job
metadata:
  name: surrealdb-surrealkit
  labels:
    app.kubernetes.io/name: surrealdb-surrealkit
    {{- include "zeko-explorer.labels" . | nindent 4 }}
  annotations:
    "helm.sh/hook": post-install,post-upgrade
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  template:
    metadata:
      labels:
        app.kubernetes.io/name: surrealdb-surrealkit
    spec:
      restartPolicy: OnFailure
      containers:
        - name: surrealdb-surrealkit
          image: {{ .Values.images.surrealkit | quote }}
          workingDir: /work
          command: ["/bin/sh", "-ceu"]
          args:
            - |
              surrealkit --host http://surrealdb:8000 --ns {{ .Values.surrealdb.namespace }} --db {{ .Values.surrealdb.database }} --user {{ .Values.surrealdb.rootUser }} --pass {{ .Values.surrealdb.rootPassword }} sync --fail-fast
          volumeMounts:
            - name: surrealkit
              mountPath: /work
      volumes:
        - name: surrealkit
          configMap:
            name: surrealdb-surrealkit
            items:
              - key: surrealkit.toml
                path: surrealkit.toml
              - key: setup.surql
                path: database/setup.surql
              - key: 000_schema.surql
                path: database/schema/000_schema.surql
              - key: seed.surql
                path: database/seed/seed.surql
{{- range $path, $_ := .Files.Glob "surrealkit/migrations/*.surql" }}
              - key: {{ base $path }}
                path: migrations/{{ base $path }}
{{- end }}
