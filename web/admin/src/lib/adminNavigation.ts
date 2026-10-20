import type { Account } from '../types';
import { canBrowseEntities, hasAnyScope } from './adminAccess';

export interface AdminPage {
  path: string;
  title: string;
  group: string;
  description: string;
  icon: string;
  programmeScoped?: boolean;
  allowed: (account: Account | null) => boolean;
}
const scope =
  (...scopes: string[]) =>
  (account: Account | null) =>
    hasAnyScope(account, ...scopes);
export const adminPages: AdminPage[] = [
  {
    path: '/dashboard',
    title: 'Overview',
    group: 'Start',
    icon: '⌂',
    description:
      'Your available workspaces and live signals. Only data you can access is requested.',
    allowed: (account) => Boolean(account),
  },
  {
    path: '/entity-management',
    title: 'Entity catalogue',
    group: 'Entities',
    icon: '✎',
    description:
      'Find an entity and open its focused editor. Filters and batch selection stay in place.',
    allowed: canBrowseEntities,
  },
  {
    path: '/entity-map',
    title: 'Entity map',
    group: 'Entities',
    icon: '◉',
    description:
      'Explore catalogue geometries and their location, categories and programme memberships.',
    allowed: canBrowseEntities,
  },
  {
    path: '/geodata',
    title: 'Geodata review',
    group: 'Entities',
    icon: '⌖',
    description:
      'Review candidates, compare their sources and make an audited status decision.',
    allowed: scope('geodata.review'),
  },
  {
    path: '/geodata-imports',
    title: 'Geodata imports',
    group: 'Entities',
    icon: '⇧',
    description:
      'Upload sources, follow preprocessing and promote selected records. Imports are programme-independent.',
    allowed: scope('geodata.import'),
  },
  {
    path: '/conflation',
    title: 'Conflation review',
    group: 'Entities',
    icon: '⇄',
    description:
      'Compare likely duplicate entities and record an auditable resolution.',
    allowed: scope('geodata.review'),
  },
  {
    path: '/master-data',
    title: 'Entity categories',
    group: 'Entities',
    icon: '▦',
    description:
      'Shared master data for geometry and classification. Programme membership is managed in Programme settings.',
    allowed: (account) =>
      canBrowseEntities(account) || hasAnyScope(account, 'programme.admin'),
  },
  {
    path: '/programmes',
    title: 'Programmes',
    group: 'Programmes',
    icon: '◈',
    description:
      'Configure each initiative’s name, theme, category memberships and programme-owned rules.',
    allowed: scope('programme.admin'),
  },
  {
    path: '/policies',
    title: 'Rules & policies',
    group: 'Programmes',
    icon: '✓',
    description:
      'Draft, review and explicitly publish programme-owned policies. Certificate design is a separate workspace.',
    programmeScoped: true,
    allowed: scope('programme.admin'),
  },
  {
    path: '/content',
    title: 'Content & translations',
    group: 'Programmes',
    icon: '文',
    description:
      'Manage content drafts, review, publication and locale coverage for the selected programme.',
    programmeScoped: true,
    allowed: scope('programme.admin'),
  },
  {
    path: '/awards',
    title: 'Awards & certificates',
    group: 'Programmes',
    icon: '▣',
    description:
      'Design programme-owned awards, manage artwork and inspect requests and permanent certificates.',
    programmeScoped: true,
    allowed: scope('awards.read', 'awards.admin'),
  },
  {
    path: '/identity',
    title: 'Users & access',
    group: 'People',
    icon: '◎',
    description:
      'Manage users and scope-bound role assignments, custom permissions and security events.',
    allowed: scope(
      'identity.admin',
      'identity.accounts.create',
      'identity.roles.manage',
    ),
  },
  {
    path: '/activity',
    title: 'Activations & QSOs',
    group: 'Activity',
    icon: '◷',
    description:
      'Read activation history and its QSO counts through the activity API.',
    allowed: scope('activity.read', 'activity.admin'),
  },
  {
    path: '/grafana',
    title: 'Metrics & dashboards',
    group: 'Platform health',
    icon: '⌁',
    description: 'View authenticated Grafana dashboards and metrics.',
    allowed: scope('observability.view'),
  },
];

export function pageFor(path: string): AdminPage | undefined {
  return adminPages.find((page) => page.path === path);
}

export function availablePages(account: Account | null): AdminPage[] {
  return adminPages.filter((page) => page.allowed(account));
}
