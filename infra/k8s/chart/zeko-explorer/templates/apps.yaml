{{- if .Values.workloads.l1Watcher.enabled }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: l1-watcher
  labels:
    app.kubernetes.io/name: l1-watcher
    {{- include "zeko-explorer.labels" . | nindent 4 }}
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: l1-watcher
  template:
    metadata:
      labels:
        app.kubernetes.io/name: l1-watcher
    spec:
      containers:
        - name: l1-watcher
          image: {{ .Values.images.l1Watcher | quote }}
          imagePullPolicy: IfNotPresent
          env:
            {{- include "zeko-explorer.appEnv" . | nindent 12 }}
          resources:
            {{- toYaml .Values.resources.app | nindent 12 }}
---
{{- end }}
{{- if .Values.workloads.zekoIndexer.enabled }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: zeko-indexer
  labels:
    app.kubernetes.io/name: zeko-indexer
    {{- include "zeko-explorer.labels" . | nindent 4 }}
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: zeko-indexer
  template:
    metadata:
      labels:
        app.kubernetes.io/name: zeko-indexer
    spec:
      containers:
        - name: zeko-indexer
          image: {{ .Values.images.zekoIndexer | quote }}
          imagePullPolicy: IfNotPresent
          env:
            {{- include "zeko-explorer.appEnv" . | nindent 12 }}
          resources:
            {{- toYaml .Values.resources.app | nindent 12 }}
---
{{- end }}
{{- if .Values.workloads.explorerApi.enabled }}
apiVersion: v1
kind: Service
metadata:
  name: explorer-api
  labels:
    app.kubernetes.io/name: explorer-api
    {{- include "zeko-explorer.labels" . | nindent 4 }}
spec:
  selector:
    app.kubernetes.io/name: explorer-api
  ports:
    - name: http
      port: 4101
      targetPort: 4101
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: explorer-api
  labels:
    app.kubernetes.io/name: explorer-api
    {{- include "zeko-explorer.labels" . | nindent 4 }}
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: explorer-api
  template:
    metadata:
      labels:
        app.kubernetes.io/name: explorer-api
    spec:
      containers:
        - name: explorer-api
          image: {{ .Values.images.explorerApi | quote }}
          imagePullPolicy: IfNotPresent
          env:
            {{- include "zeko-explorer.appEnv" . | nindent 12 }}
            - name: PORT
              value: "4101"
          ports:
            - name: http
              containerPort: 4101
          resources:
            {{- toYaml .Values.resources.app | nindent 12 }}
---
{{- end }}
{{- if .Values.workloads.bridgeApi.enabled }}
apiVersion: v1
kind: Service
metadata:
  name: bridge-api
  labels:
    app.kubernetes.io/name: bridge-api
    {{- include "zeko-explorer.labels" . | nindent 4 }}
spec:
  selector:
    app.kubernetes.io/name: bridge-api
  ports:
    - name: http
      port: 4102
      targetPort: 4102
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: bridge-api
  labels:
    app.kubernetes.io/name: bridge-api
    {{- include "zeko-explorer.labels" . | nindent 4 }}
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: bridge-api
  template:
    metadata:
      labels:
        app.kubernetes.io/name: bridge-api
    spec:
      containers:
        - name: bridge-api
          image: {{ .Values.images.bridgeApi | quote }}
          imagePullPolicy: IfNotPresent
          env:
            {{- include "zeko-explorer.appEnv" . | nindent 12 }}
            - name: PORT
              value: "4102"
          ports:
            - name: http
              containerPort: 4102
          resources:
            {{- toYaml .Values.resources.app | nindent 12 }}
{{- end }}
