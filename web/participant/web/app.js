const $ = (id) => document.getElementById(id);
const profileUtils = window.MyotaProfileUtils;
let participantPasswordResetToken = window.myotaPasswordResetToken || '';
window.myotaPasswordResetToken = '';
let participantEmailChangeToken = window.myotaEmailChangeToken || '';
window.myotaEmailChangeToken = '';
let programmes = [];
let entities = [];
let entityStatistics = new Map();
let entityStatisticsState = 'loading';
let entityStatisticsRequest = 0;
let entityPage = 1;
let entityHasNext = false;
let entityPageRequest = 0;
let programmeLoadGeneration = 0;
const entityPageSize = 50;
let activationEntityOptions = new Map();
let publicAwards = [];
let publicAwardsRequest = 0;
let programmeContentRequest = 0;
let activationRequest = 0;
let activations = [];
let publicActivityPage = 1;
let publicActivityNextPage = null;
let publicActivityRequest = 0;
let leaderboardRequest = 0;
let awardAccount = null;
let awardAccessToken = localStorage.getItem('myota_public_access') || '';
let awardRefreshToken = localStorage.getItem('myota_public_refresh') || '';
let awardRefreshInFlight = null;
const pendingParticipantMutationsKey = 'myota_pending_activity_mutations';
const pendingParticipantMutations = restorePendingParticipantMutations();
const pendingProfileCallsignMutationsKey =
  'myota_pending_profile_callsign_mutations';
const pendingProfileCallsignMutations =
  restorePendingProfileCallsignMutations();
let profileCallsignAddRequest = pendingProfileCallsignMutations.add;
const profilePrimaryCallsignRequestKeys =
  pendingProfileCallsignMutations.primary;
let activeAdifImportId =
  sessionStorage.getItem('myota_active_adif_import') || '';
let adifStatusTimer = null;
let adifStatusRequestInFlight = false;
const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ],
  );
function themeHex(value, fallback) {
  if (typeof value !== 'string' || !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value))
    return fallback;
  if (value.length === 4)
    return `#${[...value.slice(1)].map((channel) => channel + channel).join('')}`;
  return value.toLowerCase();
}
function linearColorChannel(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
function colorLuminance(hex) {
  const color = hex
    .slice(1)
    .match(/.{2}/g)
    .map((channel) => linearColorChannel(Number.parseInt(channel, 16)));
  return color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
}
function contrastRatio(first, second) {
  const luminances = [colorLuminance(first), colorLuminance(second)].sort(
    (a, b) => b - a,
  );
  return (luminances[0] + 0.05) / (luminances[1] + 0.05);
}
function readablePrimaryColor(primary) {
  const surfaceBackground = '#edf4ef';
  if (contrastRatio(primary, surfaceBackground) >= 4.5) return primary;
  const channels = primary
    .slice(1)
    .match(/.{2}/g)
    .map((channel) => Number.parseInt(channel, 16));
  for (let darkness = 0.05; darkness <= 1; darkness += 0.05) {
    const candidate = `#${channels
      .map((channel) =>
        Math.round(channel * (1 - darkness))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')}`;
    if (contrastRatio(candidate, surfaceBackground) >= 4.5) return candidate;
  }
  return '#0f766e';
}
function foregroundForPrimary(primary) {
  const whiteContrast = contrastRatio(primary, '#ffffff');
  const inkContrast = contrastRatio(primary, '#17312f');
  return whiteContrast >= inkContrast ? '#ffffff' : '#17312f';
}
async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || body.message || res.statusText);
  }
  return res.json();
}
async function awardApi(path, options = {}) {
  const headers = {
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  };
  const res = await participantFetch(path, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(
      body.detail || body.message || body.title || res.statusText,
    );
  return body;
}
function pendingParticipantMutation(operation, identity, body) {
  const id = JSON.stringify([operation, identity]);
  let request = pendingParticipantMutations.get(id);
  if (!request) {
    request = { id, key: crypto.randomUUID(), body };
    pendingParticipantMutations.set(id, request);
    persistPendingParticipantMutations();
  }
  return request;
}
function restorePendingParticipantMutations() {
  try {
    const entries = JSON.parse(
      sessionStorage.getItem(pendingParticipantMutationsKey) || '[]',
    );
    if (!Array.isArray(entries)) return new Map();
    return new Map(
      entries.filter(
        (entry) =>
          Array.isArray(entry) &&
          typeof entry[0] === 'string' &&
          entry[1] &&
          typeof entry[1].key === 'string' &&
          entry[1].body &&
          typeof entry[1].body === 'object',
      ),
    );
  } catch {
    return new Map();
  }
}
function persistPendingParticipantMutations() {
  try {
    sessionStorage.setItem(
      pendingParticipantMutationsKey,
      JSON.stringify([...pendingParticipantMutations.entries()]),
    );
  } catch {
    // In-memory retries remain available when browser storage is unavailable.
  }
}
function restorePendingProfileCallsignMutations() {
  try {
    const saved = JSON.parse(
      sessionStorage.getItem(pendingProfileCallsignMutationsKey) || '{}',
    );
    const add =
      saved.add &&
      typeof saved.add.fingerprint === 'string' &&
      typeof saved.add.key === 'string'
        ? saved.add
        : null;
    const primary = new Map(
      Array.isArray(saved.primary)
        ? saved.primary.filter(
            (entry) =>
              Array.isArray(entry) &&
              typeof entry[0] === 'string' &&
              typeof entry[1] === 'string',
          )
        : [],
    );
    return { add, primary };
  } catch {
    return { add: null, primary: new Map() };
  }
}
function persistPendingProfileCallsignMutations() {
  try {
    sessionStorage.setItem(
      pendingProfileCallsignMutationsKey,
      JSON.stringify({
        add: profileCallsignAddRequest,
        primary: [...profilePrimaryCallsignRequestKeys.entries()],
      }),
    );
  } catch {
    // In-memory retries remain available when browser storage is unavailable.
  }
}
function completePendingParticipantMutation(id) {
  if (pendingParticipantMutations.delete(id))
    persistPendingParticipantMutations();
}
function clearParticipantSession() {
  awardAccessToken = '';
  awardRefreshToken = '';
  awardAccount = null;
  pendingParticipantMutations.clear();
  profileCallsignAddRequest = null;
  profilePrimaryCallsignRequestKeys.clear();
  try {
    sessionStorage.removeItem(pendingParticipantMutationsKey);
    sessionStorage.removeItem(pendingProfileCallsignMutationsKey);
  } catch {
    // Session cleanup continues when browser storage is unavailable.
  }
  localStorage.removeItem('myota_public_access');
  localStorage.removeItem('myota_public_refresh');
  renderParticipantSession();
  if ($('activation-start-form')) $('activation-start-form').hidden = true;
  if ($('qso-form')) $('qso-form').hidden = true;
  if ($('activations-list')) $('activations-list').replaceChildren();
  if ($('qso-activation')) $('qso-activation').replaceChildren();
  if ($('activation-callsign')) $('activation-callsign').replaceChildren();
  if ($('profile-form')) $('profile-form').hidden = true;
  if ($('profile-callsigns')) $('profile-callsigns').hidden = true;
  if ($('profile-image-editor')) $('profile-image-editor').hidden = true;
  if ($('participant-award-requests')) {
    $('participant-award-requests').hidden = true;
    $('participant-award-request-items').replaceChildren();
  }
  if ($('profile-status'))
    $('profile-status').textContent = 'Sign in below to manage your profile.';
  if (typeof revokeProfileSource === 'function') revokeProfileSource();
  if (typeof clearProfileImage === 'function') clearProfileImage();
}
function renderParticipantSession() {
  const signedIn = Boolean(awardAccount && awardAccessToken);
  if ($('participant-session-status'))
    $('participant-session-status').textContent = signedIn
      ? `Signed in as ${awardAccount.displayName} (${awardAccount.email || 'participant'}).`
      : 'Sign in or create a participant account to manage activations and your profile.';
  if ($('participant-login')) $('participant-login').hidden = signedIn;
  if ($('participant-register-details'))
    $('participant-register-details').hidden = signedIn;
  if ($('participant-resend-details'))
    $('participant-resend-details').hidden = signedIn;
  if ($('participant-signout')) $('participant-signout').hidden = !signedIn;
}
async function refreshParticipantSession() {
  if (!awardRefreshToken) return false;
  if (!awardRefreshInFlight) {
    awardRefreshInFlight = (async () => {
      let response;
      try {
        response = await fetch('/v1/identity/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: awardRefreshToken }),
        });
      } catch {
        throw new Error('Session refresh is unavailable. Please try again.');
      }
      if (!response.ok) {
        if ([401, 403].includes(response.status)) {
          clearParticipantSession();
          $('participant-auth-status').textContent =
            'Your session has expired. Please sign in again to continue.';
          return false;
        }
        throw new Error(
          `Session refresh failed (${response.status}). Please try again.`,
        );
      }
      const session = await response.json().catch(() => null);
      if (!session?.accessToken || !session?.refreshToken) {
        clearParticipantSession();
        $('participant-auth-status').textContent =
          'Your session is no longer valid. Please sign in again to continue.';
        return false;
      }
      awardAccessToken = session.accessToken;
      awardRefreshToken = session.refreshToken;
      localStorage.setItem('myota_public_access', awardAccessToken);
      localStorage.setItem('myota_public_refresh', awardRefreshToken);
      return true;
    })().finally(() => {
      awardRefreshInFlight = null;
    });
  }
  return awardRefreshInFlight;
}
async function participantFetch(path, options = {}) {
  const send = () => {
    const headers = { ...(options.headers || {}) };
    if (awardAccessToken) headers.Authorization = `Bearer ${awardAccessToken}`;
    return fetch(path, { ...options, headers });
  };
  let response = await send();
  if (
    [401, 403].includes(response.status) &&
    (await refreshParticipantSession())
  )
    response = await send();
  return response;
}
async function loadProgrammes() {
  const catalogue = [];
  let nextPage = 1;
  while (nextPage !== null) {
    const page = nextPage;
    const response = await api(`/v1/programmes?page=${page}&pageSize=100`);
    catalogue.push(...(response.items || []));
    nextPage = response.nextPage ?? null;
    if (nextPage !== null && nextPage <= page)
      throw new Error('Programme catalogue pagination did not advance.');
  }
  if (!catalogue.length)
    throw new Error('No programmes are currently available.');
  programmes = catalogue;
  $('programme-status').textContent = '';
  $('programme-retry').hidden = true;
  $('programme-select').innerHTML = programmes
    .map(
      (p) =>
        `<option value="${escapeHtml(p.slug)}">${escapeHtml(p.name)}</option>`,
    )
    .join('');
  const currentUrl = new URL(window.location.href);
  const hashSlug = currentUrl.hash.slice(1);
  const requestedSlug =
    currentUrl.searchParams.get('programme') ||
    (hashSlug === 'entity-statistics' ? '' : hashSlug);
  const selectedSlug = programmes.some(
    (programme) => programme.slug === requestedSlug,
  )
    ? requestedSlug
    : programmes[0].slug;
  $('programme-select').value = selectedSlug;
  if (requestedSlug && requestedSlug !== selectedSlug)
    location.hash = selectedSlug;
  await loadProgramme($('programme-select').value);
  const entityId = currentUrl.searchParams.get('entity');
  if (entityId) await loadEntityDetails(entityId);
}
async function loadProgramme(slug) {
  const generation = ++programmeLoadGeneration;
  publicMapRequest += 1;
  entityPageRequest += 1;
  entityPage = 1;
  entityHasNext = false;
  $('entity-prev').disabled = true;
  $('entity-next').disabled = true;
  activationEntityOptions = new Map();
  entities = [];
  entityStatistics = new Map();
  entityStatisticsState = 'loading';
  for (const id of [
    'entity-filter-country',
    'entity-filter-region',
    'entity-filter-province',
    'entity-filter-county',
    'entity-filter-city',
    'entity-filter-type',
  ])
    $(id).value = '';
  $('entity-filter-type').innerHTML = '<option value="">All types</option>';
  $('entities').replaceChildren();
  $('entity-count').textContent = '…';
  $('entity-page-status').textContent = '';
  $('entity-retry').hidden = true;
  $('activation-entity').replaceChildren();
  selectedMapEntityId = null;
  programmeMapExtent = null;
  $('map-status').textContent = 'Loading programme geography…';
  $('entity-map-popup')?.remove();
  const programme =
    programmes.find((p) => p.slug === slug) ||
    (await api(`/v1/programmes/${encodeURIComponent(slug)}`));
  if (generation !== programmeLoadGeneration) return;
  const primary = themeHex(programme.theme?.primary, '#0f766e');
  document.documentElement.style.setProperty('--primary', primary);
  document.documentElement.style.setProperty(
    '--primary-readable',
    readablePrimaryColor(primary),
  );
  document.documentElement.style.setProperty(
    '--primary-foreground',
    foregroundForPrimary(primary),
  );
  document.documentElement.style.setProperty(
    '--accent',
    themeHex(programme.theme?.accent, '#f59e0b'),
  );
  $('programme-name').textContent = programme.name;
  $('programme-description').textContent =
    programme.description?.trim() ||
    'Explore the places, programmes, and people behind every contact.';
  $('rules').innerHTML =
    `<dt>Activation QSOs</dt><dd>${escapeHtml(programme.rules.minimumQsos.activation)}</dd><dt>Hunter QSOs</dt><dd>${escapeHtml(programme.rules.minimumQsos.hunter)}</dd><dt>Public access</dt><dd>${programme.rules.publicAccessRequired ? 'Required' : 'Programme-defined'}</dd>`;
  const proposalTypes = Array.isArray(programme.entityTypes)
    ? programme.entityTypes
        .map((item) =>
          typeof item === 'string' ? { code: item, name: item } : item,
        )
        .filter((item) => {
          if (typeof item?.code !== 'string') return false;
          const geometries = Array.isArray(item.geometryTypes)
            ? item.geometryTypes
            : typeof item.geometry === 'string'
              ? [item.geometry]
              : [];
          return (
            !geometries.length ||
            geometries.some(
              (geometry) => String(geometry).toUpperCase() === 'POINT',
            )
          );
        })
    : (programme.entityTypeCodes || []).map((code) => ({ code, name: code }));
  const entityTypes = Array.isArray(programme.entityTypes)
    ? programme.entityTypes
        .map((item) =>
          typeof item === 'string' ? { code: item, name: item } : item,
        )
        .filter((item) => typeof item?.code === 'string')
    : (programme.entityTypeCodes || []).map((code) => ({ code, name: code }));
  $('entity-filter-type').innerHTML =
    '<option value="">All types</option>' +
    entityTypes
      .map(
        (item) =>
          `<option value="${escapeHtml(item.code)}">${escapeHtml(item.name || item.label || item.code)}</option>`,
      )
      .join('');
  $('proposal-entity-type').innerHTML = proposalTypes
    .map(
      (item) =>
        `<option value="${escapeHtml(item.code)}">${escapeHtml(item.name || item.label || item.code)}</option>`,
    )
    .join('');
  $('new-proposal-form').hidden = proposalTypes.length === 0;
  await loadProgrammeContent(slug);
  if (generation !== programmeLoadGeneration) return;
  await loadProgrammeEntities(slug, 1, generation);
  if (generation !== programmeLoadGeneration) return;
  await loadProgrammeMap(slug, generation);
  if (generation !== programmeLoadGeneration) return;
  await loadPublicAwards(slug);
  await loadPublicActivity(slug);
  await loadActivations();
}

async function loadProgrammeEntities(
  slug,
  page,
  generation = programmeLoadGeneration,
) {
  const request = ++entityPageRequest;
  $('entity-prev').disabled = true;
  $('entity-next').disabled = true;
  entities = [];
  $('entities').replaceChildren();
  $('entity-count').textContent = '…';
  $('entity-page-status').textContent = `Loading page ${page}…`;
  entityStatisticsRequest += 1;
  entityStatistics = new Map();
  entityStatisticsState = 'loading';
  $('loading').textContent = 'Loading entities…';
  try {
    const query = new URLSearchParams({
      programme: slug,
      status: 'APPROVED,CANDIDATE',
      page: String(page),
      pageSize: String(entityPageSize),
    });
    for (const [name, elementId] of Object.entries({
      country: 'entity-filter-country',
      region: 'entity-filter-region',
      province: 'entity-filter-province',
      county: 'entity-filter-county',
      city: 'entity-filter-city',
      entityType: 'entity-filter-type',
    })) {
      const value = $(elementId).value.trim();
      if (value) query.set(name, value);
    }
    const result = await api(`/v1/geodata/entities?${query}`);
    if (generation !== programmeLoadGeneration || request !== entityPageRequest)
      return;
    entities = result.items || [];
    $('entity-retry').hidden = true;
    entityPage = result.page || page;
    entityHasNext = Boolean(result.nextPage);
    const total = Number(result.total || 0);
    $('entity-count').textContent = total;
    const first = total ? (entityPage - 1) * entityPageSize + 1 : 0;
    const last = Math.min(entityPage * entityPageSize, total);
    $('loading').textContent =
      total === 0 ? 'No entities' : `Showing ${first}–${last} of ${total}`;
    renderEntities();
    void loadEntityStatistics(entities, generation, request);
    for (const entity of entities)
      if (['ACTIVE', 'APPROVED'].includes(entity.status))
        activationEntityOptions.set(entity.id, entity);
    const previousEntityId = $('activation-entity').value;
    $('activation-entity').innerHTML = [...activationEntityOptions.values()]
      .map(
        (entity) =>
          `<option value="${escapeHtml(entity.id)}">${escapeHtml(entity.name)} · ${escapeHtml(entity.entityType)}</option>`,
      )
      .join('');
    if (activationEntityOptions.has(previousEntityId))
      $('activation-entity').value = previousEntityId;
    $('entity-page-status').textContent =
      `Page ${entityPage} · ${total} entities`;
  } catch (error) {
    if (generation !== programmeLoadGeneration || request !== entityPageRequest)
      return;
    entities = [];
    entityStatistics = new Map();
    entityStatisticsState = 'unavailable';
    entityPage = 1;
    entityHasNext = false;
    activationEntityOptions.clear();
    $('activation-entity').replaceChildren();
    $('entities').replaceChildren();
    $('entity-count').textContent = '–';
    $('loading').textContent =
      'The entity catalogue is temporarily unavailable.';
    $('entity-page-status').textContent = error.message;
    $('entity-retry').hidden = false;
    renderEntities();
  } finally {
    if (
      generation === programmeLoadGeneration &&
      request === entityPageRequest
    ) {
      $('entity-prev').disabled = entityPage <= 1;
      $('entity-next').disabled = !entityHasNext;
    }
  }
}

async function loadProgrammeContent(slug, locale) {
  const request = ++programmeContentRequest;
  $('content-status').textContent = 'Loading published programme information…';
  $('programme-content').replaceChildren();
  try {
    const result = await api(
      `/v1/public/programmes/${encodeURIComponent(slug)}/content${locale ? `?locale=${encodeURIComponent(locale)}` : ''}`,
    );
    if (request !== programmeContentRequest) return;
    let items = result.items || [];
    if (!locale) {
      const locales = [
        ...new Set(
          items
            .map((item) => item.locale)
            .filter(
              (itemLocale) => typeof itemLocale === 'string' && itemLocale,
            ),
        ),
      ];
      const currentLocale = $('content-locale').value;
      locale = locales.includes(currentLocale)
        ? currentLocale
        : locales.includes('en')
          ? 'en'
          : locales[0] || 'en';
      $('content-locale-label').hidden = locales.length < 2;
      $('content-locale').innerHTML = locales
        .map(
          (itemLocale) =>
            `<option value="${escapeHtml(itemLocale)}">${escapeHtml(itemLocale)}</option>`,
        )
        .join('');
      if (locales.length) $('content-locale').value = locale;
      items = items.filter((item) => item.locale === locale);
    }
    $('content-status').textContent = items.length
      ? `${items.length} published item${items.length === 1 ? '' : 's'} · ${locale}`
      : `No published information is available in ${locale}.`;
    for (const item of items) {
      const article = document.createElement('article');
      article.className = 'public-content-item';
      const heading = document.createElement('h4');
      heading.textContent = item.key || 'Programme information';
      article.append(heading);
      const value = document.createElement('div');
      value.className = 'public-content-value';
      if (typeof item.value === 'string') {
        value.textContent = item.value;
      } else {
        const pre = document.createElement('pre');
        pre.textContent = JSON.stringify(item.value, null, 2);
        value.append(pre);
      }
      article.append(value);
      $('programme-content').append(article);
    }
  } catch (error) {
    if (request !== programmeContentRequest) return;
    $('content-status').textContent =
      `Programme information is temporarily unavailable. Use “Refresh programme data” to retry. ${error.message}`;
  }
}
function entityLocationSummary(entity) {
  const location = entity.location || {};
  return [
    entity.locality || location.locality,
    entity.city ||
      location.city ||
      entity.municipality ||
      location.municipality,
    entity.county || location.county,
    entity.province || location.province,
    entity.region || location.region,
    entity.country || location.country,
  ]
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(', ');
}
function formatEntityDate(value) {
  if (!value) return 'No valid activation recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Activation date unavailable'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}
function entityActivitySummary(entityId) {
  if (entityStatisticsState === 'unavailable')
    return '<span class="small entity-stats-unavailable">Activity summary unavailable</span>';
  if (entityStatisticsState === 'loading' && !entityStatistics.has(entityId))
    return '<span class="small" role="status">Loading activity…</span>';
  const statistics = entityStatistics.get(entityId) || {
    activationCount: 0,
    activationQsoCount: 0,
    hunterQsoCount: 0,
    qsoCount: 0,
    lastActivationAt: null,
  };
  return `<strong>${statistics.activationCount} valid activations · ${statistics.qsoCount} QSOs</strong><span class="small">${statistics.activationQsoCount} activation · ${statistics.hunterQsoCount} hunter</span><span class="small">Last: ${escapeHtml(formatEntityDate(statistics.lastActivationAt))}</span>`;
}
function renderEntities() {
  $('entities').innerHTML = entities
    .map((entity) => {
      const identifier = entity.entityIdentifier || 'Programme ID pending';
      const location =
        entityLocationSummary(entity) || 'Location details unavailable';
      const selected = entity.id === selectedMapEntityId;
      return `<tr class="${selected ? 'entity-row-selected' : ''}" data-entity-row="${escapeHtml(entity.id)}"><td><button type="button" class="entity-focus" data-id="${escapeHtml(entity.id)}" aria-pressed="${selected}"><span class="programme-entity-id">${escapeHtml(identifier)}</span><strong>${escapeHtml(entity.name)}</strong><span class="small">${escapeHtml(entity.entityType || 'Entity')}</span></button></td><td>${escapeHtml(location)}</td><td class="entity-activity-cell">${entityActivitySummary(entity.id)}</td><td><span class="badge ${escapeHtml(String(entity.status || '').toLowerCase())}">${escapeHtml(entity.status || 'Status unavailable')}</span></td><td>${entity.status === 'CANDIDATE' ? `<button data-id="${escapeHtml(entity.id)}" class="propose secondary" type="button">Propose</button>` : '<span class="small">Approved reference</span>'}</td></tr>`;
    })
    .join('');
  document.querySelectorAll('.entity-focus').forEach(
    (button) =>
      (button.onclick = () => {
        const entity = entities.find((item) => item.id === button.dataset.id);
        if (entity) focusMapEntity(entity);
      }),
  );
  document.querySelectorAll('.propose').forEach(
    (b) =>
      (b.onclick = async () => {
        const entity = entities.find((item) => item.id === b.dataset.id);
        if (!entity) return;
        b.disabled = true;
        $('proposal-status').textContent = 'Submitting proposal…';
        try {
          await submitProposal(entity.entityType, {
            type: 'Feature',
            properties: { name: entity.name },
            geometry: entity.geometry,
          });
        } catch (error) {
          $('proposal-status').textContent = error.message;
          b.disabled = false;
        }
      }),
  );
}
async function loadEntityStatistics(items, generation, pageRequest) {
  const request = ++entityStatisticsRequest;
  if (!items.length) {
    entityStatistics = new Map();
    entityStatisticsState = 'available';
    renderEntities();
    return;
  }
  entityStatisticsState = 'loading';
  try {
    const query = new URLSearchParams({
      programme: $('programme-select').value,
    });
    for (const entity of items) query.append('entityIds', entity.id);
    const result = await api(`/v1/public/entity-statistics?${query}`);
    if (
      request !== entityStatisticsRequest ||
      generation !== programmeLoadGeneration ||
      pageRequest !== entityPageRequest
    )
      return;
    entityStatistics = new Map(
      (result.items || []).map((item) => [item.entityId, item]),
    );
    entityStatisticsState = 'available';
  } catch {
    if (
      request !== entityStatisticsRequest ||
      generation !== programmeLoadGeneration ||
      pageRequest !== entityPageRequest
    )
      return;
    entityStatistics = new Map();
    entityStatisticsState = 'unavailable';
  }
  renderEntities();
}
async function submitProposal(entityType, feature) {
  if (!awardAccessToken) {
    $('proposal-status').textContent =
      'Sign in below before submitting a proposal.';
    $('award-email').focus();
    throw new Error('Sign in is required to submit a proposal.');
  }
  if (!awardAccount) awardAccount = await awardApi('/v1/identity/me');
  const body = {
    programmeSlug: $('programme-select').value,
    entityTypes: [entityType],
    source: {
      name: 'Participant community proposal',
      license: 'programme-supplied',
    },
    feature,
  };
  const request = pendingParticipantMutation('proposal-create', body, body);
  await awardApi('/v1/geodata/proposals', {
    method: 'POST',
    headers: { 'Idempotency-Key': request.key },
    body: JSON.stringify(request.body),
  });
  completePendingParticipantMutation(request.id);
  $('proposal-status').textContent = 'Proposal submitted for review.';
  await loadProgramme($('programme-select').value);
}
$('new-proposal-form').onsubmit = async (event) => {
  event.preventDefault();
  const latitude = Number($('proposal-latitude').value);
  const longitude = Number($('proposal-longitude').value);
  const name = $('proposal-name').value.trim();
  if (!name) {
    $('proposal-status').textContent = 'Enter a name for the location.';
    $('proposal-name').focus();
    return;
  }
  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    $('proposal-status').textContent =
      'Enter a latitude from -90 to 90 and longitude from -180 to 180.';
    return;
  }
  const submit = $('new-proposal-form').querySelector('[type="submit"]');
  submit.disabled = true;
  $('proposal-status').textContent = 'Submitting proposal…';
  try {
    await submitProposal($('proposal-entity-type').value, {
      type: 'Feature',
      properties: { name },
      geometry: { type: 'Point', coordinates: [longitude, latitude] },
    });
    $('new-proposal-form').reset();
  } catch (error) {
    $('proposal-status').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
};
$('programme-select').onchange = async (e) => {
  const url = new URL(window.location.href);
  url.searchParams.set('programme', e.target.value);
  url.searchParams.delete('entity');
  url.hash = e.target.value;
  window.history.replaceState({}, '', url);
  $('entity-statistics').hidden = true;
  try {
    await loadProgramme(e.target.value);
    $('programme-status').textContent = '';
  } catch (error) {
    $('programme-status').textContent =
      `Programme data is temporarily unavailable. Use “Retry programme catalogue” to retry. ${error.message}`;
    $('programme-retry').hidden = false;
  }
};
$('programme-retry').onclick = () =>
  loadProgrammes().catch((error) => {
    $('programme-status').textContent =
      `Programme catalogue is temporarily unavailable. ${error.message}`;
    $('programme-retry').hidden = false;
  });
$('entity-retry').onclick = () =>
  loadProgrammeEntities($('programme-select').value, entityPage).catch(
    (error) => {
      $('loading').textContent = error.message;
      $('entity-retry').hidden = false;
    },
  );
$('entity-filters').onsubmit = (event) => {
  event.preventDefault();
  loadProgrammeEntities($('programme-select').value, 1).catch((error) => {
    $('entity-page-status').textContent = error.message;
  });
};
$('entity-filters').onreset = () =>
  window.setTimeout(() => {
    loadProgrammeEntities($('programme-select').value, 1).catch((error) => {
      $('entity-page-status').textContent = error.message;
    });
  }, 0);
$('public-activity-prev').onclick = () =>
  loadPublicActivity(
    $('programme-select').value,
    Math.max(1, publicActivityPage - 1),
  );
$('public-activity-next').onclick = () => {
  if (publicActivityNextPage)
    loadPublicActivity($('programme-select').value, publicActivityNextPage);
};
$('public-ranking-category').onchange = () =>
  loadPublicLeaderboard(
    $('programme-select').value,
    $('public-ranking-category').value,
  );
$('public-results-download').onclick = async (event) => {
  event.preventDefault();
  const link = $('public-results-download');
  const status = $('public-results-status');
  link.setAttribute('aria-busy', 'true');
  status.textContent = 'Preparing programme results download…';
  const slug = $('programme-select').value;
  try {
    const result = await api(
      `/v1/public/results?programme=${encodeURIComponent(slug)}&format=csv`,
    );
    if (result.format !== 'csv' || typeof result.content !== 'string')
      throw new Error('The results service returned an invalid CSV export.');
    const filename = result.downloadName || `myota-results-${slug}.csv`;
    const url = URL.createObjectURL(
      new Blob([result.content], { type: 'text/csv;charset=utf-8' }),
    );
    const download = document.createElement('a');
    download.href = url;
    download.download = filename;
    document.body.append(download);
    download.click();
    download.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = `Downloaded ${filename}.`;
  } catch (error) {
    status.textContent = `Programme results are temporarily unavailable. Try again. ${error.message}`;
  } finally {
    link.removeAttribute('aria-busy');
  }
};
$('community-refresh').onclick = () =>
  loadPublicActivity($('programme-select').value, publicActivityPage);
$('entity-prev').onclick = () =>
  loadProgrammeEntities($('programme-select').value, entityPage - 1).catch(
    (error) => {
      $('loading').textContent = error.message;
    },
  );
$('entity-next').onclick = () =>
  loadProgrammeEntities($('programme-select').value, entityPage + 1).catch(
    (error) => {
      $('loading').textContent = error.message;
    },
  );
$('entity-statistics-back').onclick = (event) => {
  event.preventDefault();
  const url = new URL(window.location.href);
  url.searchParams.delete('entity');
  url.hash = 'entity-catalogue';
  window.history.pushState({}, '', url);
  $('entity-statistics').hidden = true;
  $('entity-catalogue').scrollIntoView({ behavior: 'smooth', block: 'start' });
};
window.addEventListener('popstate', () => {
  const url = new URL(window.location.href);
  const entityId = url.searchParams.get('entity');
  if (entityId) {
    void loadEntityDetails(entityId, undefined, true);
  } else {
    $('entity-statistics').hidden = true;
  }
});
$('content-locale').onchange = () =>
  loadProgrammeContent($('programme-select').value, $('content-locale').value);
$('refresh').onclick = () =>
  loadProgramme($('programme-select').value).catch((error) => {
    $('programme-status').textContent =
      `Programme data is temporarily unavailable. ${error.message}`;
  });
loadProgrammes().catch((e) => {
  $('programme-status').textContent =
    `Programme catalogue is temporarily unavailable. ${e.message}`;
  $('programme-retry').hidden = false;
});

let publicMapState = { lat: 0, lon: 0, zoom: 2 };
let programmeMapExtent = null;
let publicMapRequest = 0;
let publicMapFeatureIndex = new Map();
let selectedMapEntityId = null;
let entityDetailsRequest = 0;
let proposalLocationPickActive = false;
function publicWorld(lon, lat, zoom) {
  const safeLatitude = Math.max(
    -85.05112878,
    Math.min(85.05112878, Number(lat)),
  );
  const size = 256 * 2 ** zoom,
    x = ((Number(lon) + 180) / 360) * size,
    sin = Math.sin((safeLatitude * Math.PI) / 180),
    y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size;
  return { x, y, size };
}
function publicProject(coord, width, height) {
  const center = publicWorld(
      publicMapState.lon,
      publicMapState.lat,
      publicMapState.zoom,
    ),
    point = publicWorld(coord[0], coord[1], publicMapState.zoom);
  let dx = point.x - center.x;
  if (dx > center.size / 2) dx -= center.size;
  if (dx < -center.size / 2) dx += center.size;
  return [width / 2 + dx, height / 2 + point.y - center.y];
}
function publicUnproject(x, y, width, height) {
  const center = publicWorld(
      publicMapState.lon,
      publicMapState.lat,
      publicMapState.zoom,
    ),
    worldX = center.x + x - width / 2,
    worldY = center.y + y - height / 2,
    rawLon = (worldX / center.size) * 360 - 180,
    lon = ((((rawLon + 180) % 360) + 360) % 360) - 180,
    n = Math.PI - (2 * Math.PI * worldY) / center.size,
    rawLat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))),
    lat = Math.max(-85.05112878, Math.min(85.05112878, rawLat));
  return [lon, lat];
}
function setProposalLocationPick(active) {
  proposalLocationPickActive = active;
  $('map').classList.toggle('picking-location', active);
  const button = $('proposal-location-pick');
  button.setAttribute('aria-pressed', String(active));
  button.textContent = active
    ? 'Cancel map selection'
    : 'Pick coordinates on map';
  if (active)
    $('proposal-status').textContent =
      'Click the map where the proposed point is located.';
}
$('proposal-location-pick').onclick = () =>
  setProposalLocationPick(!proposalLocationPickActive);
async function loadProgrammeMap(slug, generation) {
  const request = ++publicMapRequest;
  try {
    const extent = await api(
      `/v1/geodata/map/extent?programme=${encodeURIComponent(slug)}`,
    );
    if (request !== publicMapRequest || generation !== programmeLoadGeneration)
      return;
    programmeMapExtent = extent.bbox;
    if (programmeMapExtent) fitPublicMapExtent(programmeMapExtent);
    $('map-status').textContent = extent.total
      ? `Showing the programme geography · ${extent.total} entities`
      : 'This programme has no mapped entities yet.';
    void publicTileMap();
  } catch (error) {
    if (request !== publicMapRequest || generation !== programmeLoadGeneration)
      return;
    programmeMapExtent = null;
    $('map-status').textContent =
      `Programme map is temporarily unavailable. ${error.message}`;
    void publicTileMap();
  }
}
function fitPublicMapExtent(bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox.map(Number);
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return;
  const map = $('map');
  const width = Math.max(map.clientWidth || 900, 300);
  const height = Math.max(map.clientHeight || 420, 280);
  const min = publicWorld(minLon, minLat, 0);
  const max = publicWorld(maxLon, maxLat, 0);
  const rawSpanX = Math.abs(max.x - min.x);
  const globalExtent = rawSpanX > 128;
  const spanX = globalExtent ? 256 : rawSpanX;
  const spanY = Math.abs(max.y - min.y);
  const scaleX = (width - 96) / Math.max(spanX, 0.002);
  const scaleY = (height - 96) / Math.max(spanY, 0.002);
  const zoom = Math.max(
    2,
    Math.min(18, Math.floor(Math.log2(Math.min(scaleX, scaleY)))),
  );
  const centerLon = globalExtent ? 0 : (minLon + maxLon) / 2;
  publicMapState = {
    lat: (minLat + maxLat) / 2,
    lon: centerLon,
    zoom,
  };
}
function publicEntityDetailsUrl(programme, entityId) {
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('programme', programme);
  url.searchParams.set('entity', entityId);
  url.hash = 'entity-statistics';
  return `${url.pathname}${url.search}${url.hash}`;
}
function showEntityMapPopup(entity) {
  selectedMapEntityId = entity.id;
  renderEntities();
  const popup = $('entity-map-popup');
  if (!popup) return;
  const location = entityLocationSummary(entity);
  const identifier = entity.entityIdentifier || 'Programme ID pending';
  popup.innerHTML = `<button type="button" class="entity-map-popup-close secondary" aria-label="Close entity details">×</button><p class="eyebrow">${escapeHtml(entity.status || 'Entity')}</p><h4 id="entity-map-popup-heading">${escapeHtml(entity.name || 'Geographic entity')}</h4><p class="programme-entity-id">${escapeHtml(identifier)}</p><p>${escapeHtml(location || 'Location details unavailable')}</p><a class="entity-statistics-link" href="${escapeHtml(publicEntityDetailsUrl(entity.programmeSlug || $('programme-select').value, entity.id))}">View activation and hunter QSO statistics</a>`;
  popup.setAttribute('aria-labelledby', 'entity-map-popup-heading');
  popup.hidden = false;
  popup.querySelector('.entity-map-popup-close').onclick = () => {
    popup.hidden = true;
  };
  popup.querySelector('.entity-statistics-link').onclick = (event) => {
    event.preventDefault();
    openEntityDetails(
      entity.programmeSlug || $('programme-select').value,
      entity.id,
      entity,
    );
  };
  popup.onkeydown = (event) => {
    if (event.key === 'Escape') popup.hidden = true;
  };
}
function entityMapCenter(entity) {
  const centroid = entity.centroid;
  if (
    Number.isFinite(Number(centroid?.lon)) &&
    Number.isFinite(Number(centroid?.lat))
  )
    return [Number(centroid.lon), Number(centroid.lat)];
  const coordinates = [];
  const visit = (value) => {
    if (
      Array.isArray(value) &&
      value.length >= 2 &&
      value.slice(0, 2).every((coordinate) => typeof coordinate === 'number')
    ) {
      coordinates.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    }
  };
  visit(entity.geometry?.coordinates);
  if (!coordinates.length) return null;
  const longitudes = coordinates.map((coordinate) => coordinate[0]);
  const latitudes = coordinates.map((coordinate) => coordinate[1]);
  return [
    (Math.min(...longitudes) + Math.max(...longitudes)) / 2,
    (Math.min(...latitudes) + Math.max(...latitudes)) / 2,
  ];
}
function focusMapEntity(entity) {
  const center = entityMapCenter(entity);
  if (!center) {
    $('map-status').textContent =
      `No map geometry is available for ${entity.name}.`;
    return;
  }
  publicMapState.lon = center[0];
  publicMapState.lat = center[1];
  publicMapState.zoom = Math.max(publicMapState.zoom, 12);
  $('map-status').textContent = `Map centered on ${entity.name}.`;
  void publicTileMap();
  showEntityMapPopup({
    ...entity,
    id: entity.id,
    programmeSlug: entity.programmeSlug || $('programme-select').value,
  });
  $('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
async function openEntityDetails(programme, entityId, entity) {
  const url = new URL(
    publicEntityDetailsUrl(programme, entityId),
    window.location.origin,
  );
  window.history.pushState({}, '', url);
  await loadEntityDetails(entityId, entity, true);
}
async function loadEntityDetails(entityId, suppliedEntity, scroll = false) {
  const request = ++entityDetailsRequest;
  $('entity-statistics').hidden = false;
  $('entity-statistics-heading').textContent = 'Loading entity activity…';
  $('entity-statistics-location').textContent = '';
  $('entity-statistics-status').textContent =
    'Loading public activity statistics…';
  for (const field of [
    'entity-statistics-activations',
    'entity-statistics-qsos',
    'entity-statistics-activation-qsos',
    'entity-statistics-hunter-qsos',
    'entity-statistics-last-activation',
  ])
    $(field).textContent = '—';
  try {
    const entity =
      suppliedEntity ||
      entities.find((item) => item.id === entityId) ||
      (await api(`/v1/geodata/entities/${encodeURIComponent(entityId)}`));
    if (request !== entityDetailsRequest) return;
    $('entity-statistics-heading').textContent =
      `${entity.entityIdentifier || 'Programme ID pending'} · ${entity.name}`;
    document.title = `${entity.name} · MyOTA`;
    $('entity-statistics-location').textContent =
      `${entity.entityType || 'Geographic entity'} · ${entityLocationSummary(entity) || 'Location details unavailable'}`;
    const query = new URLSearchParams({
      programme: $('programme-select').value,
      entityIds: entityId,
    });
    const result = await api(`/v1/public/entity-statistics?${query}`);
    if (request !== entityDetailsRequest) return;
    const statistics = (result.items || []).find(
      (item) => item.entityId === entityId,
    );
    if (!statistics) throw new Error('Entity statistics were not returned.');
    $('entity-statistics-activations').textContent = statistics.activationCount;
    $('entity-statistics-qsos').textContent = statistics.qsoCount;
    $('entity-statistics-activation-qsos').textContent =
      statistics.activationQsoCount;
    $('entity-statistics-hunter-qsos').textContent = statistics.hunterQsoCount;
    $('entity-statistics-last-activation').textContent = formatEntityDate(
      statistics.lastActivationAt,
    );
    $('entity-statistics-status').textContent = '';
    if (scroll)
      $('entity-statistics').scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
  } catch (error) {
    if (request !== entityDetailsRequest) return;
    $('entity-statistics-heading').textContent = 'Entity activity statistics';
    $('entity-statistics-status').textContent =
      `Entity details are temporarily unavailable. ${error.message}`;
  }
}
function publicTileMap() {
  const request = ++publicMapRequest;
  const map = $('map');
  if (!$('programme-select').value) return;
  const width = Math.max(map.clientWidth || 700, 300),
    height = Math.max(map.clientHeight || 420, 280),
    center = publicWorld(
      publicMapState.lon,
      publicMapState.lat,
      publicMapState.zoom,
    ),
    surface = document.createElement('div');
  surface.className = 'public-tile-surface';
  map.innerHTML =
    '<div id="public-tile-layer"></div><svg id="public-map-overlay" class="public-map-overlay" role="group" viewBox="0 0 ' +
    width +
    ' ' +
    height +
    '" aria-label="Entity map"></svg><div id="entity-map-popup" class="entity-map-popup" role="dialog" aria-live="polite" hidden></div><div class="public-map-controls"><button type="button" data-public-zoom="in" aria-label="Zoom in">+</button><button type="button" data-public-zoom="out" aria-label="Zoom out">−</button><button type="button" data-public-reset="true" aria-label="Reset map view">⌂</button></div><a class="public-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>';
  const layer = $('public-tile-layer');
  layer.className = 'public-tile-surface';
  const firstX = Math.floor((center.x - width / 2) / 256),
    lastX = Math.floor((center.x + width / 2) / 256),
    firstY = Math.max(0, Math.floor((center.y - height / 2) / 256)),
    lastY = Math.min(
      2 ** publicMapState.zoom - 1,
      Math.floor((center.y + height / 2) / 256),
    ),
    count = 2 ** publicMapState.zoom;
  for (let x = firstX; x <= lastX; x += 1)
    for (let y = firstY; y <= lastY; y += 1) {
      const image = document.createElement('img');
      image.className = 'public-osm-tile';
      image.alt = '';
      image.draggable = false;
      image.src = `https://tile.openstreetmap.org/${publicMapState.zoom}/${((x % count) + count) % count}/${y}.png`;
      image.style.left = `${x * 256 - center.x + width / 2}px`;
      image.style.top = `${y * 256 - center.y + height / 2}px`;
      layer.appendChild(image);
    }
  const overlay = $('public-map-overlay');
  const tileKeys = [];
  for (let x = firstX; x <= lastX; x += 1)
    for (let y = firstY; y <= lastY; y += 1) {
      if (y < 0 || y >= count) continue;
      const tileX = ((x % count) + count) % count;
      const key = `${tileX}/${y}`;
      if (!tileKeys.includes(key)) tileKeys.push(key);
    }
  Promise.all(
    tileKeys.map(async (key) => {
      const [tileX, tileY] = key.split('/');
      const query = new URLSearchParams({
        programme: $('programme-select').value,
        status: 'APPROVED,CANDIDATE',
      });
      try {
        return await api(
          `/v1/geodata/tiles/${publicMapState.zoom}/${tileX}/${tileY}?${query}`,
        );
      } catch {
        return null;
      }
    }),
  ).then((tiles) => {
    if (request !== publicMapRequest) return;
    const features = new Map();
    for (const tile of tiles)
      for (const feature of tile?.features || []) {
        if (!feature.id) continue;
        const id = String(feature.id);
        const existing = features.get(id);
        if (!existing) {
          features.set(id, feature);
          continue;
        }
        const geometries = (geometry) =>
          geometry?.type === 'GeometryCollection'
            ? geometry.geometries || []
            : geometry
              ? [geometry]
              : [];
        existing.geometry = {
          type: 'GeometryCollection',
          geometries: [
            ...geometries(existing.geometry),
            ...geometries(feature.geometry),
          ],
        };
      }
    publicMapFeatureIndex = new Map(
      [...features.values()].map((feature) => [
        String(feature.id),
        {
          ...feature.properties,
          id: String(feature.id),
          geometry: feature.geometry,
          centroid: feature.properties?.centroid,
        },
      ]),
    );
    overlay.innerHTML = [...features.values()]
      .map((feature) => {
        const entity = publicMapFeatureIndex.get(String(feature.id));
        const geometry = feature.geometry;
        if (!entity || !geometry?.type) return '';
        const status = escapeHtml(String(entity.status || '').toLowerCase());
        const projectLine = (coordinates) =>
          coordinates
            .map((coordinate) => publicProject(coordinate, width, height))
            .map(([x, y]) => `${x},${y}`)
            .join(' ');
        const projectRing = (coordinates) => {
          const points = coordinates.map((coordinate) =>
            publicProject(coordinate, width, height),
          );
          if (points.length < 3) return '';
          return `M ${points.map(([x, y]) => `${x} ${y}`).join(' L ')} Z`;
        };
        const allPositions = (coordinates) => {
          if (
            Array.isArray(coordinates) &&
            coordinates.length >= 2 &&
            coordinates.slice(0, 2).every((value) => typeof value === 'number')
          ) {
            return [coordinates];
          }
          return Array.isArray(coordinates)
            ? coordinates.flatMap(allPositions)
            : [];
        };
        const geometryPositions = (item) =>
          item.type === 'GeometryCollection'
            ? (item.geometries || []).flatMap(geometryPositions)
            : allPositions(item.coordinates);
        const drawGeometry = (item) => {
          if (item.type === 'GeometryCollection')
            return (item.geometries || []).map(drawGeometry).join('');
          const positions = allPositions(item.coordinates);
          if (!positions.length) return '';
          if (item.type === 'Point') {
            const [x, y] = publicProject(positions[0], width, height);
            return `<circle cx="${x}" cy="${y}" r="8" class="public-entity-point ${status}"/>`;
          }
          if (item.type === 'MultiPoint')
            return positions
              .map(([lon, lat]) => {
                const [x, y] = publicProject([lon, lat], width, height);
                return `<circle cx="${x}" cy="${y}" r="7" class="public-entity-point ${status}"/>`;
              })
              .join('');
          if (item.type === 'LineString')
            return `<polyline points="${projectLine(item.coordinates)}" class="public-entity-line ${status}"/>`;
          if (item.type === 'MultiLineString')
            return item.coordinates
              .map(
                (line) =>
                  `<polyline points="${projectLine(line)}" class="public-entity-line ${status}"/>`,
              )
              .join('');
          const polygons =
            item.type === 'Polygon'
              ? [item.coordinates]
              : item.type === 'MultiPolygon'
                ? item.coordinates
                : [];
          const path = polygons
            .flatMap((polygon) => polygon.map(projectRing))
            .filter(Boolean)
            .join(' ');
          return path
            ? `<path d="${path}" fill-rule="evenodd" class="public-entity-polygon ${status}"/>`
            : '';
        };
        const positions = geometryPositions(geometry);
        if (!positions.length) return '';
        const first = publicProject(positions[0], width, height);
        const shape = drawGeometry(geometry);
        if (!shape) return '';
        const selected = entity.id === selectedMapEntityId;
        const label =
          publicMapState.zoom >= 9
            ? `<text x="${first[0] + 10}" y="${first[1] - 9}" class="public-map-label">${escapeHtml(entity.name)}</text>`
            : '';
        return `<g data-map-entity="${escapeHtml(entity.id)}" class="public-map-entity ${selected ? 'selected' : ''}" role="button" tabindex="0" aria-pressed="${selected}" aria-label="Show ${escapeHtml(entity.name)} details"><title>${escapeHtml(entity.name)} · ${escapeHtml(entity.status)}</title>${shape}${label}</g>`;
      })
      .join('');
    overlay.querySelectorAll('[data-map-entity]').forEach((featureElement) => {
      const show = () => {
        const entity = publicMapFeatureIndex.get(
          featureElement.dataset.mapEntity,
        );
        if (entity) showEntityMapPopup(entity);
      };
      featureElement.addEventListener('click', show);
      featureElement.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          show();
        }
      });
    });
    if (tiles.some((tile) => tile?.truncated))
      $('map-status').textContent =
        'Map detail is limited at this zoom level. Zoom in to inspect dense areas.';
    if (!tiles.some(Boolean) && programmeMapExtent)
      $('map-status').textContent =
        'Map entities are temporarily unavailable; the programme extent is still shown.';
  });
  document.querySelectorAll('[data-public-zoom]').forEach(
    (button) =>
      (button.onclick = () => {
        publicMapState.zoom = Math.max(
          2,
          Math.min(
            18,
            publicMapState.zoom + (button.dataset.publicZoom === 'in' ? 1 : -1),
          ),
        );
        publicTileMap();
      }),
  );
  document.querySelector('[data-public-reset]').onclick = () => {
    if (programmeMapExtent) fitPublicMapExtent(programmeMapExtent);
    else publicMapState = { lat: 0, lon: 0, zoom: 2 };
    void publicTileMap();
  };
  let drag = null;
  overlay.addEventListener('pointerdown', (event) => {
    drag = {
      x: event.clientX,
      y: event.clientY,
      moved: false,
      captured: false,
    };
  });
  overlay.addEventListener('pointermove', (event) => {
    if (!drag) return;
    drag.moved ||=
      Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 3;
    if (!drag.moved) return;
    if (!drag.captured) {
      overlay.setPointerCapture(event.pointerId);
      drag.captured = true;
    }
    layer.style.transform = `translate(${event.clientX - drag.x}px,${event.clientY - drag.y}px)`;
    overlay.style.transform = `translate(${event.clientX - drag.x}px,${event.clientY - drag.y}px)`;
  });
  overlay.addEventListener('pointerup', (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x,
      dy = event.clientY - drag.y;
    if (proposalLocationPickActive && !drag.moved) {
      const bounds = overlay.getBoundingClientRect();
      const x = ((event.clientX - bounds.left) / bounds.width) * width;
      const y = ((event.clientY - bounds.top) / bounds.height) * height;
      const [longitude, latitude] = publicUnproject(x, y, width, height);
      $('proposal-latitude').value = latitude.toFixed(6);
      $('proposal-longitude').value = longitude.toFixed(6);
      setProposalLocationPick(false);
      $('proposal-status').textContent =
        `Selected ${latitude.toFixed(6)}, ${longitude.toFixed(6)}.`;
      drag = null;
      return;
    }
    if (drag.moved) {
      [publicMapState.lon, publicMapState.lat] = publicUnproject(
        width / 2 - dx,
        height / 2 - dy,
        width,
        height,
      );
      publicTileMap();
    }
    drag = null;
  });
  overlay.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      publicMapState.zoom = Math.max(
        2,
        Math.min(18, publicMapState.zoom + (event.deltaY < 0 ? 1 : -1)),
      );
      publicTileMap();
    },
    { passive: false },
  );
}
function renderMarkers() {
  void publicTileMap();
}
if ('ResizeObserver' in window) {
  new ResizeObserver(() => {
    if ($('programme-select').value) void publicTileMap();
  }).observe($('map'));
}
async function loadPublicAwards(slug) {
  const request = ++publicAwardsRequest;
  publicAwards = [];
  $('award-status').textContent = 'Loading published awards…';
  $('public-awards').textContent = 'Loading programme awards…';
  try {
    const items = [];
    let page = 1;
    while (page !== null) {
      const data = await api(
        `/v1/awards?programme=${encodeURIComponent(slug)}&page=${page}&pageSize=100`,
      );
      if (request !== publicAwardsRequest) return;
      items.push(...(data.items || []));
      const nextPage = data.nextPage;
      if (nextPage == null) {
        page = null;
      } else if (Number.isInteger(nextPage) && nextPage > page) {
        page = nextPage;
      } else {
        throw new Error('The award catalogue returned invalid paging data.');
      }
    }
    if (request !== publicAwardsRequest) return;
    publicAwards = items;
    $('award-status').textContent = '';
    renderPublicAwards();
  } catch (error) {
    if (request !== publicAwardsRequest) return;
    publicAwards = [];
    $('public-awards').innerHTML =
      '<p class="small">Awards are temporarily unavailable. Use “Refresh programme data” to retry.</p>';
    $('award-status').textContent = error.message;
  }
}
async function loadPublicActivity(slug, page = 1) {
  publicActivityPage = page;
  const resultsLink = $('public-results-download');
  resultsLink.href = '#community';
  await Promise.all([
    loadPublicActivationHistory(slug, page),
    loadPublicLeaderboard(slug, $('public-ranking-category').value),
  ]);
}
async function loadPublicActivationHistory(slug, page) {
  const request = ++publicActivityRequest;
  const list = $('public-activations');
  $('public-activity-status').textContent = 'Loading recent activations…';
  $('public-activity-page').textContent = '';
  $('public-activity-prev').disabled = true;
  $('public-activity-next').disabled = true;
  list.replaceChildren();
  try {
    const result = await api(
      `/v1/public/activations?programme=${encodeURIComponent(slug)}&page=${page}&pageSize=5`,
    );
    if (request !== publicActivityRequest) return;
    const items = result.items || [];
    publicActivityPage = result.page || page;
    publicActivityNextPage = result.nextPage ?? null;
    $('public-activity-status').textContent = '';
    $('public-activity-page').textContent =
      `Page ${publicActivityPage} · ${Number(result.total || 0)} public activations`;
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'small';
      empty.textContent = 'No public activations have been recorded yet.';
      list.append(empty);
    }
    for (const activation of items) {
      const item = document.createElement('li');
      const callsign = document.createElement('strong');
      callsign.textContent = activation.operatorCallsign || 'Participant';
      const summary = document.createElement('span');
      summary.textContent = `${Number(activation.qsoCount || 0)} QSOs · ${activation.status || 'Status unavailable'}`;
      const timestamp = document.createElement('span');
      timestamp.textContent = activation.startedAt || 'Start time unavailable';
      item.append(callsign, summary, timestamp);
      list.append(item);
    }
  } catch (error) {
    if (request !== publicActivityRequest) return;
    publicActivityNextPage = null;
    $('public-activity-status').textContent =
      `Public activity is temporarily unavailable. Use “Refresh community activity” to retry. ${error.message}`;
    const unavailable = document.createElement('li');
    unavailable.className = 'small';
    unavailable.textContent = 'Recent activations could not be loaded.';
    list.replaceChildren(unavailable);
  } finally {
    if (request === publicActivityRequest) {
      $('public-activity-prev').disabled = publicActivityPage <= 1;
      $('public-activity-next').disabled = !publicActivityNextPage;
    }
  }
}
async function loadPublicLeaderboard(slug, category) {
  const request = ++leaderboardRequest;
  const normalizedCategory = category === 'ACTIVATOR' ? 'ACTIVATOR' : 'HUNTER';
  const list = $('public-leaderboard');
  $('leaderboard-heading').textContent =
    normalizedCategory === 'ACTIVATOR' ? 'Top activators' : 'Top hunters';
  $('leaderboard-status').textContent = 'Loading programme rankings…';
  list.replaceChildren();
  try {
    const result = await api(
      `/v1/public/leaderboards?programme=${encodeURIComponent(slug)}&category=${normalizedCategory}`,
    );
    if (request !== leaderboardRequest) return;
    const items = result.items || [];
    $('leaderboard-status').textContent = '';
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'small';
      empty.textContent = 'Rankings will appear when activity is recorded.';
      list.append(empty);
      return;
    }
    items.forEach((entry, index) => {
      const item = document.createElement('li');
      const rank = document.createElement('strong');
      rank.textContent = `#${index + 1}`;
      const participant = document.createElement('span');
      participant.textContent =
        normalizedCategory === 'ACTIVATOR'
          ? `Activator ${index + 1}`
          : `Hunter ${index + 1}`;
      const totals = document.createElement('small');
      totals.textContent = `${Number(entry.qso_count || 0)} QSOs · ${Number(entry.activation_count || 0)} activations · ${Number(entry.unique_entity_count || 0)} unique entities`;
      item.append(rank, participant, totals);
      list.append(item);
    });
  } catch (error) {
    if (request !== leaderboardRequest) return;
    $('leaderboard-status').textContent =
      `Programme rankings are temporarily unavailable. Use “Refresh community activity” to retry. ${error.message}`;
    const unavailable = document.createElement('li');
    unavailable.className = 'small';
    unavailable.textContent = 'The programme rankings could not be loaded.';
    list.replaceChildren(unavailable);
  }
}
async function loadMyAwardRequests() {
  const panel = $('participant-award-requests');
  const list = $('participant-award-request-items');
  if (!panel || !list || !awardAccessToken || !awardAccount) {
    if (panel) panel.hidden = true;
    return;
  }
  panel.hidden = false;
  list.innerHTML = '<p class="small">Loading your award requests…</p>';
  try {
    const items = [];
    let page = 1;
    while (page !== null) {
      const data = await awardApi(
        `/v1/awards/requests?subjectId=${encodeURIComponent(awardAccount.id)}&page=${page}&pageSize=50`,
      );
      items.push(...(data.items || []));
      const nextPage = data.nextPage;
      if (nextPage == null) {
        page = null;
      } else if (Number.isInteger(nextPage) && nextPage > page) {
        page = nextPage;
      } else {
        throw new Error('Your award requests returned invalid paging data.');
      }
    }
    list.innerHTML = items.length
      ? items
          .map(
            (item) =>
              `<div class="award-request-item"><span><strong>${escapeHtml(item.callsign)} · ${escapeHtml(item.personName)}</strong><small>${escapeHtml(item.programmeSlug)} · ${escapeHtml(item.levelId)}</small></span><span class="award-request-status">${escapeHtml(item.status === 'ISSUED' ? (item.artifactReady ? 'ISSUED · PDF READY' : 'ISSUED · CERTIFICATE PROCESSING') : item.status)}</span>${item.status === 'ISSUED' && item.artifactReady ? `<button class="award-level" type="button" data-issued-award-id="${escapeHtml(item.issuedAwardId)}">Download certificate</button>` : ''}</div>`,
          )
          .join('')
      : '<p class="small">You have not requested any awards yet.</p>';
    list.querySelectorAll('[data-issued-award-id]').forEach((button) => {
      button.onclick = () => downloadIssuedAward(button.dataset.issuedAwardId);
    });
  } catch (error) {
    list.innerHTML = `<p class="small">Your award requests are temporarily unavailable. ${escapeHtml(error.message)}</p>`;
  }
}
async function downloadIssuedAward(issuanceId) {
  const popup = window.open('about:blank', '_blank');
  if (!popup) {
    $('award-status').textContent =
      'Allow pop-ups to open your certificate download.';
    return;
  }
  popup.opener = null;
  $('award-status').textContent = 'Preparing your certificate download…';
  try {
    const artifact = await awardApi(
      `/v1/awards/issuances/${encodeURIComponent(issuanceId)}/artifact`,
    );
    if (!artifact.downloadUrl)
      throw new Error('The certificate download is unavailable.');
    popup.location.replace(artifact.downloadUrl);
    $('award-status').textContent = '';
  } catch (error) {
    popup.close();
    $('award-status').textContent = error.message;
  }
}
function renderPublicAwards() {
  if (!publicAwards.length) {
    $('public-awards').innerHTML =
      '<p class="small">This programme has not published any awards yet.</p>';
    return;
  }
  $('public-awards').innerHTML = publicAwards
    .map(
      (award) =>
        `<article class="public-award"><div><h4>${escapeHtml(award.name)}</h4><p class="small">${escapeHtml(award.description || '')} · ${escapeHtml(award.category)} · ${escapeHtml(award.achievementMetric)}</p></div><div class="award-levels">${(award.levels || []).map((level) => `<button class="award-level" data-award-id="${escapeHtml(award.id)}" data-level-id="${escapeHtml(level.id)}">${escapeHtml(level.name || level.label || level.id)} · ${escapeHtml(level.threshold)}</button>`).join('')}</div></article>`,
    )
    .join('');
  document
    .querySelectorAll('[data-award-id]')
    .forEach(
      (button) =>
        (button.onclick = () =>
          requestPublicAward(button.dataset.awardId, button.dataset.levelId)),
    );
}
async function loadActivations() {
  const request = ++activationRequest;
  const slug = $('programme-select').value;
  const signedIn = Boolean(awardAccessToken && awardAccount);
  $('activation-start-form').hidden = !signedIn;
  $('qso-form').hidden = !signedIn;
  $('adif-import-form').hidden = !signedIn;
  if (!signedIn) {
    activations = [];
    $('activations-list').innerHTML = '';
    return false;
  }
  activations = [];
  $('activations-list').textContent = 'Loading your activations…';
  $('qso-activation').replaceChildren();
  $('qso-form').hidden = true;
  $('adif-import-form').hidden = true;
  $('activation-status').textContent = 'Loading your activations…';
  try {
    const items = [];
    let page = 1;
    while (page !== null) {
      const result = await awardApi(
        `/v1/activations?programme=${encodeURIComponent(slug)}&operatorId=${encodeURIComponent(awardAccount.id)}&page=${page}&pageSize=100`,
      );
      if (request !== activationRequest) return false;
      items.push(...(result.items || []));
      const nextPage = result.nextPage;
      if (nextPage == null) {
        page = null;
      } else if (Number.isInteger(nextPage) && nextPage > page) {
        page = nextPage;
      } else {
        throw new Error('Activation history returned invalid paging data.');
      }
    }
    if (request !== activationRequest) return false;
    activations = items;
    const open = activations.filter(
      (activation) => activation.status === 'OPEN',
    );
    $('qso-activation').innerHTML = open
      .map(
        (activation) =>
          `<option value="${escapeHtml(activation.id)}">${escapeHtml(activation.operatorCallsign || 'Activation')} · ${escapeHtml(activation.startedAt)}</option>`,
      )
      .join('');
    $('qso-form').hidden = !open.length;
    $('adif-import-form').hidden = !open.length;
    $('activations-list').replaceChildren(renderActivationHistory(activations));
    $('activation-status').textContent = '';
    if (activeAdifImportId) void refreshAdifImportStatus();
    return true;
  } catch (error) {
    if (request !== activationRequest) return false;
    activations = [];
    $('qso-activation').replaceChildren();
    $('qso-form').hidden = true;
    $('adif-import-form').hidden = true;
    $('activations-list').textContent =
      'Your activation history is temporarily unavailable.';
    $('activation-status').textContent =
      `Use “Refresh programme data” to retry. ${error.message}`;
    return false;
  }
}

function renderActivationHistory(items) {
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'small';
    empty.textContent = 'No activations recorded for this programme yet.';
    return empty;
  }

  const list = document.createElement('ul');
  list.className = 'activation-history';
  for (const activation of items.slice(0, 20)) {
    const id = String(activation.id);
    const detailId = `activation-detail-${id}`;
    const item = document.createElement('li');
    const details = document.createElement('details');
    details.className = 'activation-history-detail';
    details.dataset.activationId = id;

    const summary = document.createElement('summary');
    summary.setAttribute('aria-controls', detailId);
    summary.append(
      document.createTextNode(
        `${activation.operatorCallsign || 'Activation'} · ${activation.status} · ${Number(activation.qsoCount || 0)} QSOs · ${activation.startedAt} `,
      ),
    );
    const hint = document.createElement('span');
    hint.className = 'small';
    hint.textContent = '· View details';
    summary.append(hint);

    const panel = document.createElement('div');
    panel.id = detailId;
    panel.className = 'activation-history-content';
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-live', 'polite');
    panel.textContent = 'Open to load activation and QSO details.';

    details.append(summary, panel);
    details.addEventListener('toggle', () => {
      if (details.open) void loadActivationDetails(details);
    });
    item.append(details);
    list.append(item);
  }
  return list;
}

async function loadActivationDetails(details) {
  if (details.dataset.loaded === 'true') return;
  const activationId = details.dataset.activationId;
  const panel = details.querySelector('.activation-history-content');
  if (!activationId || !panel) return;
  panel.setAttribute('role', 'status');
  panel.textContent = 'Loading activation details…';
  try {
    const activation = await awardApi(
      `/v1/activations/${encodeURIComponent(activationId)}`,
    );
    const qsos = Array.isArray(activation.qsos) ? activation.qsos : [];
    const imports = Array.isArray(activation.imports) ? activation.imports : [];
    const importsById = new Map(imports.map((item) => [item.id, item]));
    const metadata = document.createElement('p');
    metadata.textContent = [
      `Entity type: ${activation.entityType || 'Unavailable'}`,
      `Started: ${activation.startedAt || 'Unavailable'}`,
      ...(activation.endedAt ? [`Ended: ${activation.endedAt}`] : []),
    ].join(' · ');
    const qsoHeading = document.createElement('h4');
    qsoHeading.textContent = `QSOs (${qsos.length})`;
    const qsoList = document.createElement('ul');
    qsoList.className = 'activation-detail-list';
    if (qsos.length) {
      for (const qso of qsos) {
        const item = document.createElement('li');
        const callsign = document.createElement('strong');
        callsign.textContent = qso.workedCallsign || 'Unknown callsign';
        item.append(callsign);
        for (const value of [
          qso.timestamp || '',
          [qso.band, qso.mode].filter(Boolean).join(' · ') ||
            'Band/mode unavailable',
        ]) {
          const line = document.createElement('span');
          line.textContent = value;
          item.append(line);
        }
        const source = importsById.get(qso.sourceImportId);
        const sourceLabel = source
          ? `ADIF · ${source.filename}`
          : qso.source || 'Manual';
        const origin = document.createElement('span');
        origin.textContent = `${sourceLabel} · ${qso.status || 'Unknown status'}`;
        item.append(origin);
        qsoList.append(item);
      }
    } else {
      const empty = document.createElement('li');
      empty.textContent = 'No QSOs have been recorded for this activation.';
      qsoList.append(empty);
    }

    const importHeading = document.createElement('h4');
    importHeading.textContent = 'ADIF imports';
    const importList = document.createElement('ul');
    importList.className = 'activation-detail-list';
    if (imports.length) {
      for (const imported of imports) {
        const item = document.createElement('li');
        const filename = document.createElement('strong');
        filename.textContent = imported.filename || 'ADIF log';
        item.append(filename);
        for (const value of [
          imported.status || 'Unknown status',
          `${Number(imported.recordsAccepted || 0)} accepted · ${Number(imported.recordsRejected || 0)} rejected of ${Number(imported.recordsSeen || 0)} records`,
        ]) {
          const line = document.createElement('span');
          line.textContent = value;
          item.append(line);
        }
        importList.append(item);
      }
    } else {
      const empty = document.createElement('li');
      empty.textContent =
        'No ADIF imports are associated with this activation.';
      importList.append(empty);
    }
    panel.replaceChildren(
      metadata,
      qsoHeading,
      qsoList,
      importHeading,
      importList,
    );
    panel.dataset.loaded = 'true';
    details.dataset.loaded = 'true';
  } catch (error) {
    panel.setAttribute('role', 'alert');
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'secondary';
    retry.textContent = 'Retry activity and QSO details';
    retry.addEventListener('click', () => void loadActivationDetails(details));
    panel.replaceChildren(
      document.createTextNode(
        `Unable to load activation details. ${error.message} `,
      ),
      retry,
    );
  }
}

function renderOperatorCallsigns() {
  const callsigns = awardAccount?.callsigns || [];
  $('activation-callsign').innerHTML = callsigns
    .filter((callsign) => callsign.status !== 'RETIRED')
    .map(
      (callsign) =>
        `<option value="${escapeHtml(callsign.id)}">${escapeHtml(callsign.value)} · ${escapeHtml(callsign.status)}</option>`,
    )
    .join('');
  const primary = callsigns.find(
    (callsign) => callsign.id === awardAccount?.primaryCallsignId,
  );
  if (primary) $('activation-callsign').value = primary.id;
}
async function startActivation(event) {
  event.preventDefault();
  const programme = programmes.find(
    (item) => item.slug === $('programme-select').value,
  );
  const entity = entities.find(
    (item) => item.id === $('activation-entity').value,
  );
  const callsign = (awardAccount?.callsigns || []).find(
    (item) => item.id === $('activation-callsign').value,
  );
  if (!programme || !entity || !callsign) {
    $('activation-status').textContent =
      'Choose an active entity and an account callsign.';
    return;
  }
  const point = entity.centroid || entity.location || {};
  if (
    programme.rules?.requireLocation &&
    (!Number.isFinite(Number(point.lat ?? point.latitude)) ||
      !Number.isFinite(Number(point.lon ?? point.longitude)))
  ) {
    $('activation-status').textContent =
      'This entity does not have a location required by the programme.';
    return;
  }
  $('activation-status').textContent = 'Starting activation…';
  const identity = {
    programmeSlug: programme.slug,
    entityId: entity.id,
    operatorId: awardAccount.id,
    operatorCallsign: callsign.value,
    callsignLifecycleStatus: callsign.status,
    authorizedCallsigns: (awardAccount.callsigns || []).map(
      (item) => item.value,
    ),
    programmeRules: programme.rules,
    location: {
      latitude: point.lat ?? point.latitude ?? null,
      longitude: point.lon ?? point.longitude ?? null,
    },
  };
  const request = pendingParticipantMutation('activation-start', identity, {
    ...identity,
    startedAt: new Date().toISOString(),
  });
  try {
    await awardApi('/v1/activations', {
      method: 'POST',
      headers: { 'Idempotency-Key': request.key },
      body: JSON.stringify(request.body),
    });
    completePendingParticipantMutation(request.id);
    $('activation-status').textContent = 'Activation started.';
    if (await loadActivations())
      $('activation-status').textContent = 'Activation started.';
  } catch (error) {
    $('activation-status').textContent = error.message;
  }
}
async function recordQso(event) {
  event.preventDefault();
  const activationId = $('qso-activation').value;
  const identity = {
    activationId,
    workedCallsign: $('qso-callsign').value,
    band: $('qso-band').value || null,
    mode: $('qso-mode').value || null,
  };
  const request = pendingParticipantMutation('qso-create', identity, {
    workedCallsign: identity.workedCallsign,
    timestamp: new Date().toISOString(),
    band: identity.band,
    mode: identity.mode,
  });
  $('activation-status').textContent = 'Recording contact…';
  try {
    await awardApi(`/v1/activations/${encodeURIComponent(activationId)}/qsos`, {
      method: 'POST',
      headers: { 'Idempotency-Key': request.key },
      body: JSON.stringify(request.body),
    });
    completePendingParticipantMutation(request.id);
    $('qso-callsign').value = '';
    $('activation-status').textContent = 'Contact recorded.';
    if (await loadActivations())
      $('activation-status').textContent = 'Contact recorded.';
  } catch (error) {
    $('activation-status').textContent = error.message;
  }
}
async function closeActivation() {
  const activationId = $('qso-activation').value;
  if (!activationId || !confirm('Close this activation?')) return;
  try {
    await awardApi(`/v1/activations/${encodeURIComponent(activationId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'CLOSED',
        endedAt: new Date().toISOString(),
      }),
    });
    $('activation-status').textContent = 'Activation closed.';
    if (await loadActivations())
      $('activation-status').textContent = 'Activation closed.';
  } catch (error) {
    const refreshed = await loadActivations();
    const activation = refreshed
      ? activations.find((item) => item.id === activationId)
      : null;
    if (activation && activation.status !== 'OPEN') {
      $('activation-status').textContent = 'Activation close was completed.';
    } else {
      $('activation-status').textContent = error.message;
    }
  }
}
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const separator = dataUrl.indexOf(',');
      if (separator < 0) reject(new Error('Could not read the selected file.'));
      else resolve(dataUrl.slice(separator + 1));
    };
    reader.onerror = () =>
      reject(new Error('Could not read the selected file.'));
    reader.readAsDataURL(file);
  });
}
function renderAdifImportStatus(imported) {
  const errors = Array.isArray(imported.errors)
    ? imported.errors.filter((error) => typeof error === 'string' && error)
    : [];
  const errorSummary =
    imported.status === 'FAILED' && errors.length
      ? ` · ${errors[0]}${errors.length > 1 ? ` · ${errors.length - 1} more errors` : ''}`
      : '';
  $('adif-import-status').textContent =
    `${imported.filename}: ${imported.status} · ` +
    `${Number(imported.recordsAccepted || 0)} accepted, ` +
    `${Number(imported.recordsRejected || 0)} rejected${errorSummary}`;
  const terminal = ['COMPLETED', 'FAILED'].includes(imported.status);
  $('adif-refresh').hidden = terminal;
  if (terminal) {
    activeAdifImportId = '';
    sessionStorage.removeItem('myota_active_adif_import');
  }
}
async function refreshAdifImportStatus() {
  if (!activeAdifImportId || adifStatusRequestInFlight) return;
  adifStatusRequestInFlight = true;
  clearTimeout(adifStatusTimer);
  try {
    const imported = await awardApi(
      `/v1/adif/imports/${encodeURIComponent(activeAdifImportId)}`,
    );
    renderAdifImportStatus(imported);
    if (activeAdifImportId)
      adifStatusTimer = setTimeout(refreshAdifImportStatus, 2000);
  } catch (error) {
    $('adif-import-status').textContent = error.message;
    $('adif-refresh').hidden = false;
  } finally {
    adifStatusRequestInFlight = false;
  }
}
async function uploadAdif(event) {
  event.preventDefault();
  const activationId = $('qso-activation').value;
  const file = $('adif-file').files?.[0];
  if (!activationId || !file) {
    $('adif-import-status').textContent =
      'Choose an open activation and an ADIF file.';
    return;
  }
  if (file.size > 25 * 1024 * 1024) {
    $('adif-import-status').textContent =
      'The ADIF file exceeds the 25 MiB upload limit.';
    return;
  }
  const submit = $('adif-import-form').querySelector('button[type="submit"]');
  submit.disabled = true;
  $('adif-import-status').textContent = 'Uploading ADIF log…';
  try {
    const contentBase64 = await readFileAsBase64(file);
    const imported = await awardApi('/v1/adif/imports', {
      method: 'POST',
      body: JSON.stringify({
        activationId,
        filename: file.name,
        contentBase64,
      }),
    });
    activeAdifImportId = imported.id;
    sessionStorage.setItem('myota_active_adif_import', activeAdifImportId);
    $('adif-import-status').textContent = `${file.name}: import queued.`;
    $('adif-refresh').hidden = false;
    await refreshAdifImportStatus();
    $('adif-file').value = '';
  } catch (error) {
    $('adif-import-status').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
}
$('activation-start-form').onsubmit = startActivation;
$('qso-form').onsubmit = recordQso;
$('activation-close').onclick = closeActivation;
$('adif-import-form').onsubmit = uploadAdif;
$('adif-refresh').onclick = refreshAdifImportStatus;
async function signInForAward() {
  if (awardAccount && awardAccessToken) return awardAccount;
  const data = await api('/v1/identity/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: $('award-email').value,
      password: $('award-password').value,
    }),
  });
  awardAccessToken = data.accessToken;
  awardRefreshToken = data.refreshToken;
  localStorage.setItem('myota_public_access', awardAccessToken);
  localStorage.setItem('myota_public_refresh', awardRefreshToken);
  awardAccount = await awardApi('/v1/identity/me');
  renderParticipantSession();
  renderOperatorCallsigns();
  await loadActivations();
  await loadMyAwardRequests();
  return awardAccount;
}
async function requestPublicAward(awardId, levelId) {
  try {
    $('award-status').textContent = 'Checking your progress…';
    const account = await signInForAward();
    const progress = await awardApi(
      `/v1/awards/progress?awardId=${encodeURIComponent(awardId)}&participantId=${encodeURIComponent(account.id)}`,
    );
    const level = (progress.levels || []).find((item) => item.id === levelId);
    if (!level?.eligible)
      throw new Error(
        `This level is not eligible yet. Current progress: ${progress.progress}.`,
      );
    const callsign =
      account.callsigns?.find((item) => item.id === account.primaryCallsignId)
        ?.value ||
      account.callsigns?.[0]?.value ||
      'SWL';
    const request = await awardApi('/v1/awards/requests', {
      method: 'POST',
      body: JSON.stringify({
        awardId,
        levelId,
        subjectId: account.id,
        callsign,
        personName: account.displayName,
      }),
    });
    $('award-request-status').textContent =
      request.status === 'REQUESTED'
        ? 'Award request submitted for programme review.'
        : 'This award level is already requested or issued.';
    await loadMyAwardRequests();
    $('award-status').textContent = '';
  } catch (error) {
    $('award-status').textContent = error.message;
  }
}
$('participant-login').onsubmit = (event) => {
  event.preventDefault();
  $('participant-auth-status').textContent = 'Signing in…';
  signInForAward()
    .then(async () => {
      $('participant-auth-status').textContent = '';
      $('award-request-status').textContent =
        'Choose an eligible award level to request it.';
      await loadProfile();
    })
    .catch((error) => {
      $('participant-auth-status').textContent = error.message;
    });
};
$('participant-register').onsubmit = async (event) => {
  event.preventDefault();
  const button = $('participant-register').querySelector(
    'button[type="submit"]',
  );
  button.disabled = true;
  $('participant-auth-status').textContent = 'Submitting registration…';
  try {
    const result = await api('/v1/identity/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: $('register-display-name').value,
        email: $('register-email').value,
        password: $('register-password').value,
        participationType: $('register-participation-type').value,
      }),
    });
    $('resend-email').value = $('register-email').value;
    $('participant-register').reset();
    $('participant-auth-status').textContent = result.message;
  } catch (error) {
    $('participant-auth-status').textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
$('participant-resend').onsubmit = async (event) => {
  event.preventDefault();
  const button = $('participant-resend').querySelector('button[type="submit"]');
  button.disabled = true;
  $('participant-auth-status').textContent = 'Requesting another email…';
  try {
    const result = await api('/v1/identity/auth/register/resend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('resend-email').value }),
    });
    $('participant-auth-status').textContent = result.message;
  } catch (error) {
    $('participant-auth-status').textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
function preparePasswordResetFromLink() {
  if (!participantPasswordResetToken) return;
  $('participant-recovery-request-details').hidden = true;
  $('participant-recovery-reset').hidden = false;
  $('participant-recovery-status').textContent =
    'Choose a new password to finish resetting your account.';
}

$('participant-recovery-request').onsubmit = async (event) => {
  event.preventDefault();
  const button = $('participant-recovery-request').querySelector(
    'button[type="submit"]',
  );
  button.disabled = true;
  $('participant-recovery-status').textContent = 'Requesting a reset email…';
  try {
    await api('/v1/identity/auth/recovery/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('recovery-email').value }),
    });
    $('participant-recovery-status').textContent =
      'If an account matches that address, a password reset link will be sent by email.';
  } catch {
    $('participant-recovery-status').textContent =
      'We could not submit the request. Please try again later.';
  } finally {
    button.disabled = false;
  }
};

$('participant-recovery-reset').onsubmit = async (event) => {
  event.preventDefault();
  const token = participantPasswordResetToken;
  const button = $('participant-recovery-reset').querySelector(
    'button[type="submit"]',
  );
  if (!token) {
    $('participant-recovery-request-details').hidden = false;
    $('participant-recovery-request-details').open = true;
    $('participant-recovery-reset').hidden = true;
    $('participant-recovery-status').textContent =
      'This reset link is no longer available. Request a new link by email.';
    return;
  }
  button.disabled = true;
  $('participant-recovery-status').textContent = 'Updating your password…';
  try {
    await api('/v1/identity/auth/recovery/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        newPassword: $('recovery-new-password').value,
      }),
    });
    participantPasswordResetToken = '';
    $('participant-recovery-reset').reset();
    $('participant-recovery-reset').hidden = true;
    $('participant-recovery-request-details').hidden = true;
    $('participant-login').hidden = false;
    $('participant-auth-status').textContent =
      'Password updated. Sign in with your new password.';
    $('participant-recovery-status').textContent = '';
  } catch (error) {
    $('participant-recovery-request-details').hidden = false;
    $('participant-recovery-request-details').open = true;
    $('participant-recovery-status').textContent =
      /invalid|expired|token/i.test(error.message)
        ? 'This reset link is invalid or expired. Request a new link by email.'
        : error.message;
  } finally {
    button.disabled = false;
  }
};
preparePasswordResetFromLink();
if (participantEmailChangeToken) {
  const token = participantEmailChangeToken;
  participantEmailChangeToken = '';
  $('participant-email-change-link-status').textContent =
    'Confirming this email address…';
  api('/v1/identity/auth/email-change/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
    .then((result) => {
      $('participant-email-change-link-status').textContent =
        result.status === 'email_changed'
          ? 'Both addresses are verified. Your email address has been changed.'
          : 'This address is confirmed. The email change will finish after the other address is confirmed.';
      if (awardAccessToken) void loadEmailChangeStatus();
    })
    .catch(() => {
      $('participant-email-change-link-status').textContent =
        'This email confirmation link is invalid, expired, or already used. Your current address remains active.';
    });
}
$('participant-signout').onclick = async () => {
  $('participant-auth-status').textContent = 'Signing out…';
  try {
    if (awardRefreshToken)
      await awardApi('/v1/identity/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: awardRefreshToken }),
      });
  } catch {
    // Clear local credentials even when the API is temporarily unavailable.
  }
  clearParticipantSession();
  $('participant-auth-status').textContent = 'You have signed out.';
};

async function verifyRegistrationFromLink() {
  const token = new URLSearchParams(window.location.search).get('token');
  if (!token) return;
  $('participant-auth-status').textContent = 'Verifying your email address…';
  try {
    const result = await api('/v1/identity/auth/register/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    $('participant-auth-status').textContent = result.message;
  } catch (error) {
    $('participant-auth-status').textContent = error.message;
  } finally {
    const url = new URL(window.location.href);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url);
  }
}

let profileCrop = null;
let profileSourceUrl = null;
let profileDisplayUrl = null;
let profileCallsignBusy = false;
const profileCanvas = $('profile-crop-canvas');
const profileContext = profileCanvas.getContext('2d');

async function profileApi(path, options = {}, asBlob = false) {
  const headers = {
    Accept: asBlob ? 'image/webp' : 'application/json',
    ...(options.headers || {}),
  };
  const response = await participantFetch(path, { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      body.message || body.detail || `Request failed (${response.status})`,
    );
  }
  return asBlob ? response.blob() : response.json();
}

function revokeProfileSource() {
  if (profileSourceUrl) URL.revokeObjectURL(profileSourceUrl);
  profileSourceUrl = null;
  profileCrop = null;
}

function showProfileImage(blob) {
  if (profileDisplayUrl) URL.revokeObjectURL(profileDisplayUrl);
  profileDisplayUrl = URL.createObjectURL(blob);
  $('profile-image-current').src = profileDisplayUrl;
  $('profile-image-current').hidden = false;
  $('profile-image-delete').hidden = false;
}

function clearProfileImage() {
  if (profileDisplayUrl) URL.revokeObjectURL(profileDisplayUrl);
  profileDisplayUrl = null;
  $('profile-image-current').removeAttribute('src');
  $('profile-image-current').hidden = true;
  $('profile-image-delete').hidden = true;
}

async function loadProfile() {
  if (!awardAccessToken) {
    $('profile-form').hidden = true;
    $('profile-callsigns').hidden = true;
    $('profile-image-editor').hidden = true;
    $('profile-email-change').hidden = true;
    revokeProfileSource();
    clearProfileImage();
    $('profile-status').textContent = 'Sign in above to manage your profile.';
    renderParticipantSession();
    return;
  }
  try {
    const account = await profileApi('/v1/identity/me');
    awardAccount = account;
    renderParticipantSession();
    renderOperatorCallsigns();
    renderEntities();
    await loadActivations();
    await loadMyAwardRequests();
    $('profile-form').hidden = false;
    $('profile-callsigns').hidden = false;
    renderProfileCallsigns(account);
    $('profile-image-editor').hidden = false;
    $('profile-email-change').hidden = false;
    await loadEmailChangeStatus();
    $('profile-website').value = account.websiteUrl || '';
    $('profile-biography').value = account.biographyMarkdown || '';
    $('profile-biography-preview').innerHTML = profileUtils.renderSafeMarkdown(
      account.biographyMarkdown || '',
    );
    if (account.profileImage) {
      const image = await profileApi('/v1/identity/me/profile-image', {}, true);
      showProfileImage(image);
    } else {
      clearProfileImage();
    }
    $('profile-status').textContent = 'Profile loaded.';
  } catch (error) {
    $('profile-status').textContent = error.message;
    $('profile-form').hidden = true;
    $('profile-callsigns').hidden = true;
    $('profile-image-editor').hidden = true;
    $('profile-email-change').hidden = true;
    revokeProfileSource();
    clearProfileImage();
    if (/401|403|authentication|token/i.test(error.message)) {
      clearParticipantSession();
    }
  }
}

async function loadEmailChangeStatus() {
  try {
    const result = await profileApi('/v1/identity/me/email-change');
    const pending = result.pending;
    $('profile-email-change-status').textContent = pending
      ? `Pending change to ${pending.newEmail}. Current address confirmed: ${pending.oldAddressVerified ? 'yes' : 'no'}; new address confirmed: ${pending.newAddressVerified ? 'yes' : 'no'}. Expires ${new Date(pending.expiresAt).toLocaleString()}.`
      : 'No email change is pending.';
    $('profile-email-change-cancel').hidden = !pending;
    $('profile-email-change-resend').hidden = !pending;
  } catch (error) {
    $('profile-email-change-status').textContent = error.message;
  }
}

function fillCallsignSelect(select, callsigns, prompt) {
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = prompt;
  placeholder.disabled = true;
  placeholder.selected = true;
  select.append(placeholder);
  for (const callsign of callsigns) {
    const option = document.createElement('option');
    option.value = callsign.id;
    option.textContent = `${callsign.value} · ${callsign.status}`;
    select.append(option);
  }
}

function setProfileCallsignControlsDisabled(disabled) {
  $('profile-callsigns')
    .querySelectorAll('button, input, select, textarea')
    .forEach((control) => {
      control.disabled = disabled;
    });
}

async function runProfileCallsignMutation(progress, success, action) {
  if (profileCallsignBusy) return;
  profileCallsignBusy = true;
  setProfileCallsignControlsDisabled(true);
  $('profile-status').textContent = progress;
  try {
    try {
      await action();
    } catch (error) {
      $('profile-status').textContent = error.message;
      return;
    }
    await refreshProfileCallsigns(success);
  } catch (error) {
    const detail =
      error instanceof Error
        ? error.message.replace(/[.!?]+$/, '')
        : String(error);
    $('profile-status').textContent =
      `${success} Profile refresh failed: ${detail}. Reload the profile to confirm the latest state.`;
  } finally {
    profileCallsignBusy = false;
    setProfileCallsignControlsDisabled(false);
  }
}

function renderProfileCallsigns(account) {
  const callsigns = account.callsigns || [];
  const activeCallsigns = callsigns.filter(
    (callsign) => callsign.status !== 'RETIRED',
  );
  const list = $('profile-callsign-list');
  list.replaceChildren();
  if (!callsigns.length) {
    const empty = document.createElement('p');
    empty.className = 'small';
    empty.textContent = 'No callsigns are registered yet.';
    list.append(empty);
  }
  for (const callsign of callsigns) {
    const row = document.createElement('div');
    row.className = 'profile-callsign-row';
    const detail = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = callsign.value;
    const status = document.createElement('span');
    status.className = 'small';
    status.textContent = `${callsign.status}${callsign.id === account.primaryCallsignId ? ' · Primary' : ''}${callsign.verificationSource ? ` · Verified by ${callsign.verificationSource}` : ''}`;
    const validity = document.createElement('span');
    validity.className = 'small';
    validity.textContent = [
      callsign.validFrom ? `Valid from ${callsign.validFrom}` : '',
      callsign.validTo ? `Valid to ${callsign.validTo}` : '',
      `${callsign.evidenceIds?.length || 0} evidence record(s)`,
    ]
      .filter(Boolean)
      .join(' · ');
    detail.append(name, status, validity);
    row.append(detail);
    if (callsign.status !== 'RETIRED') {
      const actions = document.createElement('div');
      actions.className = 'profile-callsign-actions';
      if (callsign.id !== account.primaryCallsignId) {
        const primary = document.createElement('button');
        primary.type = 'button';
        primary.className = 'secondary';
        primary.textContent = 'Make primary';
        primary.addEventListener('click', () =>
          setProfilePrimaryCallsign(callsign),
        );
        actions.append(primary);
      }
      const retire = document.createElement('button');
      retire.type = 'button';
      retire.className = 'secondary';
      retire.textContent = 'Retire';
      retire.addEventListener('click', () =>
        beginProfileCallsignRetirement(callsign),
      );
      actions.append(retire);
      row.append(actions);
    }
    list.append(row);
  }
  $('profile-callsign-evidence').hidden = activeCallsigns.length === 0;
  fillCallsignSelect(
    $('profile-evidence-callsign'),
    activeCallsigns,
    'Choose a callsign',
  );
  fillCallsignSelect(
    $('profile-retire-callsign'),
    activeCallsigns,
    'Choose a callsign',
  );
  updateProfileRetirementReplacement();
  if (profileCallsignBusy) setProfileCallsignControlsDisabled(true);
}

function updateProfileRetirementReplacement() {
  const account = awardAccount;
  const target = $('profile-retire-callsign').value;
  const isPrimary = Boolean(account && target === account.primaryCallsignId);
  const label = $('profile-retire-replacement-label');
  const help = $('profile-retire-help');
  const replacement = $('profile-retire-replacement');
  label.hidden = !isPrimary;
  replacement.required = isPrimary;
  const options = (account?.callsigns || []).filter(
    (callsign) => callsign.id !== target && callsign.status !== 'RETIRED',
  );
  fillCallsignSelect(replacement, options, 'Choose an active callsign');
  help.hidden = !isPrimary || options.length > 0;
  help.textContent =
    'The primary callsign cannot be retired until another active callsign is available.';
}

function beginProfileCallsignRetirement(callsign) {
  $('profile-callsign-retire').hidden = false;
  $('profile-retire-callsign').value = callsign.id;
  $('profile-retire-valid-to').value = '';
  updateProfileRetirementReplacement();
  $('profile-callsign-retire').scrollIntoView({
    behavior: 'smooth',
    block: 'nearest',
  });
}

async function refreshProfileCallsigns(status) {
  const account = await profileApi('/v1/identity/me');
  awardAccount = account;
  renderProfileCallsigns(account);
  renderOperatorCallsigns();
  await loadActivations();
  $('profile-status').textContent = status;
}

async function setProfilePrimaryCallsign(callsign) {
  const requestId = JSON.stringify([awardAccount.id, callsign.id]);
  let idempotencyKey = profilePrimaryCallsignRequestKeys.get(requestId);
  if (!idempotencyKey) {
    idempotencyKey = crypto.randomUUID();
    profilePrimaryCallsignRequestKeys.set(requestId, idempotencyKey);
    persistPendingProfileCallsignMutations();
  }
  await runProfileCallsignMutation(
    'Updating primary callsign…',
    'Primary callsign updated.',
    async () => {
      await profileApi(
        `/v1/identity/accounts/${encodeURIComponent(awardAccount.id)}/primary-callsign`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({ callsignId: callsign.id }),
        },
      );
      profilePrimaryCallsignRequestKeys.delete(requestId);
      persistPendingProfileCallsignMutations();
    },
  );
}

$('profile-callsign-add').onsubmit = async (event) => {
  event.preventDefault();
  const body = { callsign: $('profile-callsign-value').value };
  const validFrom = $('profile-callsign-valid-from').value.trim();
  const validTo = $('profile-callsign-valid-to').value.trim();
  if (validFrom) body.validFrom = validFrom;
  if (validTo) body.validTo = validTo;
  const fingerprint = `${awardAccount.id}:${JSON.stringify(body)}`;
  if (profileCallsignAddRequest?.fingerprint !== fingerprint) {
    profileCallsignAddRequest = {
      fingerprint,
      key: crypto.randomUUID(),
    };
    persistPendingProfileCallsignMutations();
  }
  await runProfileCallsignMutation(
    'Adding callsign…',
    'Callsign added.',
    async () => {
      await profileApi(
        `/v1/identity/accounts/${encodeURIComponent(awardAccount.id)}/callsigns`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': profileCallsignAddRequest.key,
          },
          body: JSON.stringify(body),
        },
      );
      profileCallsignAddRequest = null;
      persistPendingProfileCallsignMutations();
      $('profile-callsign-add').reset();
    },
  );
};

$('profile-callsign-evidence').onsubmit = async (event) => {
  event.preventDefault();
  let metadata;
  const metadataText = $('profile-evidence-metadata').value.trim();
  if (metadataText) {
    try {
      metadata = JSON.parse(metadataText);
      if (
        metadata !== null &&
        (typeof metadata !== 'object' || Array.isArray(metadata))
      )
        throw new Error('Evidence metadata must be a JSON object or null.');
    } catch (error) {
      $('profile-status').textContent =
        error instanceof SyntaxError
          ? 'Evidence metadata must contain valid JSON.'
          : error.message;
      return;
    }
  }
  const body = {
    evidenceType: $('profile-evidence-type').value,
    source: $('profile-evidence-source').value,
    checksum: $('profile-evidence-checksum').value || undefined,
    ...(metadata === undefined ? {} : { metadata }),
  };
  const callsignId = $('profile-evidence-callsign').value;
  await runProfileCallsignMutation(
    'Submitting callsign evidence…',
    'Callsign evidence submitted.',
    async () => {
      await profileApi(
        `/v1/identity/accounts/${encodeURIComponent(awardAccount.id)}/callsigns/${encodeURIComponent(callsignId)}/evidence`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      $('profile-callsign-evidence').reset();
    },
  );
};

$('profile-retire-callsign').addEventListener(
  'change',
  updateProfileRetirementReplacement,
);
$('profile-retire-cancel').onclick = () => {
  $('profile-callsign-retire').hidden = true;
  $('profile-callsign-retire').reset();
  updateProfileRetirementReplacement();
};
$('profile-callsign-retire').onsubmit = async (event) => {
  event.preventDefault();
  const callsignId = $('profile-retire-callsign').value;
  const callsign = (awardAccount?.callsigns || []).find(
    (item) => item.id === callsignId,
  );
  if (!callsign) return;
  if (!window.confirm(`Retire callsign ${callsign.value}?`)) return;
  const body = {};
  if (callsignId === awardAccount.primaryCallsignId) {
    body.newPrimaryCallsignId = $('profile-retire-replacement').value;
  }
  const validTo = $('profile-retire-valid-to').value.trim();
  if (validTo) body.validTo = validTo;
  await runProfileCallsignMutation(
    'Retiring callsign…',
    'Callsign retired.',
    async () => {
      await profileApi(
        `/v1/identity/accounts/${encodeURIComponent(awardAccount.id)}/callsigns/${encodeURIComponent(callsignId)}/retire`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      $('profile-callsign-retire').hidden = true;
      $('profile-callsign-retire').reset();
    },
  );
};

$('profile-biography').addEventListener('input', (event) => {
  $('profile-biography-preview').innerHTML = profileUtils.renderSafeMarkdown(
    event.target.value,
  );
});

$('profile-form').onsubmit = async (event) => {
  event.preventDefault();
  $('profile-status').textContent = 'Saving profile…';
  try {
    await profileApi('/v1/identity/me/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        websiteUrl: $('profile-website').value.trim() || null,
        biographyMarkdown: $('profile-biography').value || null,
      }),
    });
    $('profile-status').textContent = 'Profile saved.';
  } catch (error) {
    $('profile-status').textContent = error.message;
  }
};

$('profile-email-change-form').onsubmit = async (event) => {
  event.preventDefault();
  const form = $('profile-email-change-form');
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  $('profile-email-change-status').textContent = 'Requesting email change…';
  try {
    await profileApi('/v1/identity/me/email-change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPassword: $('email-change-password').value,
        newEmail: $('email-change-new-email').value,
      }),
    });
    form.reset();
    $('profile-email-change-status').textContent =
      'Confirmation emails were requested. Your current address remains active until both links are confirmed.';
    await loadEmailChangeStatus();
  } catch (error) {
    $('profile-email-change-status').textContent = error.message;
  } finally {
    button.disabled = false;
  }
};

$('profile-email-change-cancel').onclick = async () => {
  const button = $('profile-email-change-cancel');
  button.disabled = true;
  try {
    await profileApi('/v1/identity/me/email-change', { method: 'DELETE' });
    await loadEmailChangeStatus();
  } catch (error) {
    $('profile-email-change-status').textContent = error.message;
  } finally {
    button.disabled = false;
  }
};

$('profile-email-change-resend').onclick = async () => {
  const button = $('profile-email-change-resend');
  button.disabled = true;
  $('profile-email-change-status').textContent =
    'Restarting email confirmation…';
  try {
    const result = await profileApi('/v1/identity/me/email-change/resend', {
      method: 'POST',
    });
    await loadEmailChangeStatus();
    if (result.status === 'verification_resent')
      $('profile-email-change-status').textContent =
        'New confirmation emails were requested for both addresses. Earlier links are invalid; confirm both new links. Your current address remains active until then.';
    else
      $('profile-email-change-status').textContent =
        'No pending email change was found.';
  } catch (error) {
    $('profile-email-change-status').textContent = error.message;
  } finally {
    button.disabled = false;
  }
};

function drawProfileCrop() {
  if (!profileCrop) return;
  const size = profileCanvas.width;
  const crop = profileUtils.cropGeometry(
    profileCrop.image.naturalWidth,
    profileCrop.image.naturalHeight,
    size,
    profileCrop.zoom,
    profileCrop.panX,
    profileCrop.panY,
  );
  profileCrop.panX = crop.panX;
  profileCrop.panY = crop.panY;
  profileContext.clearRect(0, 0, size, size);
  profileContext.drawImage(
    profileCrop.image,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
  );
}

$('profile-image-file').onchange = () => {
  const file = $('profile-image-file').files[0];
  if (!file) return;
  revokeProfileSource();
  $('profile-crop-tools').hidden = true;
  const sourceUrl = URL.createObjectURL(file);
  profileSourceUrl = sourceUrl;
  const image = new Image();
  image.onload = () => {
    try {
      profileUtils.validateProfileImage(
        file,
        image.naturalWidth,
        image.naturalHeight,
      );
      profileCrop = { image, zoom: 1, panX: 0, panY: 0 };
      $('profile-crop-zoom').value = '100';
      $('profile-crop-tools').hidden = false;
      drawProfileCrop();
      $('profile-status').textContent =
        'Adjust the crop preview before saving.';
    } catch (error) {
      revokeProfileSource();
      $('profile-image-file').value = '';
      $('profile-status').textContent = error.message;
    }
  };
  image.onerror = () => {
    revokeProfileSource();
    $('profile-status').textContent =
      'The selected image could not be decoded.';
  };
  image.src = sourceUrl;
};

$('profile-crop-zoom').oninput = (event) => {
  if (!profileCrop) return;
  profileCrop.zoom = Number(event.target.value) / 100;
  drawProfileCrop();
};

document.querySelectorAll('[data-crop-pan]').forEach((button) => {
  button.onclick = () => {
    if (!profileCrop) return;
    const offsets = {
      up: [0, -20],
      down: [0, 20],
      left: [-20, 0],
      right: [20, 0],
    };
    const [x, y] = offsets[button.dataset.cropPan];
    profileCrop.panX += x;
    profileCrop.panY += y;
    drawProfileCrop();
  };
});

function canvasBlob(canvas, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error('Could not prepare the profile picture.')),
      'image/webp',
      quality,
    ),
  );
}

$('profile-image-upload').onclick = async () => {
  if (!profileCrop) return;
  $('profile-status').textContent = 'Preparing profile picture…';
  try {
    const output = document.createElement('canvas');
    output.width = 512;
    output.height = 512;
    const context = output.getContext('2d');
    const previewScale = output.width / profileCanvas.width;
    const crop = profileUtils.cropGeometry(
      profileCrop.image.naturalWidth,
      profileCrop.image.naturalHeight,
      output.width,
      profileCrop.zoom,
      profileCrop.panX * previewScale,
      profileCrop.panY * previewScale,
    );
    context.drawImage(
      profileCrop.image,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
    );
    let blob;
    for (const quality of [0.9, 0.8, 0.7, 0.6]) {
      blob = await canvasBlob(output, quality);
      if (blob.size <= 256 * 1024) break;
    }
    if (blob.size > 256 * 1024)
      throw new Error(
        'The normalized picture exceeds 256 KiB. Choose a simpler image.',
      );
    await profileApi('/v1/identity/me/profile-image', {
      method: 'PUT',
      headers: { 'Content-Type': 'image/webp' },
      body: blob,
    });
    revokeProfileSource();
    $('profile-image-file').value = '';
    $('profile-crop-tools').hidden = true;
    showProfileImage(blob);
    $('profile-status').textContent = 'Profile picture saved.';
  } catch (error) {
    $('profile-status').textContent = error.message;
  }
};

$('profile-image-delete').onclick = async () => {
  $('profile-status').textContent = 'Removing profile picture…';
  try {
    await profileApi('/v1/identity/me/profile-image', { method: 'DELETE' });
    clearProfileImage();
    $('profile-status').textContent = 'Profile picture removed.';
  } catch (error) {
    $('profile-status').textContent = error.message;
  }
};

renderParticipantSession();
loadProfile();
void verifyRegistrationFromLink();
