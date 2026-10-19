import { Controller, Get, Query } from '@nestjs/common';
import { ActivityService } from './activity.service.js';

@Controller('public')
export class PublicActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get('activations')
  history(
    @Query('programme') programme?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.activity.publicHistory(programme, page, pageSize);
  }

  @Get('leaderboards')
  leaderboard(
    @Query('programme') programme = '',
    @Query('category') category = 'HUNTER',
  ) {
    return this.activity.leaderboard(programme, category);
  }

  @Get('results')
  results(
    @Query('programme') programme?: string,
    @Query('format') format = 'json',
  ) {
    return this.activity.publicResults(programme, format);
  }
}
