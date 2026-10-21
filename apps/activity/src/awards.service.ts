import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { verifyAccessToken } from '@app/platform/access-token.js';
import { renderCertificatePdf } from '@app/platform/certificate-renderer.js';
import {
  nextPageIfMore,
  pageOffset,
  parsePageInteger,
} from '@app/platform/pagination.js';
import {
  pythonString,
  pythonStringJsonField,
  trimPythonWhitespace,
} from '@app/platform/python-strings.js';
import { pythonTruthy } from '@app/platform/python-truthiness.js';
import { ActivityRepository } from './activity.repository.js';
import { ActivityAwardsRepository } from './activity-awards.repository.js';
import {
  evaluateAward,
  validateAwardDraft,
  validateTemplate,
} from './award-domain.js';
import { pythonFloat, pythonInt, type JsonRecord } from './activity-domain.js';

@Injectable()
export class AwardsService {
  private s3Client: S3Client | undefined;
  private publicS3Client: S3Client | undefined;
  private previewBusy = false;

  constructor(
    private readonly repository: ActivityRepository,
    private readonly awardsRepository: ActivityAwardsRepository,
  ) {}

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
    const page = parsePageInteger(query.page, 1);
    const pageSize = parsePageInteger(query.pageSize, 50, 100);
    const offset = BigInt(pageOffset(page, pageSize));
    const result = await this.awardsRepository.listAwardDefinitionsPage(
      query.programme,
      query.category?.toUpperCase(),
      !claims,
      offset,
      pageSize,
    );
    return {
      items: result.items,
      page,
      pageSize,
      total: result.total,
      nextPage: nextPageIfMore(page, pageSize, result.total),
    };
  }

  async get(authorization: string | undefined, id: string) {
    const award = await this.awardsRepository.getAwardDefinition(id);
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
        existing = await this.awardsRepository.getAwardDefinition(body.awardId);
      } catch (error) {
        if (!(error instanceof NotFoundException)) throw error;
      }
      if (existing && !['DRAFT', 'CHANGES_REQUESTED'].includes(existing.status))
        throw new BadRequestException('only draft awards can be edited');
    }
    const record = validateAwardDraft(body, existing);
    if (record.signatureAssetId) {
      const asset = await this.awardsRepository.getAwardAsset(
        record.signatureAssetId,
      );
      if (asset.kind !== 'SIGNATURE')
        throw new BadRequestException('choose a registered signature asset');
    }
    const saved = await this.awardsRepository.saveAwardDefinition(
      record,
      key,
      'awards.definition.saved.v1',
    );
    return { award: saved, statusCode: existing ? 200 : 201 };
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
    const saved = await this.save(authorization, key, {
      ...existing,
      ...patch,
      awardId: id,
    });
    return saved.award;
  }

  async submit(authorization: string | undefined, id: string, key?: string) {
    this.authorizeHeader(authorization, ['awards.admin']);
    const award = await this.getAwardDefinitionOrThrow(id);
    if (!['DRAFT', 'CHANGES_REQUESTED'].includes(award.status))
      throw new BadRequestException('only draft awards can be submitted');
    award.status = 'UNDER_REVIEW';
    award.submittedAt = new Date().toISOString();
    return this.awardsRepository.saveAwardDefinition(award, key);
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
    return this.awardsRepository.saveAwardDefinition(award, key);
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
    return this.awardsRepository.saveAwardDefinition(
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
    return this.awardsRepository.saveAwardDefinition(award, key);
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
    if (pythonString(claims.sub) !== pythonStringJsonField(body, 'subjectId')) {
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

  async getAwardJob(id: string) {
    return this.repository.getJob(id);
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
    const subjects = pythonTruthy(body.subjectIds) ? body.subjectIds : [];
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

  async requestAward(authorization: string | undefined, body: JsonRecord) {
    const claims = verifyAccessToken(authorization);
    for (const field of [
      'awardId',
      'levelId',
      'subjectId',
      'callsign',
      'personName',
    ])
      if (
        body[field] === undefined ||
        body[field] === null ||
        body[field] === ''
      )
        throw new BadRequestException(`${field} is required`);
    if (claims.sub === body.subjectId && !claims.scp.includes('awards.request'))
      this.authorize(claims.scp, ['identity.me']);
    else this.authorize(claims.scp, ['awards.request', 'awards.admin']);

    const award = await this.getAwardDefinitionOrThrow(body.awardId);
    if (award.status !== 'PUBLISHED')
      throw new BadRequestException('only published awards can be requested');
    const facts = await this.repository.subjectFacts(
      award.programmeSlug,
      body.subjectId,
      Object.hasOwn(award, 'category') ? award.category : 'HUNTER',
    );
    const evaluation = evaluateAward(award, body.subjectId, facts);
    const level = evaluation.levels.find(
      (item: JsonRecord) => item.id === body.levelId,
    );
    if (!level?.eligible)
      throw new BadRequestException(
        'the requested award level is not currently eligible',
      );
    const now = new Date().toISOString();
    const saved = await this.awardsRepository.createAwardRequest({
      id: randomUUID(),
      awardId: award.id,
      programmeSlug: award.programmeSlug,
      levelId: body.levelId,
      subjectId: body.subjectId,
      category: award.category,
      callsign: body.callsign,
      personName: body.personName,
      facts,
      status: 'REQUESTED',
      requestedAt: now,
    });
    return {
      request: saved.request,
      statusCode: saved.created ? 201 : 200,
    };
  }

  async listRequests(
    authorization: string | undefined,
    query: { subjectId?: string; page?: string; pageSize?: string },
  ) {
    this.authorizeHeader(authorization, ['awards.read', 'awards.admin']);
    const page = parsePageInteger(query.page, 1);
    const pageSize = parsePageInteger(query.pageSize, 50, 100);
    const offset = BigInt(pageOffset(page, pageSize));
    const result = await this.awardsRepository.listAwardRequestsPage(
      query.subjectId,
      offset,
      pageSize,
    );
    return {
      items: result.items,
      page,
      pageSize,
      total: result.total,
      nextPage: nextPageIfMore(page, pageSize, result.total),
    };
  }

  async issueRequest(
    authorization: string | undefined,
    key: string | undefined,
    requestId: string,
    body: JsonRecord,
  ) {
    this.authorizeHeader(authorization, ['awards.admin']);
    for (const field of ['managerName', 'signatureAssetId'])
      if (
        body[field] === undefined ||
        body[field] === null ||
        body[field] === ''
      )
        throw new BadRequestException(`${field} is required`);
    const request = await this.awardsRepository.getAwardRequest(requestId);
    if (request.status !== 'REQUESTED')
      throw new BadRequestException('only requested awards can be issued');
    const award = await this.getAwardDefinitionOrThrow(request.awardId);
    const signature = await this.awardsRepository.getAwardAsset(
      body.signatureAssetId,
    );
    if (signature.kind !== 'SIGNATURE')
      throw new BadRequestException('a registered signature asset is required');
    const issuedAt = new Date().toISOString();
    const dateObtained = Object.hasOwn(body, 'dateObtained')
      ? body.dateObtained
      : issuedAt;
    const issuance: JsonRecord = {
      id: randomUUID(),
      requestId: request.id,
      awardId: award.id,
      programmeSlug: award.programmeSlug,
      levelId: request.levelId,
      category: request.category,
      subjectId: request.subjectId,
      callsign: request.callsign,
      personName: request.personName,
      awardName: award.name,
      dateObtained,
      managerName: body.managerName,
      signatureAssetId: signature.id,
      issuedAt,
      artifact: {
        storage: 'S3',
        bucket: process.env.MYOTA_CERTIFICATE_BUCKET ?? 'myota-certificates',
        objectKey: `${award.programmeSlug}/${request.subjectId}/${award.code}-${request.levelId}-${request.id}.pdf`,
        mediaType: 'application/pdf',
        downloadReady: false,
        renderStatus: 'WAITING_FOR_ASSETS',
      },
      renderSpec: {
        backgroundAsset: award.backgroundAsset,
        printSpec: award.printSpec,
        elements: (award.template as JsonRecord).elements,
        signatureAsset: signature,
      },
    };
    return this.awardsRepository.issueAwardRequest(requestId, issuance, key);
  }

  async listIssuances(
    authorization: string | undefined,
    query: { page?: string; pageSize?: string },
  ) {
    this.authorizeHeader(authorization, ['awards.read', 'awards.admin']);
    const page = parsePageInteger(query.page, 1);
    const pageSize = parsePageInteger(query.pageSize, 50, 100);
    const offset = BigInt(pageOffset(page, pageSize));
    const result = await this.awardsRepository.listAwardIssuancesPage(
      offset,
      pageSize,
    );
    return {
      items: result.items,
      page,
      pageSize,
      total: result.total,
      nextPage: nextPageIfMore(page, pageSize, result.total),
    };
  }

  async createRenderJob(
    authorization: string | undefined,
    key: string | undefined,
    issuanceId: string,
  ) {
    this.authorizeHeader(authorization, ['awards.admin']);
    const issuance = await this.awardsRepository.getAwardIssuance(issuanceId);
    const job = await this.repository.enqueueJob(
      'PDF_RENDER',
      { issuanceId: issuance.id },
      key,
    );
    return { renderJobId: job.id, issuanceId: issuance.id, ...job };
  }

  async getRenderJob(jobId: string) {
    return this.getAwardJob(jobId);
  }

  async getArtifact(authorization: string | undefined, issuanceId: string) {
    const claims = verifyAccessToken(authorization);
    this.authorize(claims.scp, [
      'awards.read',
      'awards.request',
      'awards.admin',
    ]);
    const issuance = await this.awardsRepository.getAwardIssuance(issuanceId);
    if (
      claims.sub !== issuance.subjectId &&
      !claims.scp.some((scope) =>
        ['*', 'awards.read', 'awards.admin'].includes(scope),
      )
    )
      throw new ForbiddenException('issuance belongs to another participant');
    const artifact = issuance.artifact as JsonRecord;
    if (!artifact.downloadReady)
      throw new BadRequestException('certificate is not ready for download');
    const downloadUrl = await getSignedUrl(
      this.publicS3(),
      new GetObjectCommand({
        Bucket: String(artifact.bucket),
        Key: String(artifact.objectKey),
      }),
      { expiresIn: 900 },
    );
    return {
      issuanceId: issuance.id,
      downloadUrl,
      objectKey: artifact.objectKey,
      expiresInSeconds: 900,
    };
  }

  async listAssets(
    authorization: string | undefined,
    query: { page?: string; pageSize?: string },
  ) {
    this.authorizeHeader(authorization, ['awards.read', 'awards.admin']);
    const page = parsePageInteger(query.page, 1);
    const pageSize = parsePageInteger(query.pageSize, 50, 100);
    const offset = BigInt(pageOffset(page, pageSize));
    const result = await this.awardsRepository.listAwardAssetsPage(
      offset,
      pageSize,
    );
    return {
      items: result.items,
      page,
      pageSize,
      total: result.total,
      nextPage: nextPageIfMore(page, pageSize, result.total),
    };
  }

  async preview(authorization: string | undefined, body: JsonRecord) {
    this.authorizeHeader(authorization, ['awards.admin']);
    if (this.previewBusy)
      throw new HttpException(
        {
          status: 429,
          code: 'preview_busy',
          detail: 'Preview renderer is busy; please retry shortly.',
        },
        429,
      );
    this.previewBusy = true;
    try {
      if (!pythonTruthy(body.name))
        throw new BadRequestException('missing required fields: name');
      const name = pythonString(body.name);
      const template = asRecord(body.template, 'template');
      if (!Array.isArray(template.elements) || template.elements.length > 30)
        throw new BadRequestException(
          'a preview requires at most 30 certificate elements',
        );
      validateTemplate(template.elements);
      const printSpec = asRecord(body.printSpec, 'printSpec');
      const page = pythonString(
        Object.hasOwn(printSpec, 'page') ? printSpec.page : 'A4',
      ).toUpperCase();
      const orientation = pythonString(
        Object.hasOwn(printSpec, 'orientation')
          ? printSpec.orientation
          : 'PORTRAIT',
      ).toUpperCase();
      const dpi = pythonFloat(
        Object.hasOwn(printSpec, 'dpi') ? printSpec.dpi : 300,
        'print.dpi',
      );
      if (
        !['A4', 'LETTER'].includes(page) ||
        !['PORTRAIT', 'LANDSCAPE'].includes(orientation) ||
        !Number.isFinite(dpi) ||
        dpi < 150 ||
        dpi > 300
      )
        throw new BadRequestException(
          'preview print settings must use A4 or LETTER, portrait or landscape, and 150 to 300 DPI',
        );

      let background: Buffer | undefined;
      const backgroundAsset = pythonTruthy(body.backgroundAsset)
        ? asRecord(body.backgroundAsset, 'backgroundAsset')
        : {};
      if (pythonTruthy(backgroundAsset.objectKey)) {
        const requested = backgroundAsset;
        const objectKey =
          typeof requested.objectKey === 'string' ? requested.objectKey : '';
        const asset = await this.awardsRepository.findAwardAsset(
          'BACKGROUND',
          objectKey,
        );
        if (!asset)
          throw new BadRequestException('choose a registered background');
        background = await this.readAsset(asset);
      }

      let signature: Buffer | undefined;
      if (pythonTruthy(body.signatureAssetId)) {
        const asset = await this.awardsRepository.getAwardAsset(
          body.signatureAssetId,
        );
        if (asset.kind !== 'SIGNATURE')
          throw new BadRequestException('choose a registered signature');
        signature = await this.readAsset(asset);
      }

      const mockData = {
        AWARD_NAME: Array.from(name).slice(0, 200).join(''),
        CALLSIGN: 'EA7TEST',
        PERSON_NAME: 'Demo Radio Operator',
        DATE_OBTAINED: new Date().toISOString().slice(0, 10),
        MANAGER_SIGNATURE: 'Signature preview',
        MANAGER_NAME: Array.from(
          pythonString(
            pythonTruthy(body.managerName)
              ? body.managerName
              : 'Demo Award Manager',
          ),
        )
          .slice(0, 200)
          .join(''),
      };
      const pdf = await renderCertificatePdf({
        printSpec: { page, orientation, dpi },
        elements: template.elements as JsonRecord[],
        values: mockData,
        background,
        signature,
      });
      return {
        preview: true,
        mediaType: 'application/pdf',
        filename: 'myota-award-preview.pdf',
        mockData,
        contentBase64: pdf.toString('base64'),
      };
    } finally {
      this.previewBusy = false;
    }
  }

  async registerAsset(authorization: string | undefined, body: JsonRecord) {
    this.authorizeHeader(authorization, ['awards.admin']);
    for (const field of [
      'kind',
      'name',
      'objectKey',
      'mediaType',
      'widthPx',
      'heightPx',
    ])
      if (
        body[field] === undefined ||
        body[field] === null ||
        body[field] === ''
      )
        throw new BadRequestException(`${field} is required`);
    const mediaType = pythonStringJsonField(body, 'mediaType');
    if (
      !['BACKGROUND', 'SIGNATURE'].includes(body.kind) ||
      !mediaType.startsWith('image/')
    )
      throw new BadRequestException(
        'asset kind must be BACKGROUND or SIGNATURE and mediaType must be an image',
      );
    const widthPx = pythonInt(body.widthPx, 'widthPx');
    const heightPx = pythonInt(body.heightPx, 'heightPx');
    if (!widthPx || !heightPx)
      throw new BadRequestException(
        'asset dimensions must be positive integers',
      );
    const isBackground = body.kind === 'BACKGROUND';
    const asset = {
      id: pythonTruthy(body.assetId) ? body.assetId : randomUUID(),
      kind: body.kind,
      name: body.name,
      objectKey: body.objectKey,
      mediaType: body.mediaType,
      widthPx,
      heightPx,
      sha256: body.sha256,
      storage: 'S3',
      bucket:
        process.env[
          isBackground
            ? 'MYOTA_AWARD_ASSET_BUCKET'
            : 'MYOTA_AWARD_SIGNATURE_BUCKET'
        ] ?? (isBackground ? 'myota-award-assets' : 'myota-award-signatures'),
      objectStorageEndpoint:
        process.env.MYOTA_OBJECT_STORAGE_PUBLIC_ENDPOINT ??
        process.env.MYOTA_OBJECT_STORAGE_ENDPOINT ??
        'http://seaweedfs:8333',
      contentStatus: 'MISSING',
      createdAt: new Date().toISOString(),
    };
    return this.awardsRepository.saveAwardAsset(asset);
  }

  async putAssetContent(
    authorization: string | undefined,
    id: string,
    declaredType: string | undefined,
    content: Buffer,
  ) {
    this.authorizeHeader(authorization, ['awards.admin']);
    const asset = await this.awardsRepository.getAwardAsset(id);
    const metadata = await imageMetadata(content);
    if (metadata.mediaType !== declaredType)
      throw new BadRequestException(
        'declared media type does not match image content',
      );
    const eicar = Buffer.from(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    );
    if (content.includes(eicar))
      throw new BadRequestException('malware scan rejected the upload');
    await scanWithClamav(content, asset.objectKey);
    const sha256 = createHash('sha256').update(content).digest('hex');
    try {
      await this.s3().send(
        new PutObjectCommand({
          Bucket: asset.bucket,
          Key: asset.objectKey,
          Body: content,
          ContentType: metadata.mediaType,
        }),
      );
    } catch {
      throw new ServiceUnavailableException('object storage upload failed');
    }
    Object.assign(asset, {
      ...metadata,
      contentStatus: 'STORED',
      contentSha256: sha256,
      contentSize: content.length,
      storedAt: new Date().toISOString(),
    });
    return this.awardsRepository.saveAwardAsset(asset);
  }

  authorizeAssetContentUpload(authorization: string | undefined) {
    this.authorizeHeader(authorization, ['awards.admin']);
  }

  async getAssetContent(authorization: string | undefined, id: string) {
    this.authorizeHeader(authorization, ['awards.read', 'awards.admin']);
    const asset = await this.awardsRepository.getAwardAsset(id);
    try {
      const response = await this.s3().send(
        new GetObjectCommand({ Bucket: asset.bucket, Key: asset.objectKey }),
      );
      if (!response.Body)
        throw new BadRequestException(
          'registered image has no uploaded content',
        );
      const content = Buffer.from(await response.Body.transformToByteArray());
      const metadata = await imageMetadata(content);
      return {
        asset,
        mediaType: metadata.mediaType,
        contentBase64: content.toString('base64'),
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('registered image has no uploaded content');
    }
  }

  private async readAsset(asset: JsonRecord) {
    if (asset.contentStatus !== 'STORED')
      throw new BadRequestException('registered image has no uploaded content');
    try {
      const response = await this.s3().send(
        new GetObjectCommand({
          Bucket: String(asset.bucket),
          Key: String(asset.objectKey),
        }),
      );
      if (!response.Body)
        throw new BadRequestException(
          'registered image has no uploaded content',
        );
      const bytes = Buffer.from(await response.Body.transformToByteArray());
      await imageMetadata(bytes);
      return bytes;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('registered image has no uploaded content');
    }
  }

  private s3() {
    if (!this.s3Client) {
      this.s3Client = this.createS3Client(
        process.env.MYOTA_OBJECT_STORAGE_ENDPOINT ?? 'http://seaweedfs:8333',
      );
    }
    return this.s3Client;
  }

  private publicS3() {
    if (!this.publicS3Client)
      this.publicS3Client = this.createS3Client(
        process.env.MYOTA_OBJECT_STORAGE_PUBLIC_ENDPOINT ??
          process.env.MYOTA_OBJECT_STORAGE_ENDPOINT ??
          'http://seaweedfs:8333',
      );
    return this.publicS3Client;
  }

  private createS3Client(endpoint: string) {
    return new S3Client({
      endpoint,
      region: process.env.MYOTA_OBJECT_STORAGE_REGION ?? 'us-east-1',
      forcePathStyle:
        (process.env.MYOTA_OBJECT_STORAGE_ADDRESSING_STYLE ?? 'path') ===
        'path',
      credentials: {
        accessKeyId: process.env.MYOTA_OBJECT_STORAGE_ACCESS_KEY ?? 'myota-s3',
        secretAccessKey:
          process.env.MYOTA_OBJECT_STORAGE_SECRET_KEY ?? 'myota-s3-dev-only',
      },
    });
  }

  private async getAwardDefinitionOrThrow(id: string) {
    return this.awardsRepository.getAwardDefinition(id);
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

function asRecord(value: unknown, field: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException(`${field} must be an object`);
  return value as JsonRecord;
}

async function imageMetadata(content: Buffer) {
  const maxBytes = boundedEnv(
    'MYOTA_UPLOAD_MAX_BYTES',
    20 * 1024 * 1024,
    1,
    20 * 1024 * 1024,
  );
  if (content.length > maxBytes)
    throw new BadRequestException('image exceeds the configured upload limit');
  try {
    const metadata = await sharp(content, {
      limitInputPixels: 16_000_000,
      failOn: 'error',
    }).metadata();
    if (
      !['png', 'jpeg'].includes(metadata.format ?? '') ||
      !metadata.width ||
      !metadata.height
    )
      throw new BadRequestException(
        'only valid PNG and JPEG images are supported',
      );
    if (metadata.width * metadata.height > 16_000_000)
      throw new BadRequestException('image exceeds the configured pixel limit');
    return {
      mediaType: metadata.format === 'jpeg' ? 'image/jpeg' : 'image/png',
      widthPx: metadata.width,
      heightPx: metadata.height,
    };
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException('image content is invalid');
  }
}

function boundedEnv(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

async function scanWithClamav(content: Buffer, filename: string) {
  const endpoint = process.env.MYOTA_CLAMAV_URL
    ? trimPythonWhitespace(process.env.MYOTA_CLAMAV_URL)
    : undefined;
  if (!endpoint) return;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-upload-name': filename,
      },
      body: new Uint8Array(content),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new ServiceUnavailableException('malware scanner rejected upload');
  } catch {
    throw new ServiceUnavailableException(
      'malware scanner is unavailable; upload was not stored',
    );
  }
}
