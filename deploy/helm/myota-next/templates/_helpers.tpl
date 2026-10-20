{{- define "myota-next.name" -}}
{{- default .Release.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "myota-next.labels" -}}
app.kubernetes.io/name: {{ include "myota-next.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "myota-next.image" -}}
{{- $image := .image -}}
{{- $name := .name -}}
{{- $repository := required (printf "images.%s.repository is required" $name) $image.repository -}}
{{- if $image.digest -}}
{{- printf "%s@%s" $repository $image.digest -}}
{{- else -}}
{{- printf "%s:%s" $repository (required (printf "images.%s.tag or digest is required" $name) $image.tag) -}}
{{- end -}}
{{- end -}}

{{- define "myota-next.env" -}}
{{- $root := .root -}}
{{- range $key, $value := .env }}
- name: {{ $key }}
  {{- if kindIs "map" $value }}
  valueFrom:
    secretKeyRef:
      name: {{ index $root.Values.secrets $value.secret }}
      key: {{ $value.key }}
      {{- if hasKey $value "optional" }}
      optional: {{ $value.optional }}
      {{- end }}
  {{- else }}
  value: {{ tpl (toString $value) $root | quote }}
  {{- end }}
{{- end }}
- name: MYOTA_ENV
  value: {{ $root.Values.environment | quote }}
{{- if $root.Values.buildVersion }}
- name: MYOTA_BUILD_VERSION
  value: {{ $root.Values.buildVersion | quote }}
{{- end }}
{{- if $root.Values.observe.enabled }}
- name: OBSERVE_APP_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $root.Values.observe.secretName }}
      key: {{ $root.Values.observe.appKeyKey }}
      optional: true
- name: OBSERVE_APP_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ $root.Values.observe.secretName }}
      key: {{ $root.Values.observe.appSecretKey }}
      optional: true
{{- end }}
{{- end -}}
