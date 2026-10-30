<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { apiRequest } from '../lib/api';
import type { GeoEntity } from '../types';

type Geometry = NonNullable<GeoEntity['geometry']>;

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
    viewportManaged?: boolean;
    geometrySimplification?: 'auto' | 'server' | 'none';
    initialView?: { center: [number, number]; zoom: number };
  }>(),
  {
    height: '620px',
    drawing: false,
    drawingMode: 'POLYGON',
    showClusters: true,
    viewportManaged: false,
    geometrySimplification: 'auto',
    initialView: () => ({ center: [37.395, -5.995], zoom: 12 }),
  },
);
const emit = defineEmits<{
  select: [entity: GeoEntity];
  'geometry-change': [geometry: { type: string; coordinates: unknown }];
  'draw-created': [geometry: { type: string; coordinates: unknown }];
  'viewport-change': [
    viewport: {
      bbox: [number, number, number, number];
      zoom: number;
    },
  ];
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
let simplificationTimer: number | undefined;
let simplificationRequest = 0;
const simplifiedGeometryByZoom = new Map<number, Map<string, Geometry>>();

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
      if (props.viewportManaged) emitViewportChange();
      else if (props.selectedId) focusSelected(false);
      else fitAll();
    }
    mapWasVisible = true;
  });
  resizeObserver.observe(mapElement.value);
});
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  if (simplificationTimer !== undefined)
    window.clearTimeout(simplificationTimer);
  simplificationRequest += 1;
});

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
function values(entity: GeoEntity, key: string): string {
  return String(entity.location?.[key] || '');
}
function popupText(entity: GeoEntity): HTMLElement {
  const categories = (entity.entityTypes || [])
    .map((item) => (typeof item === 'string' ? item : item.code))
    .join(', ');
  const programmes = (entity.programmes || [])
    .map((item) => (typeof item === 'string' ? item : item.name || item.slug))
    .join(', ');
  const content = document.createElement('div');
  content.className = 'myota-entity-popup-content';
  content.style.setProperty('background-color', '#fff', 'important');
  content.style.setProperty('color', '#142b2d', 'important');
  const heading = document.createElement('strong');
  heading.textContent = String(entity.name ?? '');
  heading.style.setProperty('background-color', '#fff', 'important');
  heading.style.setProperty('color', '#142b2d', 'important');
  content.append(heading, document.createElement('br'));
  const details = [
    `Status: ${String(entity.status ?? '')}`,
    `Category: ${categories || entity.entityType || '—'}`,
    `Programmes: ${programmes || 'Unassigned'}`,
    `Location: ${[values(entity, 'city'), values(entity, 'region'), values(entity, 'country')].filter(Boolean).join(', ') || '—'}`,
  ];
  details.forEach((detail, index) => {
    if (index > 0) content.append(document.createElement('br'));
    content.append(document.createTextNode(detail));
  });
  return content;
}
function geometryForDisplay(entity: GeoEntity): Geometry | undefined {
  if (entity.id === props.editableId) return entity.geometry;
  if (props.geometrySimplification !== 'none' && map) {
    return (
      simplifiedGeometryByZoom.get(Math.floor(map.getZoom()))?.get(entity.id) ||
      entity.geometry
    );
  }
  return entity.geometry;
}
function feature(
  entity: GeoEntity,
  geometry = geometryForDisplay(entity),
): any {
  return {
    type: 'Feature',
    id: entity.id,
    properties: { name: entity.name, status: entity.status },
    geometry,
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
  const geometry = geometryForDisplay(entity);
  if (!map || !window.L || !geometry) return;
  const selected = entity.id === props.selectedId;
  const baseStyle = styleFor(entity, selected);
  const line = ['LineString', 'MultiLineString'].includes(geometry.type)
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
  const group = window.L.geoJSON(feature(entity, geometry), {
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
function renderLayers(fit = true): void {
  if (!map || !window.L) return;
  geometryLayers?.clearLayers();
  pointCluster?.clearLayers();
  layerById = new Map();
  props.entities.filter((entity) => entity.geometry).forEach(addEntity);
  if (fit && !props.selectedId && !props.viewportManaged) fitAll();
  applyEditing();
}
function emitViewportChange(): void {
  if (!map || !props.viewportManaged) return;
  const bounds = map.getBounds();
  emit('viewport-change', {
    bbox: [
      bounds.getWest(),
      bounds.getSouth(),
      bounds.getEast(),
      bounds.getNorth(),
    ],
    zoom: Math.max(0, Math.floor(map.getZoom())),
  });
}
async function simplifyForCurrentZoom(): Promise<void> {
  if (!map || !window.L || props.geometrySimplification !== 'auto') return;
  if (simplificationTimer !== undefined) {
    window.clearTimeout(simplificationTimer);
    simplificationTimer = undefined;
  }
  const zoom = Math.max(0, Math.floor(map.getZoom()));
  simplificationRequest += 1;
  if (simplifiedGeometryByZoom.has(zoom)) return;
  const candidates = props.entities
    .filter((entity) => entity.geometry && entity.id !== props.editableId)
    .map((entity) => ({ id: entity.id, geometry: entity.geometry }));
  if (!candidates.length) return;
  const request = simplificationRequest;
  simplificationTimer = window.setTimeout(() => {
    simplificationTimer = undefined;
    const batches: Array<typeof candidates> = [];
    let batch: typeof candidates = [];
    let batchBytes = 0;
    for (const item of candidates) {
      const itemBytes = JSON.stringify(item).length;
      if (itemBytes > 3 * 1024 * 1024) continue;
      if (batch.length >= 500 || batchBytes + itemBytes > 3 * 1024 * 1024) {
        batches.push(batch);
        batch = [];
        batchBytes = 0;
      }
      batch.push(item);
      batchBytes += itemBytes;
    }
    if (batch.length) batches.push(batch);
    void Promise.all(
      batches.map((items) =>
        apiRequest<{ items?: Array<{ id: string; geometry: Geometry }> }>(
          '/v1/geodata/map/simplify',
          { method: 'POST', body: JSON.stringify({ zoom, items }) },
        ),
      ),
    )
      .then((results) => {
        if (
          request !== simplificationRequest ||
          !map ||
          Math.floor(map.getZoom()) !== zoom
        )
          return;
        simplifiedGeometryByZoom.set(
          zoom,
          new Map(
            results.flatMap((result) =>
              (result.items || []).map(
                (item) => [item.id, item.geometry] as const,
              ),
            ),
          ),
        );
        while (simplifiedGeometryByZoom.size > 2) {
          const oldestZoom = simplifiedGeometryByZoom.keys().next().value;
          if (oldestZoom === undefined) break;
          simplifiedGeometryByZoom.delete(oldestZoom);
        }
        renderLayers(false);
      })
      .catch(() => {
        // Keep the canonical geometry visible if map generalization is unavailable.
      });
  }, 100);
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
  map.setView(props.initialView.center, props.initialView.zoom);
  map.on('moveend', emitViewportChange);
  map.on('zoomend', () => {
    emitViewportChange();
    void simplifyForCurrentZoom();
  });
  renderLayers();
  syncDrawing();
  window.setTimeout(() => {
    map?.invalidateSize?.();
    emitViewportChange();
    void simplifyForCurrentZoom();
    focusSelected();
  }, 0);
});
watch(
  () => props.entities,
  () => {
    simplifiedGeometryByZoom.clear();
    renderLayers();
    void simplifyForCurrentZoom();
  },
  { deep: true },
);
watch(
  () => props.selectedId,
  () => {
    renderLayers();
    void simplifyForCurrentZoom();
    focusSelected();
  },
);
watch(
  () => props.editableId,
  () => {
    renderLayers();
    void simplifyForCurrentZoom();
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
