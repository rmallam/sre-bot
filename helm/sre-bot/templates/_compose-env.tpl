{{/*
  Shared env blocks mirroring docker-compose.yml
*/}}

{{- define "sre-bot.agentModeEnv" -}}
- name: SRE_AGENT_MODE
  value: {{ .Values.agentMode.sreAgentMode | quote }}
{{- if .Values.agentMode.commanderRoutingMode }}
- name: COMMANDER_ROUTING_MODE
  value: {{ .Values.agentMode.commanderRoutingMode | quote }}
{{- end }}
{{- if .Values.agentMode.orchestratorGraphMode }}
- name: ORCHESTRATOR_GRAPH_MODE
  value: {{ .Values.agentMode.orchestratorGraphMode | quote }}
{{- end }}
{{- if .Values.agentMode.investigateGatherMode }}
- name: INVESTIGATE_GATHER_MODE
  value: {{ .Values.agentMode.investigateGatherMode | quote }}
{{- end }}
- name: AGENTIC_MAX_TURNS
  value: {{ .Values.agentMode.agenticMaxTurns | quote }}
- name: AGENTIC_MAX_READ_TOOLS
  value: {{ .Values.agentMode.agenticMaxReadTools | quote }}
{{- if .Values.agentMode.agenticLlmToolSelect }}
- name: AGENTIC_LLM_TOOL_SELECT
  value: {{ .Values.agentMode.agenticLlmToolSelect | quote }}
{{- end }}
{{- if .Values.agentMode.agenticLlmReflect }}
- name: AGENTIC_LLM_REFLECT
  value: {{ .Values.agentMode.agenticLlmReflect | quote }}
{{- end }}
{{- end }}

{{- define "sre-bot.platformEnv" -}}
{{- if .Values.agents.platform.enabled }}
- name: SRE_PLATFORM_URL
  value: {{ include "sre-bot.serviceUrl" (dict "agent" "platform" "root" .) | quote }}
- name: SRE_PLATFORM_ROUTING
  value: {{ .Values.agentMode.platformRouting | quote }}
{{- end }}
{{- end }}

{{- define "sre-bot.redisSessionEnv" -}}
{{- if .Values.redis.enabled }}
- name: REDIS_URL
  value: {{ include "sre-bot.redisUrl" . | quote }}
- name: CHAT_SESSION_BACKEND
  value: {{ .Values.session.chatBackend | quote }}
- name: CHAT_SESSION_TTL_SECONDS
  value: {{ .Values.session.chatTtlSeconds | quote }}
- name: CASE_STORE_BACKEND
  value: {{ .Values.session.caseBackend | quote }}
- name: CASE_TTL_SECONDS
  value: {{ .Values.session.caseTtlSeconds | quote }}
{{- end }}
{{- end }}

{{- define "sre-bot.skillsVolumeMount" -}}
{{- if .Values.skills.configMapName }}
volumeMounts:
  - name: skills
    mountPath: /data/skills
    readOnly: true
{{- end }}
{{- end }}

{{- define "sre-bot.skillsVolume" -}}
{{- if .Values.skills.configMapName }}
volumes:
  - name: skills
    configMap:
      name: {{ .Values.skills.configMapName | quote }}
{{- end }}
{{- end }}

{{- define "sre-bot.consoleAuthEnv" -}}
- name: CONSOLE_AUTH_ENABLED
  value: {{ .Values.consoleAuth.enabled | quote }}
{{- if .Values.consoleAuth.issuer }}
- name: OIDC_ISSUER
  value: {{ .Values.consoleAuth.issuer | quote }}
{{- end }}
{{- if .Values.consoleAuth.clientId }}
- name: OIDC_CLIENT_ID
  value: {{ .Values.consoleAuth.clientId | quote }}
{{- end }}
{{- if .Values.consoleAuth.audience }}
- name: OIDC_AUDIENCE
  value: {{ .Values.consoleAuth.audience | quote }}
{{- end }}
- name: OIDC_GROUPS_CLAIM
  value: {{ .Values.consoleAuth.groupsClaim | quote }}
{{- if .Values.consoleAuth.redirectUri }}
- name: OIDC_REDIRECT_URI
  value: {{ .Values.consoleAuth.redirectUri | quote }}
{{- end }}
{{- if .Values.consoleAuth.namespaceRbac }}
- name: CONSOLE_NAMESPACE_RBAC
  value: {{ .Values.consoleAuth.namespaceRbac | toJson | quote }}
{{- end }}
- name: CONSOLE_SESSION_TTL_SEC
  value: {{ .Values.consoleAuth.sessionTtlSec | quote }}
- name: CONSOLE_COOKIE_SECURE
  value: {{ .Values.consoleAuth.cookieSecure | quote }}
- name: CONSOLE_SESSION_BACKEND
  value: {{ .Values.consoleAuth.sessionBackend | quote }}
{{- if eq .Values.consoleAuth.sessionBackend "redis" }}
- name: REDIS_URL
  value: {{ include "sre-bot.redisUrl" . | quote }}
{{- end }}
{{- if .Values.secrets.oidcClientSecret }}
- name: OIDC_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "sre-bot.secretName" . }}
      key: oidc_client_secret
{{- end }}
{{- end }}
