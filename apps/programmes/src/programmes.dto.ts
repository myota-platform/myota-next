import {
  Allow,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { pythonTruthy } from '@app/platform/python-truthiness.js';

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

  @IsOptional()
  @IsBoolean()
  active?: boolean;
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
  @IsIn(['APPROVED', 'CHANGES_REQUESTED'])
  decision!: 'APPROVED' | 'CHANGES_REQUESTED';

  @IsString()
  @MinLength(1)
  reviewerId!: string;

  @IsOptional()
  @IsString()
  note?: string | null;
}

export class PublishProgrammeContentDto {
  @IsString()
  @MinLength(1)
  effectiveFrom!: string;

  @IsString()
  @MinLength(1)
  publisherId!: string;
}

export class PatchProgrammeContentDto {
  @ValidateIf((_object, value) => pythonTruthy(value))
  @IsIn(['DRAFT', 'CHANGES_REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'PUBLISHED'])
  status?: string;

  @IsOptional()
  @IsString()
  key?: string;

  @IsOptional()
  @IsString()
  locale?: string;

  @IsOptional()
  @Allow()
  value?: unknown;

  @IsOptional()
  @IsString()
  fallbackLocale?: string | null;

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
  effectiveFrom?: string;

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
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsObject({ each: true })
  entityTypes?: Record<string, unknown>[];

  @IsOptional()
  @IsObject()
  rules?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  theme?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  oidc?: Record<string, unknown> | null;

  @IsOptional()
  @IsString()
  status?: string | null;
}
