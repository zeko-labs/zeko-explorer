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
              ensure_stream() {
                name="$1"
                subjects="$2"
                shift 2

                if nats --server nats://nats:4222 stream info "$name" >/dev/null 2>&1; then
                  echo "NATS stream $name already exists; leaving it unchanged."
                  return 0
                fi

                nats --server nats://nats:4222 stream add "$name" --subjects "$subjects" --storage file --retention limits --discard old "$@" --defaults
              }

              ensure_stream zeko-l2 "zeko.l2.>" --max-age {{ .Values.nats.maxAge }} --dupe-window 2m
              ensure_stream zeko-l1 "zeko.l1.>" --max-age {{ .Values.nats.maxAge }} --dupe-window 2m
              ensure_stream zeko-health "zeko.health" --max-msgs 1000
