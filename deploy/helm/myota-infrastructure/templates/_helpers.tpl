{{- define "myota-infrastructure.name" -}}
{{- default .Release.Name .Values.nameOverride | trunc 45 | trimSuffix "-" -}}
{{- end -}}

{{- define "myota-infrastructure.labels" -}}
app.kubernetes.io/name: myota-infrastructure
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}
