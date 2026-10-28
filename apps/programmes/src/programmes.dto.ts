import {
  Allow,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateNested,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { pythonTruthy } from '@app/platform/python-truthiness.js';

const LOCATION_QUALIFIER_FIELDS = [
  'continent',
  'country',
  'countryCode',
  'region',
  'regionCode',
  'subdivision',
  'subdivisionCode',
  'province',
  'provinceCode',
  'county',
  'countyCode',
  'city',
  'municipality',
  'locality',
] as const;

export class ProgrammeEntityNumberingDto {
  @IsString()
  @Matches(/^[A-Z0-9]{1,4}$/)
  identifier!: string;

  @IsIn(['NONE', 'MANUAL', 'LOCATION'])
  qualifierMode!: 'NONE' | 'MANUAL' | 'LOCATION';

  @ValidateIf(
    (value: ProgrammeEntityNumberingDto) => value.qualifierMode === 'LOCATION',
  )
  @IsIn(LOCATION_QUALIFIER_FIELDS)
  qualifierField?: (typeof LOCATION_QUALIFIER_FIELDS)[number];

  @IsInt()
  @Min(3)
  @Max(6)
  serialWidth!: number;

  @IsIn(['PROGRAMME_SEQUENCE', 'QUALIFIER_SEQUENCE', 'MANUAL'])
  assignmentMode!: 'PROGRAMME_SEQUENCE' | 'QUALIFIER_SEQUENCE' | 'MANUAL';
}

function validateContentPatchFields(object: { status?: unknown }) {
  return !pythonTruthy(object.status);
}

export class CreateProgrammeDto {
  @IsString()
  slug!: string;

  @IsString()
  name!: string;

  @IsArray()
  @IsObject({ each: true })
  entityTypes!: Record<string, unknown>[];

  @IsObject()
  rules!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsObject()
  theme?: Record<string, unknown> | null;

  @IsOptional()
  @IsObject()
  oidc?: Record<string, unknown> | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => ProgrammeEntityNumberingDto)
  entityNumbering?: ProgrammeEntityNumberingDto | null;

  @Allow()
  policyVersion?: unknown;
}

export class EntityTypeDto {
  @IsString()
  code!: string;

  @IsOptional()
  @IsString()
  originalCode?: string;

  @IsString()
  label!: string;

  @IsOptional()
  @IsString()
  geometry?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  geometryTypes?: string[];

  @IsOptional()
  @IsString()
  description?: string;

  @Allow()
  active?: unknown;
}

export class SaveProgrammeContentDto {
  @IsOptional()
  @IsString()
  contentId?: string;

  @IsString()
  @MinLength(1)
  key!: string;

  @IsString()
  @MinLength(1)
  locale!: string;

  @Allow()
  value!: unknown;

  @IsOptional()
  @IsString()
  fallbackLocale?: string | null;
}

export class ReviewProgrammeContentDto {
  @Allow()
  decision!: unknown;

  @Allow()
  reviewerId!: unknown;

  @Allow()
  note?: unknown;
}

export class PublishProgrammeContentDto {
  @Allow()
  effectiveFrom!: unknown;

  @Allow()
  publisherId!: unknown;
}

export class PatchProgrammeContentDto {
  @Allow()
  status?: unknown;

  @ValidateIf(validateContentPatchFields)
  @IsOptional()
  @IsString()
  key?: string;

  @ValidateIf(validateContentPatchFields)
  @IsOptional()
  @IsString()
  locale?: string;

  @ValidateIf(validateContentPatchFields)
  @IsOptional()
  @Allow()
  value?: unknown;

  @ValidateIf(validateContentPatchFields)
  @IsOptional()
  @IsString()
  fallbackLocale?: string | null;

  @ValidateIf(validateContentPatchFields)
  @IsOptional()
  @IsIn(['APPROVED', 'CHANGES_REQUESTED'])
  decision?: 'APPROVED' | 'CHANGES_REQUESTED';

  @ValidateIf(validateContentPatchFields)
  @IsOptional()
  @IsString()
  reviewerId?: string;

  @ValidateIf(validateContentPatchFields)
  @IsOptional()
  @IsString()
  note?: string | null;

  @ValidateIf(validateContentPatchFields)
  @IsOptional()
  @IsString()
  effectiveFrom?: string;

  @ValidateIf(validateContentPatchFields)
  @IsOptional()
  @IsString()
  publisherId?: string;
}

export class SaveProgrammePolicyDraftDto {
  @IsOptional()
  @IsString()
  draftId?: string;

  @IsIn(['RULES', 'AWARD'])
  type!: 'RULES' | 'AWARD';

  @IsString()
  @MinLength(1)
  name!: string;

  @IsObject()
  schema!: Record<string, unknown>;

  @ValidateIf((_object, value) => pythonTruthy(value))
  @IsString()
  effectiveFrom?: string | null;
}

export class ReviewProgrammePolicyDraftDto {
  @IsIn(['APPROVED', 'CHANGES_REQUESTED'])
  decision!: 'APPROVED' | 'CHANGES_REQUESTED';

  @IsString()
  @MinLength(1)
  reviewerId!: string;

  @IsOptional()
  @IsString()
  note?: string | null;
}

export class PublishProgrammePolicyDraftDto {
  @IsString()
  @MinLength(1)
  effectiveFrom!: string;

  @IsString()
  @MinLength(1)
  publisherId!: string;
}

export class PatchProgrammePolicyDraftDto {
  @ValidateIf((_object, value) => pythonTruthy(value))
  @IsIn(['DRAFT', 'CHANGES_REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'PUBLISHED'])
  status?: string;

  @IsOptional()
  @IsIn(['RULES', 'AWARD'])
  type?: 'RULES' | 'AWARD';

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsObject()
  schema?: Record<string, unknown>;

  @ValidateIf((_object, value) => pythonTruthy(value))
  @IsString()
  effectiveFrom?: string | null;

  @IsOptional()
  @IsIn(['APPROVED', 'CHANGES_REQUESTED'])
  decision?: 'APPROVED' | 'CHANGES_REQUESTED';

  @IsOptional()
  @IsString()
  reviewerId?: string;

  @IsOptional()
  @IsString()
  note?: string | null;

  @IsOptional()
  @IsString()
  publisherId?: string;
}

export class UpdateProgrammeDto {
  @ValidateIf(
    (object) =>
      object.status === undefined ||
      object.status === null ||
      object.status === 'ACTIVE',
  )
  @IsOptional()
  @IsString()
  name?: string;

  @ValidateIf(
    (object) =>
      object.status === undefined ||
      object.status === null ||
      object.status === 'ACTIVE',
  )
  @IsOptional()
  @IsString()
  description?: string;

  @ValidateIf(
    (object) =>
      object.status === undefined ||
      object.status === null ||
      object.status === 'ACTIVE',
  )
  @IsOptional()
  @IsArray()
  @IsObject({ each: true })
  entityTypes?: Record<string, unknown>[];

  @ValidateIf(
    (object) =>
      object.status === undefined ||
      object.status === null ||
      object.status === 'ACTIVE',
  )
  @IsOptional()
  @IsObject()
  rules?: Record<string, unknown>;

  @ValidateIf(
    (object) =>
      object.status === undefined ||
      object.status === null ||
      object.status === 'ACTIVE',
  )
  @IsOptional()
  @IsObject()
  theme?: Record<string, unknown>;

  @ValidateIf(
    (object) =>
      object.status === undefined ||
      object.status === null ||
      object.status === 'ACTIVE',
  )
  @IsOptional()
  @IsObject()
  oidc?: Record<string, unknown> | null;

  @ValidateIf(
    (object) =>
      object.status === undefined ||
      object.status === null ||
      object.status === 'ACTIVE',
  )
  @IsOptional()
  @ValidateNested()
  @Type(() => ProgrammeEntityNumberingDto)
  entityNumbering?: ProgrammeEntityNumberingDto | null;

  @Allow()
  status?: unknown;
}
