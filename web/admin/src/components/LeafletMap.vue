<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { GeoEntity } from '../types';

declare global {
  interface Window {
    L?: any;
    MYOTA_TILE_URL?: string;
  }
}

const props = withDefaults(
  defineProps<{
    entities: GeoEntity[];
    selectedId?: string;
    height?: string;
    editableId?: string;
    drawing?: boolean;
    drawingMode?: 'POINT' | 'WAY' | 'POLYGON';
    showClusters?: boolean;
  }>(),
  {
    height: '620px',
    drawing: false,
    drawingMode: 'POLYGON',
    showClusters: true,
  },
);
const emit = defineEmits<{
  select: [entity: GeoEntity];
  'geometry-change': [geometry: { type: string; coordinates: unknown }];
  'draw-created': [geometry: { type: string; coordinates: unknown }];
}>();

const mapElement = ref<HTMLElement | null>(null);
let map: any = null;
let geometryLayers: any = null;
let pointCluster: any = null;
let layerById = new Map<string, any>();
let editingLayer: any = null;
let drawingLayer: any = null;
let resizeObserver: ResizeObserver | undefined;
let mapWasVisible = false;

// Maps can now live in dialogs and collapsed catalogue panels. Recompute tile
// placement when the actual container becomes visible or changes size.
onMounted(() => {
  if (!mapElement.value) return;
  resizeObserver = new ResizeObserver(() => {
    if (
      !map ||
      !mapElement.value?.clientWidth ||
      !mapElement.value.clientHeight
    ) {
      mapWasVisible = false;
      return;
    }
    map.invalidateSize({ pan: false });
    if (!mapWasVisible) {
      if (props.selectedId) focusSelected(false);
      else fitAll();
    }
    mapWasVisible = true;
  });
  resizeObserver.observe(mapElement.value);
});
onBeforeUnmount(() => resizeObserver?.disconnect());

const colors: Record<string, [string, string]> = {
  CANDIDATE: ['#fbbf24', '#7c5410'],
  APPROVED: ['#10b981', '#065f46'],
  RETIRED: ['#94a3b8', '#475569'],
  REJECTED: ['#ef4444', '#991b1b'],
};
function styleFor(
  entity: GeoEntity,
  selected = false,
): Record<string, unknown> {
  const [fillColor, color] = colors[entity.status] || colors.CANDIDATE;
  return {
    color: selected ? '#123d3a' : color,
    fillColor,
    fillOpacity: selected ? 0.42 : 0.28,
    weight: selected ? 4 : 2,
    radius: selected ? 10 : 8,
  };
}
function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ] || character,
  );
}
function values(entity: GeoEntity, key: string): string {
  return String(entity.location?.[key] || '');
}
function popupText(entity: GeoEntity): string {
  const categories = (entity.entityTypes || [])
    .map((item) => (typeof item === 'string' ? item : item.code))
    .join(', ');
  const programmes = (entity.programmes || [])
    .map((item) => (typeof item === 'string' ? item : item.name || item.slug))
    .join(', ');
  return `<div style="background:#fff;color:#142b2d"><strong>${escapeHtml(entity.name)}</strong><br>Status: ${escapeHtml(entity.status)}<br>Category: ${escapeHtml(categories || entity.entityType || '—')}<br>Programmes: ${escapeHtml(programmes || 'Unassigned')}<br>Location: ${escapeHtml([values(entity, 'city'), values(entity, 'region'), values(entity, 'country')].filter(Boolean).join(', ') || '—')}</div>`;
}
function feature(entity: GeoEntity): any {
  return {
    type: 'Feature',
    id: entity.id,
    properties: { name: entity.name, status: entity.status },
    geometry: entity.geometry,
  };
}
function layerGeometry(
  layer: any,
): { type: string; coordinates: unknown } | null {
  return layer?.toGeoJSON?.()?.geometry || null;
}
function clusterIcon(cluster: any): any {
  return window.L.divIcon({
    className: 'myota-entity-cluster',
    html: `<span>${cluster.getChildCount()}</span>`,
    iconSize: [42, 42],
    iconAnchor: [21, 21],
  });
}
function entityMarkerIcon(entity: GeoEntity, selected: boolean): any {
  const [, color] = colors[entity.status] || colors.CANDIDATE;
  return window.L.divIcon({
    className: `myota-entity-marker${selected ? ' selected' : ''}`,
    html: `<span style="background:${color}"></span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}
function isClusteredPoint(entity: GeoEntity): boolean {
  return Boolean(
    props.showClusters &&
      pointCluster &&
      pointCluster !== geometryLayers &&
      entity.geometry?.type === 'Point' &&
      entity.id !== props.editableId,
  );
}

function addEntity(entity: GeoEntity): void {
  if (!map || !window.L || !entity.geometry) return;
  const selected = entity.id === props.selectedId;
  const baseStyle = styleFor(entity, selected);
  const line = ['LineString', 'MultiLineString'].includes(entity.geometry.type)
    ? { ...baseStyle, dashArray: '8 6', lineCap: 'round', lineJoin: 'round' }
    : baseStyle;
  // MarkerCluster only manages regular markers. Keep the point currently being
  // edited in the geometry layer while continuing to cluster every other point.
  const clusteredPoint = isClusteredPoint(entity);
  const pointToLayer = (_feature: unknown, latlng: unknown) =>
    clusteredPoint
      ? window.L.marker(latlng, {
          icon: entityMarkerIcon(entity, selected),
          keyboard: true,
          title: entity.name || 'Unnamed entity',
        })
      : window.L.circleMarker(latlng, line);
  const group = window.L.geoJSON(feature(entity), {
    style: line,
    pointToLayer,
  });
  let interactive: any = null;
  group.eachLayer((item: any) => {
    interactive = item;
  });
  if (!interactive) return;
  interactive.bindTooltip(`${entity.name} · ${entity.status}`, {
    direction: 'top',
    sticky: true,
  });
  interactive.bindPopup(popupText(entity), {
    maxWidth: 340,
    minWidth: 250,
    className: 'myota-entity-popup',
  });
  interactive.on('click', (event: any) => {
    window.L.DomEvent.stopPropagation(event);
    emit('select', entity);
  });
  interactive.on('pm:edit', () => {
    const geometry = layerGeometry(interactive);
    if (geometry) emit('geometry-change', geometry);
  });
  layerById.set(entity.id, interactive);
  const target = clusteredPoint ? pointCluster : geometryLayers;
  group.addTo(target);
}
function renderLayers(): void {
  if (!map || !window.L) return;
  geometryLayers?.clearLayers();
  pointCluster?.clearLayers();
  layerById = new Map();
  props.entities.filter((entity) => entity.geometry).forEach(addEntity);
  if (!props.selectedId) fitAll();
  applyEditing();
}
function fitAll(): void {
  const bounds = window.L.latLngBounds([]);
  props.entities
    .filter((entity) => entity.geometry)
    .forEach((entity) => {
      const next = window.L.geoJSON(feature(entity)).getBounds();
      if (next.isValid()) bounds.extend(next);
    });
  if (bounds.isValid())
    map.fitBounds(bounds, { padding: [35, 35], maxZoom: 16 });
}
function focusSelected(animate = true): void {
  const entity = props.entities.find((item) => item.id === props.selectedId);
  if (!map || !entity?.geometry || !window.L) return;
  const layer = layerById.get(entity.id);
  if (layer && pointCluster?.hasLayer?.(layer) && pointCluster.zoomToShowLayer)
    pointCluster.zoomToShowLayer(layer, () => layer.openPopup?.());
  const bounds = window.L.geoJSON(feature(entity)).getBounds();
  if (!bounds.isValid()) return;
  if (entity.geometry.type === 'Point')
    map.setView(bounds.getCenter(), Math.max(map.getZoom(), 15), { animate });
  else map.fitBounds(bounds, { padding: [70, 70], maxZoom: 17, animate });
}
function applyEditing(): void {
  if (editingLayer?.pm) editingLayer.pm.disable();
  editingLayer = null;
  if (!props.editableId) return;
  editingLayer = layerById.get(props.editableId);
  if (typeof editingLayer?.pm?.enable === 'function') {
    editingLayer.pm.enable({ allowSelfIntersection: false, snappable: true });
    editingLayer.bringToFront?.();
  }
}
function disableDrawing(): void {
  map?.pm?.disableDraw?.();
  drawingLayer?.remove?.();
  drawingLayer = null;
}
function syncDrawing(): void {
  if (!map?.pm) return;
  disableDrawing();
  if (!props.drawing) return;
  const shape =
    props.drawingMode === 'POINT'
      ? 'CircleMarker'
      : props.drawingMode === 'WAY'
        ? 'Line'
        : 'Polygon';
  map.pm.enableDraw(shape, {
    snappable: true,
    allowSelfIntersection: false,
    markerStyle: {
      radius: 8,
      color: '#123d3a',
      fillColor: '#10b981',
      fillOpacity: 0.9,
    },
  });
}
function handleCreate(event: any): void {
  if (!props.drawing) {
    event.layer?.remove?.();
    return;
  }
  drawingLayer?.remove?.();
  drawingLayer = event.layer;
  map?.pm?.disableDraw?.();
  const geometry = layerGeometry(drawingLayer);
  if (geometry) emit('draw-created', geometry);
}

onMounted(async () => {
  await nextTick();
  if (!mapElement.value || !window.L) return;
  map = window.L.map(mapElement.value, {
    zoomControl: true,
    attributionControl: true,
    minZoom: 2,
    maxZoom: 19,
    worldCopyJump: false,
    preferCanvas: true,
  });
  window.L.tileLayer(
    window.MYOTA_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
      maxZoom: 19,
      maxNativeZoom: 19,
      noWrap: true,
      keepBuffer: 1,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> · <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noopener">Report a map issue</a>',
    },
  ).addTo(map);
  geometryLayers = window.L.layerGroup().addTo(map);
  pointCluster =
    props.showClusters && window.L.markerClusterGroup
      ? window.L.markerClusterGroup({
          showCoverageOnHover: false,
          spiderfyOnMaxZoom: true,
          chunkedLoading: true,
          maxClusterRadius: 52,
          iconCreateFunction: clusterIcon,
        })
      : geometryLayers;
  if (pointCluster !== geometryLayers) pointCluster.addTo(map);
  map.on('pm:create', handleCreate);
  map.setView([37.395, -5.995], 12);
  renderLayers();
  syncDrawing();
  window.setTimeout(() => {
    map?.invalidateSize?.();
    focusSelected();
  }, 0);
});
watch(() => props.entities, renderLayers, { deep: true });
watch(
  () => props.selectedId,
  () => {
    renderLayers();
    focusSelected();
  },
);
watch(
  () => props.editableId,
  () => {
    renderLayers();
    focusSelected();
  },
);
watch(() => [props.drawing, props.drawingMode], syncDrawing);
onBeforeUnmount(() => {
  disableDrawing();
  map?.remove();
  map = null;
});
</script>

<template>
  <div
    ref="mapElement"
    class="leaflet-map"
    :style="{ height }"
    role="application"
    aria-label="OpenStreetMap entity map"
  ></div>
</template>
