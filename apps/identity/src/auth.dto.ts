import { IsEmail, IsString, MinLength } from 'class-validator';

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
  @MinLength(12)
  newPassword!: string;
}
