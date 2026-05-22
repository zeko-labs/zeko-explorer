{{- define "zeko-explorer.labels" -}}
app.kubernetes.io/part-of: zeko-explorer
app.kubernetes.io/managed-by: Helm
{{- end -}}

{{- define "zeko-explorer.appEnv" -}}
- name: ZEKO_NETWORK_ID
  value: {{ .Values.networkId | quote }}
- name: NATS_URL
  value: nats://nats:4222
- name: SURREAL_URL
  value: http://surrealdb:8000
- name: SURREAL_NAMESPACE
  value: {{ .Values.surrealdb.namespace | quote }}
- name: SURREAL_DATABASE
  value: {{ .Values.surrealdb.database | quote }}
{{- end -}}
