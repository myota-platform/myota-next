import { Controller, Get, Param, Query } from '@nestjs/common';
import { firstQueryValue } from '@app/platform/query.js';
import { ProgrammeContentService } from './programme-content.service.js';

@Controller('public/programmes/:slug/content')
export class PublicProgrammeContentController {
  constructor(private readonly content: ProgrammeContentService) {}

  @Get()
  get(
    @Param('slug') slug: string,
    @Query('locale') locale?: string | string[],
  ) {
    return this.content.publicContent(slug, firstQueryValue(locale));
  }
}
