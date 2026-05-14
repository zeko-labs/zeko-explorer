apiVersion: v1
kind: Service
metadata:
  name: nats
  labels:
    app.kubernetes.io/name: nats
    {{- include "zeko-explorer.labels" . | nindent 4 }}
spec:
  selector:
    app.kubernetes.io/name: nats
  ports:
    - name: client
      port: 4222
      targetPort: 4222
    - name: monitor
      port: 8222
      targetPort: 8222
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: nats
  labels:
    app.kubernetes.io/name: nats
    {{- include "zeko-explorer.labels" . | nindent 4 }}
spec:
  serviceName: nats
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: nats
  template:
    metadata:
      labels:
        app.kubernetes.io/name: nats
    spec:
      containers:
        - name: nats
          image: {{ .Values.images.nats | quote }}
          args: ["-js", "-sd", "/data", "-m", "8222"]
          ports:
            - name: client
              containerPort: 4222
            - name: monitor
              containerPort: 8222
          resources:
            {{- toYaml .Values.resources.nats | nindent 12 }}
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
            storage: {{ .Values.storage.natsSize | quote }}
---
apiVersion: batch/v1
kind: Job
metadata:
  name: nats-stream-setup
  labels:
    app.kubernetes.io/name: nats-stream-setup
    {{- include "zeko-explorer.labels" . | nindent 4 }}
  annotations:
    "helm.sh/hook": post-install,post-upgrade
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  template:
    metadata:
      labels:
        app.kubernetes.io/name: nats-stream-setup
    spec:
      restartPolicy: OnFailure
      containers:
        - name: nats-stream-setup
          image: {{ .Values.images.natsBox | quote }}
          command: ["/bin/sh", "-ceu"]
          args:
            - |
              nats --server nats://nats:4222 stream add zeko-l2 --subjects "zeko.l2.>" --storage file --retention limits --discard old --max-age {{ .Values.nats.maxAge }} --dupe-window 2m --defaults || true
              nats --server nats://nats:4222 stream add zeko-l1 --subjects "zeko.l1.>" --storage file --retention limits --discard old --max-age {{ .Values.nats.maxAge }} --dupe-window 2m --defaults || true
              nats --server nats://nats:4222 stream add zeko-health --subjects "zeko.health" --storage file --retention limits --discard old --max-msgs 1000 --defaults || true
