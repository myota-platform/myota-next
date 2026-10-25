{{- define "myota-next.name" -}}
{{- default .Release.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "myota-next.labels" -}}
app.kubernetes.io/name: {{ include "myota-next.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "myota-next.podLabels" -}}
{{- $name := include "myota-next.name" . -}}
{{- $reserved := dict
  "app.kubernetes.io/instance" .Release.Name
  "app.kubernetes.io/component" .component
  "app.kubernetes.io/name" $name
}}
{{- toYaml (mergeOverwrite (dict) .Values.podLabels $reserved) -}}
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

{{- define "myota-next.geodata-worker-policy-env" -}}
{{- $settings := .Values.geodataWorker.maxAckPending -}}
{{- $overrides := dict
  "GEODATA_WORKER_PREPROCESSING_MAX_ACK_PENDING" $settings.preprocessing
  "GEODATA_WORKER_PROMOTION_MAX_ACK_PENDING" $settings.promotion
  "GEODATA_WORKER_DELETION_MAX_ACK_PENDING" $settings.deletion
  "GEODATA_WORKER_ENRICHMENT_MAX_ACK_PENDING" $settings.enrichment
  "MYOTA_IMPORT_WORKERS" .Values.geodataWorker.legacyConcurrency.import
  "MYOTA_DELETION_WORKERS" .Values.geodataWorker.legacyConcurrency.deletion
  "MYOTA_LOCATION_WORKERS" .Values.geodataWorker.legacyConcurrency.location
}}
{{- range $name, $value := $overrides }}
{{- if $value }}
- name: {{ $name }}
  value: {{ $value | toString | quote }}
{{- end }}
{{- end }}
{{- end -}}

{{- define "myota-next.geodata-worker-attempt-env" -}}
- name: GEODATA_IMPORT_MAX_ATTEMPTS
  value: {{ .Values.geodataWorker.importMaxAttempts | toString | quote }}
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
{{- if .observe }}
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
