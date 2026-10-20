import { Controller, Get, Query } from '@nestjs/common';
import { ActivityService } from './activity.service.js';

@Controller('public')
export class PublicActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get('activations')
  history(
    @Query('programme') programme?: string | string[],
    @Query('page') page?: string | string[],
    @Query('pageSize') pageSize?: string | string[],
  ) {
    return this.activity.publicHistory(
      firstNonBlankQueryValue(programme),
      firstNonBlankQueryValue(page),
      firstNonBlankQueryValue(pageSize),
    );
  }

  @Get('leaderboards')
  leaderboard(
    @Query('programme') programme?: string | string[],
    @Query('category') category?: string | string[],
  ) {
    return this.activity.leaderboard(
      firstNonBlankQueryValue(programme) ?? '',
      firstNonBlankQueryValue(category) ?? 'HUNTER',
    );
  }

  @Get('results')
  results(
    @Query('programme') programme?: string | string[],
    @Query('format') format: string | string[] = 'json',
  ) {
    return this.activity.publicResults(
      firstNonBlankQueryValue(programme),
      firstNonBlankQueryValue(format) ?? 'json',
    );
  }
}

function firstNonBlankQueryValue(
  value: string | string[] | undefined,
): string | undefined {
  return (Array.isArray(value) ? value : [value]).find(
    (item): item is string => typeof item === 'string' && item !== '',
  );
}
