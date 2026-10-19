import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  IsIn,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

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

export class ProfileUpdateDto {
  @IsOptional()
  @IsString()
  websiteUrl?: string | null;

  @IsOptional()
  @IsString()
  biographyMarkdown?: string | null;
}

export class AdminAccountsQueryDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  page?: string;

  @IsOptional()
  @IsString()
  pageSize?: string;
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
