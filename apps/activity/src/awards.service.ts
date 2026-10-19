import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { verifyAccessToken } from '@app/platform/access-token.js';
import { ActivityRepository } from './activity.repository.js';
import { evaluateAward, validateAwardDraft } from './award-domain.js';
import type { JsonRecord } from './activity-domain.js';

@Injectable()
export class AwardsService {
  constructor(private readonly repository: ActivityRepository) {}

  async list(
    authorization: string | undefined,
    query: {
      programme?: string;
      category?: string;
      page?: string;
      pageSize?: string;
    },
  ) {
    const claims = authorization ? verifyAccessToken(authorization) : null;
    if (claims) this.authorize(claims.scp, ['awards.read', 'awards.admin']);
    let items = await this.repository.listAwardDefinitions();
    if (!claims) items = items.filter((award) => award.status === 'PUBLISHED');
    if (query.programme)
      items = items.filter((award) => award.programmeSlug === query.programme);
    if (query.category)
      items = items.filter(
        (award) => award.category === query.category?.toUpperCase(),
      );
    const page = positiveInt(query.page, 1);
    const pageSize = Math.min(100, positiveInt(query.pageSize, 50));
    const start = (page - 1) * pageSize;
    return {
      items: items.slice(start, start + pageSize),
      page,
      pageSize,
      total: items.length,
      nextPage: start + pageSize < items.length ? page + 1 : null,
    };
  }

  async get(authorization: string | undefined, id: string) {
    const award = await this.repository.getAwardDefinition(id);
    const claims = authorization ? verifyAccessToken(authorization) : null;
    if (!claims && award.status !== 'PUBLISHED')
      throw new ForbiddenException('only published awards are public');
    if (claims) this.authorize(claims.scp, ['awards.read', 'awards.admin']);
    return award;
  }

  async save(
    authorization: string | undefined,
    key: string | undefined,
    body: JsonRecord,
  ) {
    this.authorizeHeader(authorization, ['awards.admin']);
    let existing: JsonRecord | undefined;
    if (body.awardId) {
      try {
        existing = await this.repository.getAwardDefinition(body.awardId);
      } catch (error) {
        if (!(error instanceof NotFoundException)) throw error;
      }
      if (existing && !['DRAFT', 'CHANGES_REQUESTED'].includes(existing.status))
        throw new BadRequestException('only draft awards can be edited');
    }
    const record = validateAwardDraft(body, existing);
    if (record.signatureAssetId) {
      const asset = await this.repository.getAwardAsset(
        String(record.signatureAssetId),
      );
      if (asset.kind !== 'SIGNATURE')
        throw new BadRequestException('choose a registered signature asset');
    }
    return this.repository.saveAwardDefinition(
      record,
      key,
      'awards.definition.saved.v1',
    );
  }

  async patch(
    authorization: string | undefined,
    key: string | undefined,
    id: string,
    body: JsonRecord,
  ) {
    const status = body.status;
    const patch = { ...body };
    delete patch.status;
    if (status === 'UNDER_REVIEW') return this.submit(authorization, id, key);
    if (status === 'APPROVED' || status === 'CHANGES_REQUESTED')
      return this.review(
        authorization,
        id,
        { ...patch, decision: status },
        key,
      );
    if (status === 'PUBLISHED')
      return this.publish(authorization, id, patch, key);
    if (status === 'RETIRED') return this.retire(authorization, id, patch, key);
    const existing = await this.getAwardDefinitionOrThrow(id);
    return this.save(authorization, key, {
      ...existing,
      ...patch,
      awardId: id,
    });
  }

  async submit(authorization: string | undefined, id: string, key?: string) {
    this.authorizeHeader(authorization, ['awards.admin']);
    const award = await this.getAwardDefinitionOrThrow(id);
    if (!['DRAFT', 'CHANGES_REQUESTED'].includes(award.status))
      throw new BadRequestException('only draft awards can be submitted');
    award.status = 'UNDER_REVIEW';
    award.submittedAt = new Date().toISOString();
    return this.repository.saveAwardDefinition(award, key);
  }

  async review(
    authorization: string | undefined,
    id: string,
    body: JsonRecord,
    key?: string,
  ) {
    this.authorizeHeader(authorization, ['awards.admin']);
    const award = await this.getAwardDefinitionOrThrow(id);
    if (
      !body.reviewerId ||
      award.status !== 'UNDER_REVIEW' ||
      !['APPROVED', 'CHANGES_REQUESTED'].includes(body.decision)
    )
      throw new BadRequestException(
        'award must be under review and decision must be APPROVED or CHANGES_REQUESTED',
      );
    award.status = body.decision;
    award.review = {
      reviewerId: body.reviewerId,
      note: body.note,
      reviewedAt: new Date().toISOString(),
    };
    return this.repository.saveAwardDefinition(award, key);
  }

  async publish(
    authorization: string | undefined,
    id: string,
    body: JsonRecord,
    key?: string,
  ) {
    this.authorizeHeader(authorization, ['awards.admin']);
    const award = await this.getAwardDefinitionOrThrow(id);
    if (!body.effectiveFrom || !body.publisherId)
      throw new BadRequestException(
        'effectiveFrom and publisherId are required',
      );
    if (award.status !== 'APPROVED')
      throw new BadRequestException('only approved awards can be published');
    if (!award.printReadiness?.printReady)
      throw new BadRequestException(
        'background image does not meet the selected A4/Letter print profile',
      );
    const effectiveFrom = new Date(body.effectiveFrom);
    if (!Number.isFinite(effectiveFrom.getTime()))
      throw new BadRequestException('effectiveFrom must be a valid timestamp');
    Object.assign(award, {
      status: 'PUBLISHED',
      effectiveFrom: effectiveFrom.toISOString(),
      publisherId: body.publisherId,
      publishedAt: new Date().toISOString(),
    });
    return this.repository.saveAwardDefinition(
      award,
      key,
      'awards.definition.published.v1',
    );
  }

  async retire(
    authorization: string | undefined,
    id: string,
    body: JsonRecord,
    key?: string,
  ) {
    this.authorizeHeader(authorization, ['awards.admin']);
    const award = await this.getAwardDefinitionOrThrow(id);
    if (!body.retiredAt || !body.retiredBy)
      throw new BadRequestException('retiredAt and retiredBy are required');
    if (!['PUBLISHED', 'APPROVED'].includes(award.status))
      throw new BadRequestException(
        'only published or approved awards can be retired',
      );
    Object.assign(award, {
      status: 'RETIRED',
      retiredAt: body.retiredAt,
      retiredBy: body.retiredBy,
    });
    return this.repository.saveAwardDefinition(award, key);
  }

  async createEvaluationJob(
    authorization: string | undefined,
    key: string | undefined,
    body: JsonRecord,
  ) {
    const claims = verifyAccessToken(authorization);
    if (!body.awardId || !body.subjectId)
      throw new BadRequestException('awardId and subjectId are required');
    let facts = body.facts;
    if (claims.sub !== body.subjectId) {
      this.authorize(claims.scp, [
        'awards.read',
        'awards.request',
        'awards.admin',
      ]);
    } else {
      // Participant self-evaluations always read service-owned aggregates.
      facts = null;
    }
    const award = await this.getAwardDefinitionOrThrow(body.awardId);
    const payload = {
      awardId: award.id,
      subjectId: body.subjectId,
      facts: facts ?? null,
    };
    const job = await this.repository.enqueueJob(
      'AWARD_EVALUATION',
      payload,
      key,
    );
    return { evaluationId: job.id, ...job };
  }

  async getAwardJob(authorization: string | undefined, id: string) {
    const claims = verifyAccessToken(authorization);
    this.authorize(claims.scp, [
      'awards.read',
      'awards.request',
      'awards.admin',
    ]);
    const job = await this.repository.getJob(id);
    const subjectId = job.payload?.subjectId;
    if (subjectId && claims.sub !== subjectId)
      this.authorize(claims.scp, ['awards.read', 'awards.admin']);
    else if (
      !subjectId &&
      !claims.scp.some((scope) => ['*', 'awards.admin'].includes(scope))
    )
      throw new ForbiddenException('awards.admin scope is required');
    return job;
  }

  async progress(
    authorization: string | undefined,
    awardId: string,
    participantId: string,
  ) {
    const claims = verifyAccessToken(authorization);
    if (claims.sub !== participantId)
      this.authorize(claims.scp, ['awards.read', 'awards.admin']);
    else
      this.authorize(claims.scp, [
        'awards.read',
        'awards.request',
        'awards.admin',
        'identity.me',
      ]);
    if (!awardId || !participantId)
      throw new BadRequestException('awardId and participantId are required');
    const award = await this.getAwardDefinitionOrThrow(awardId);
    const facts = await this.repository.subjectFacts(
      award.programmeSlug,
      participantId,
      award.category ?? 'HUNTER',
    );
    const result = evaluateAward(award, participantId, facts);
    await this.repository.saveAwardProgress(
      award,
      participantId,
      facts,
      result,
    );
    return result;
  }

  async recalculate(
    authorization: string | undefined,
    key: string | undefined,
    awardId: string,
    body: JsonRecord,
  ) {
    this.authorizeHeader(authorization, ['awards.admin']);
    const award = await this.getAwardDefinitionOrThrow(awardId);
    const subjects = body.subjectIds ?? [];
    if (!Array.isArray(subjects))
      throw new BadRequestException('subjectIds must be an array');
    const sorted = subjects.map(String).sort();
    const jobKey =
      key ??
      `award-recalculate:${award.id}:${award.version ?? 1}:${sorted.join(',')}`;
    const payload = {
      programmeSlug: award.programmeSlug,
      subjectIds: sorted,
      awardId: award.id,
      ruleVersion: award.version ?? 1,
    };
    const job = await this.repository.enqueueJob(
      'AWARD_RECALCULATE',
      payload,
      jobKey,
    );
    return {
      awardId: award.id,
      ruleVersion: award.version ?? 1,
      jobId: job.id,
      ...job,
    };
  }

  private async getAwardDefinitionOrThrow(id: string) {
    return this.repository.getAwardDefinition(id);
  }

  private authorizeHeader(authorization: string | undefined, scopes: string[]) {
    const claims = verifyAccessToken(authorization);
    this.authorize(claims.scp, scopes);
  }

  private authorize(granted: string[], scopes: string[]) {
    if (!granted.some((scope) => scope === '*' || scopes.includes(scope)))
      throw new ForbiddenException('award scope is required');
  }
}

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
