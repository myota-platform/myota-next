import { Controller, Get, Param, Query } from '@nestjs/common';
import { ProgrammeContentService } from './programme-content.service.js';

@Controller('public/programmes/:slug/content')
export class PublicProgrammeContentController {
  constructor(private readonly content: ProgrammeContentService) {}

  @Get()
  get(@Param('slug') slug: string, @Query('locale') locale?: string) {
    return this.content.publicContent(slug, locale);
  }
}
