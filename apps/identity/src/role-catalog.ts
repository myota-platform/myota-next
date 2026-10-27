export interface RoleDefinition {
  code: string;
  name: string;
  description: string;
  scopes: string[];
  system: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export const ADMIN_PERMISSION_CATALOG = [
  {
    code: 'observability.view',
    label: 'View platform metrics and dashboards',
    group: 'Observability',
  },
  {
    code: 'identity.accounts.create',
    label: 'Create participant accounts',
    group: 'Identity',
  },
  {
    code: 'identity.admin',
    label: 'View and edit user accounts',
    group: 'Identity',
  },
  {
    code: 'identity.participants.manage',
    label: 'Manage participant accounts',
    group: 'Identity',
  },
  {
    code: 'identity.roles.assign',
    label: 'Assign roles to users',
    group: 'Identity',
  },
  {
    code: 'identity.roles.manage',
    label: 'Create and edit role definitions',
    group: 'Identity',
  },
  {
    code: 'identity.audit.read',
    label: 'View identity audit events',
    group: 'Identity',
  },
  { code: 'callsign.verify', label: 'Verify callsigns', group: 'Identity' },
  {
    code: 'programme.admin',
    label: 'Administer programmes',
    group: 'Programmes',
  },
  {
    code: 'programme.policy.manage',
    label: 'Manage programme rules and awards',
    group: 'Programmes',
  },
  {
    code: 'programme.content.manage',
    label: 'Manage programme content and translations',
    group: 'Programmes',
  },
  { code: 'geodata.review', label: 'Review geodata', group: 'Geodata' },
  { code: 'geodata.import', label: 'Import geodata', group: 'Geodata' },
  {
    code: 'geodata.geometry.manage',
    label: 'Change entity geometry types',
    group: 'Geodata',
  },
  {
    code: 'geodata.delete',
    label: 'Delete rejected geodata',
    group: 'Geodata',
  },
  {
    code: 'activity.read',
    label: 'Read activity and results',
    group: 'Activity',
  },
  {
    code: 'activity.admin',
    label: 'Administer activity and awards',
    group: 'Activity',
  },
  {
    code: 'audit.read',
    label: 'View platform audit records',
    group: 'Operations',
  },
  {
    code: 'identity.service.issue',
    label: 'Issue service credentials',
    group: 'Operations',
  },
  {
    code: 'identity.oidc.configure',
    label: 'Configure programme OIDC',
    group: 'Operations',
  },
] as const;

export const DEFAULT_ROLE_DEFINITIONS: RoleDefinition[] = [
  {
    code: 'PARTICIPANT',
    name: 'Participant',
    description: 'Base participant access without administrative permissions.',
    scopes: [],
    system: true,
  },
  {
    code: 'GLOBAL_OPERATOR',
    name: 'Global administrator',
    description: 'Full platform administration, including role management.',
    scopes: ['*'],
    system: true,
  },
  {
    code: 'IDENTITY_ADMIN',
    name: 'Identity administrator',
    description: 'Manage users, callsigns and role assignments.',
    scopes: [
      'identity.accounts.create',
      'identity.admin',
      'identity.roles.assign',
      'identity.audit.read',
      'callsign.verify',
    ],
    system: true,
  },
  {
    code: 'PARTICIPANT_ADMIN',
    name: 'Participant Administrator',
    description:
      'View and manage participant accounts without broader Identity administration.',
    scopes: ['identity.participants.manage'],
    system: true,
  },
  {
    code: 'GIS_ADMIN',
    name: 'GIS administrator',
    description: 'Review, import, edit and remove rejected geodata.',
    scopes: [
      'geodata.review',
      'geodata.import',
      'geodata.geometry.manage',
      'geodata.delete',
    ],
    system: true,
  },
  {
    code: 'GEO_APPROVER',
    name: 'Geodata approver',
    description: 'Review scoped geodata proposals.',
    scopes: ['geodata.review'],
    system: true,
  },
  {
    code: 'PROGRAMME_ADMIN',
    name: 'Programme administrator',
    description: 'Manage programme configuration and published content.',
    scopes: [
      'programme.admin',
      'programme.policy.manage',
      'programme.content.manage',
    ],
    system: true,
  },
  {
    code: 'ACTIVITY_ADMIN',
    name: 'Activity administrator',
    description: 'Manage activations, QSOs, awards and execution operations.',
    scopes: ['activity.read', 'activity.admin'],
    system: true,
  },
  {
    code: 'AUDITOR',
    name: 'Auditor',
    description: 'Read platform audit and security records.',
    scopes: ['audit.read', 'identity.audit.read'],
    system: true,
  },
];

export const DEFAULT_ROLE_SCOPES = Object.fromEntries(
  DEFAULT_ROLE_DEFINITIONS.map(({ code, scopes }) => [code, scopes]),
) as Record<string, string[]>;
