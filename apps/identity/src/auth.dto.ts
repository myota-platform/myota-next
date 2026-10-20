import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsOptional,
  IsString,
  IsObject,
  IsUUID,
  IsIn,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { firstQueryValue } from '@app/platform/query.js';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;
}

export class RefreshTokenDto {
  @IsString()
  @MinLength(1)
  refreshToken!: string;
}

export class RecoveryRequestDto {
  @IsEmail()
  email!: string;
}

export class RecoveryResetDto {
  @IsString()
  @MinLength(1)
  token!: string;

  @IsString()
  newPassword!: string;
}

export class AdminAccountsQueryDto {
  @IsOptional()
  @Transform(({ value }) => firstQueryValue(value))
  @IsString()
  q?: string;

  @IsOptional()
  @Transform(({ value }) => firstQueryValue(value))
  @IsString()
  status?: string;

  @IsOptional()
  @Transform(({ value }) => firstQueryValue(value))
  @IsString()
  page?: string;

  @IsOptional()
  @Transform(({ value }) => firstQueryValue(value))
  @IsString()
  pageSize?: string;
}

export class SecurityEventsQueryDto {
  @IsOptional()
  @Transform(({ value }) => firstQueryValue(value))
  @IsString()
  page?: string;

  @IsOptional()
  @Transform(({ value }) => firstQueryValue(value))
  @IsString()
  pageSize?: string;
}

export class OidcProviderMappingDto {
  @IsString()
  @MinLength(1)
  programmeSlug!: string;

  @IsString()
  @MinLength(1)
  issuer!: string;

  @IsString()
  @MinLength(1)
  clientId!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scopes?: string[] | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean | null;
}

export class ServiceTokenRequestDto {
  @IsString()
  @MinLength(1)
  service!: string;

  @IsOptional()
  clientSecret?: unknown;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scopes?: string[];
}

export class AdminRoleDefinitionDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scopes?: string[];
}

export class RoleGrantDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  role?: string;

  @IsOptional()
  @IsString()
  programmeSlug?: string;

  @IsOptional()
  @IsString()
  jurisdiction?: string;

  @IsOptional()
  @IsString()
  entityType?: string;
}

export class CreateAccountDto {
  @IsString()
  @MinLength(1)
  displayName!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @IsIn(['OPERATOR', 'SWL'])
  participationType!: 'OPERATOR' | 'SWL';

  @IsOptional()
  @IsString()
  callsign?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RoleGrantDto)
  roles?: RoleGrantDto[];

  @IsOptional()
  @IsString()
  password?: string;
}

export class UpdateAccountDto {
  @IsOptional()
  @IsString()
  displayName?: string;

  @IsOptional()
  @IsString()
  email?: string | null;

  @IsOptional()
  @IsString()
  @IsIn(['OPERATOR', 'SWL'])
  participationType?: 'OPERATOR' | 'SWL';

  @IsOptional()
  @IsString()
  @IsIn(['ACTIVE', 'DEACTIVATED'])
  status?: 'ACTIVE' | 'DEACTIVATED';

  @IsOptional()
  @IsString()
  websiteUrl?: string | null;

  @IsOptional()
  @IsString()
  biographyMarkdown?: string | null;

  @IsOptional()
  @IsBoolean()
  anonymize?: boolean;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RoleGrantDto)
  roles?: RoleGrantDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roleCodes?: string[];
}

export class ReplaceAccountRolesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RoleGrantDto)
  roles!: RoleGrantDto[];
}

export class AddCallsignDto {
  @IsString()
  @MinLength(1)
  callsign!: string;

  @IsOptional()
  @IsString()
  @IsIn(['UNVERIFIED', 'VERIFIED', 'RETIRED'])
  status?: 'UNVERIFIED' | 'VERIFIED' | 'RETIRED';

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @IsDateString()
  validFrom?: string;

  @IsOptional()
  @IsDateString()
  validTo?: string;
}

export class CallsignEvidenceDto {
  @IsString()
  @MinLength(1)
  evidenceType!: string;

  @IsString()
  @MinLength(1)
  source!: string;

  @IsOptional()
  @IsString()
  checksum?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class VerifyCallsignDto {
  @IsOptional()
  @IsString()
  source?: string;
}

export class SetPrimaryCallsignDto {
  @IsUUID()
  callsignId!: string;
}

export class RetireCallsignDto {
  @IsOptional()
  @IsUUID()
  newPrimaryCallsignId?: string;

  @IsOptional()
  @IsDateString()
  validTo?: string;
}
