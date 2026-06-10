{{/*
  LLM env block — include in brain and commander containers.
  Usage: {{- include "sre-bot.llmEnv" . | nindent 12 }}
*/}}
{{- define "sre-bot.llmEnv" -}}
- name: LLM_PROVIDER
  value: {{ .Values.llm.provider | quote }}
- name: OPENROUTER_BRAIN_MODEL
  value: {{ .Values.llm.openrouter.brainModel | quote }}
- name: OPENROUTER_COMMANDER_MODEL
  value: {{ .Values.llm.openrouter.commanderModel | quote }}
- name: OPENROUTER_TOOL_SELECT_MODEL
  value: {{ .Values.llm.openrouter.toolSelectModel | quote }}
- name: GEMINI_BRAIN_MODEL
  value: {{ .Values.llm.gemini.brainModel | quote }}
- name: GEMINI_COMMANDER_MODEL
  value: {{ .Values.llm.gemini.commanderModel | quote }}
- name: GEMINI_TOOL_SELECT_MODEL
  value: {{ .Values.llm.gemini.commanderModel | quote }}
- name: GEMINI_MODEL
  value: {{ .Values.llm.gemini.brainModel | quote }}
{{- end }}
