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
