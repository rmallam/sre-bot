{{/*
Expand the name of the chart.
*/}}
{{- define "sre-bot.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "sre-bot.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "sre-bot.namespace" -}}
{{- .Values.namespace.name }}
{{- end }}

{{- define "sre-bot.labels" -}}
helm.sh/chart: {{ include "sre-bot.chart" . }}
app.kubernetes.io/name: {{ include "sre-bot.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "sre-bot.selectorLabels" -}}
app.kubernetes.io/name: {{ include "sre-bot.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "sre-bot.agentLabels" -}}
{{ include "sre-bot.labels" . }}
sre-bot/agent: {{ .agent }}
{{- end }}

{{- define "sre-bot.image" -}}
{{- $agent := .agent -}}
{{- $root := .root -}}
{{- printf "%s/%s/sre-bot-%s:%s" $root.Values.global.imageRegistry $root.Values.global.imageOwner $agent $root.Values.global.imageTag }}
{{- end }}

{{- define "sre-bot.customImage" -}}
{{- $repo := .repository -}}
{{- $root := .root -}}
{{- printf "%s/%s/%s:%s" $root.Values.global.imageRegistry $root.Values.global.imageOwner $repo $root.Values.global.imageTag }}
{{- end }}

{{- define "sre-bot.serviceUrl" -}}
{{- printf "http://%s-agent.%s.svc.cluster.local:8080" .agent (include "sre-bot.namespace" .root) }}
{{- end }}

{{- define "sre-bot.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
sre-bot-secrets{{- end -}}
{{- end }}

{{- define "sre-bot.imagePullSecrets" -}}
{{- with .Values.global.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{- define "sre-bot.databaseUrl" -}}
{{- $pg := .Values.postgres -}}
{{- $ns := include "sre-bot.namespace" . -}}
{{- printf "postgresql://%s:%s@postgres.%s.svc.cluster.local:5432/%s" $pg.auth.username $pg.auth.password $ns $pg.auth.database }}
{{- end }}

{{- define "sre-bot.redisUrl" -}}
{{- printf "redis://redis.%s.svc.cluster.local:6379" (include "sre-bot.namespace" .) }}
{{- end }}

{{- define "sre-bot.ragDatabaseUrl" -}}
{{- if .Values.platform.ragDatabaseUrl -}}
{{- .Values.platform.ragDatabaseUrl -}}
{{- else -}}
{{- $rag := .Values.ragPostgres.auth -}}
{{- $ns := include "sre-bot.namespace" . -}}
{{- printf "postgresql://%s:%s@rag-postgres.%s.svc.cluster.local:5432/%s" $rag.username $rag.password $ns $rag.database -}}
{{- end -}}
{{- end }}

{{- define "sre-bot.livenessProbe" -}}
httpGet:
  path: /health
  port: http
initialDelaySeconds: 15
periodSeconds: 30
timeoutSeconds: 5
failureThreshold: 3
{{- end }}

{{- define "sre-bot.internalAuthEnv" -}}
- name: SRE_AUTH_STRICT
  value: {{ .Values.global.sreAuthStrict | default "true" | quote }}
- name: SRE_INTERNAL_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ include "sre-bot.secretName" . }}
      key: sre_internal_token
{{- end }}

{{- define "sre-bot.readinessProbe" -}}
httpGet:
  path: /health
  port: http
initialDelaySeconds: 5
periodSeconds: 10
timeoutSeconds: 3
failureThreshold: 3
{{- end }}
