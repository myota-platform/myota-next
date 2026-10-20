import { createRouter, createWebHistory } from 'vue-router';
import { accessToken } from './lib/api';
import LoginView from './views/LoginView.vue';
import DashboardView from './views/DashboardView.vue';
import ProgrammesView from './views/ProgrammesView.vue';
import PoliciesView from './views/PoliciesView.vue';
import ContentView from './views/ContentView.vue';
import MasterDataView from './views/MasterDataView.vue';
import IdentityView from './views/IdentityView.vue';
import ActivityView from './views/ActivityView.vue';
import AwardsView from './views/AwardsView.vue';
import GeodataImportsView from './views/GeodataImportsView.vue';
import ConflationView from './views/ConflationView.vue';
import RefreshSchedulesView from './views/RefreshSchedulesView.vue';
import GeodataWorkspaceView from './views/GeodataWorkspaceView.vue';
import EntityMapView from './views/EntityMapView.vue';
import SeaweedFsMonitoringRedirectView from './views/SeaweedFsMonitoringRedirectView.vue';
import ObservabilityView from './views/ObservabilityView.vue';
import AccessDeniedView from './views/AccessDeniedView.vue';
import { pageFor } from './lib/adminNavigation';
import { useAppStore } from './stores/app';

const routes = [
  { path: '/login', component: LoginView, meta: { public: true } },
  { path: '/', redirect: '/dashboard' },
  {
    path: '/dashboard',
    component: DashboardView,
    meta: { title: 'Dashboard' },
  },
  {
    path: '/programmes',
    component: ProgrammesView,
    meta: { title: 'Programmes' },
  },
  {
    path: '/policies',
    component: PoliciesView,
    meta: { title: 'Programme policy' },
  },
  {
    path: '/content',
    component: ContentView,
    meta: { title: 'Content & translations' },
  },
  {
    path: '/master-data',
    component: MasterDataView,
    meta: { title: 'Master data' },
  },
  {
    path: '/identity',
    component: IdentityView,
    meta: { title: 'Users & roles' },
  },
  {
    path: '/activity',
    component: ActivityView,
    meta: { title: 'Activations & QSOs' },
  },
  {
    path: '/awards',
    component: AwardsView,
    meta: { title: 'Award certificates' },
  },
  {
    path: '/geodata',
    component: GeodataWorkspaceView,
    props: { mode: 'review' },
    meta: { title: 'Review queue' },
  },
  {
    path: '/entity-management',
    component: GeodataWorkspaceView,
    props: { mode: 'management' },
    meta: { title: 'Entity catalogue' },
  },
  {
    path: '/entity-map',
    component: EntityMapView,
    meta: { title: 'Map explorer' },
  },
  {
    path: '/geodata-imports',
    component: GeodataImportsView,
    meta: { title: 'Geodata imports' },
  },
  {
    path: '/conflation',
    component: ConflationView,
    meta: { title: 'Conflation review' },
  },
  {
    path: '/refresh-schedules',
    component: RefreshSchedulesView,
    meta: { title: 'Refresh schedules' },
  },
  {
    path: '/object-storage',
    component: SeaweedFsMonitoringRedirectView,
    meta: { title: 'SeaweedFS monitoring moved' },
  },
  {
    path: '/grafana',
    component: ObservabilityView,
    meta: { title: 'Metrics & dashboards' },
  },
  {
    path: '/access-denied',
    component: AccessDeniedView,
    meta: { title: 'Access not available' },
  },
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes: routes.map((route) => ({
    ...route,
    meta: {
      ...route.meta,
      ...(pageFor(route.path) ? { title: pageFor(route.path)!.title } : {}),
    },
  })),
});

router.beforeEach(async (to) => {
  if (to.meta.public) return true;
  if (!accessToken())
    return { path: '/login', query: { redirect: to.fullPath } };
  const store = useAppStore();
  if (!(await store.bootstrap()))
    return { path: '/login', query: { redirect: to.fullPath } };
  const page = pageFor(to.path);
  if (page && !page.allowed(store.account)) return { path: '/access-denied' };
  return true;
});
