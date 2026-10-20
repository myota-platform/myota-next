import { Controller, Get, Query } from '@nestjs/common';
import { firstQueryValue } from '@app/platform/query.js';
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
      firstQueryValue(programme),
      firstQueryValue(page),
      firstQueryValue(pageSize),
    );
  }

  @Get('leaderboards')
  leaderboard(
    @Query('programme') programme?: string | string[],
    @Query('category') category?: string | string[],
  ) {
    return this.activity.leaderboard(
      firstQueryValue(programme) ?? '',
      firstQueryValue(category) || 'HUNTER',
    );
  }

  @Get('results')
  results(
    @Query('programme') programme?: string | string[],
    @Query('format') format: string | string[] = 'json',
  ) {
    return this.activity.publicResults(
      firstQueryValue(programme),
      firstQueryValue(format) ?? 'json',
    );
  }
}
