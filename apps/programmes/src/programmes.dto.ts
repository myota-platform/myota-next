import {
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

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
  description?: string;

  @IsOptional()
  @IsObject()
  theme?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  oidc?: Record<string, unknown> | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  policyVersion?: number;
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
  status?: string;
}
