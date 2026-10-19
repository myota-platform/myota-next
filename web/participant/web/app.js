const $ = (id) => document.getElementById(id);
const profileUtils = window.MyotaProfileUtils;
let programmes = [];
let entities = [];
let publicAwards = [];
let awardAccount = null;
let awardAccessToken = localStorage.getItem('myota_public_access') || '';
const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ],
  );
async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error((await res.json()).message || res.statusText);
  return res.json();
}
async function awardApi(path, options = {}) {
  const headers = {
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  };
  if (awardAccessToken) headers.Authorization = `Bearer ${awardAccessToken}`;
  const res = await fetch(path, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(
      body.detail || body.message || body.title || res.statusText,
    );
  return body;
}
async function loadProgrammes() {
  programmes = (await api('/v1/programmes')).items;
  $('programme-select').innerHTML = programmes
    .map((p) => `<option value="${p.slug}">${p.name}</option>`)
    .join('');
  $('programme-select').value = location.hash.slice(1) || programmes[0].slug;
  await loadProgramme($('programme-select').value);
}
async function loadProgramme(slug) {
  const programme =
    programmes.find((p) => p.slug === slug) ||
    (await api(`/v1/programmes/${slug}`));
  document.documentElement.style.setProperty(
    '--primary',
    programme.theme.primary,
  );
  document.documentElement.style.setProperty(
    '--accent',
    programme.theme.accent,
  );
  $('programme-name').textContent = programme.name;
  $('programme-description').textContent = programme.description;
  $('rules').innerHTML =
    `<dt>Activation QSOs</dt><dd>${programme.rules.minimumQsos.activation}</dd><dt>Hunter QSOs</dt><dd>${programme.rules.minimumQsos.hunter}</dd><dt>Public access</dt><dd>${programme.rules.publicAccessRequired ? 'Required' : 'Programme-defined'}</dd>`;
  entities = (
    await api(`/v1/geodata/entities?programme=${encodeURIComponent(slug)}`)
  ).items;
  $('entity-count').textContent = entities.length;
  $('loading').textContent = `${entities.length} loaded`;
  renderEntities();
  renderMarkers();
  await loadPublicAwards(slug);
}
function renderEntities() {
  $('entities').innerHTML = entities
    .map(
      (e) =>
        `<tr><td><strong>${e.name}</strong><div class="small">${e.id.slice(0, 8)}…</div></td><td>${e.entityType}</td><td><span class="badge ${e.status.toLowerCase()}">${e.status}</span></td><td>${e.provenance?.adapter || '—'}</td><td>${e.status === 'CANDIDATE' ? `<button data-id="${e.id}" class="propose">Propose</button>` : '<span class="small">Reference active</span>'}</td></tr>`,
    )
    .join('');
  document.querySelectorAll('.propose').forEach(
    (b) =>
      (b.onclick = async () => {
        const entity = entities.find((item) => item.id === b.dataset.id);
        if (!entity) return;
        await api('/v1/geodata/proposals', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
          },
          body: JSON.stringify({
            proposerId: '00000000-0000-4000-8000-000000000001',
            entityTypes: [entity.entityType],
            source: {
              name: 'Public programme proposal',
              license: 'programme-supplied',
            },
            feature: {
              type: 'Feature',
              properties: { name: entity.name },
              geometry: entity.geometry,
            },
          }),
        });
        await loadProgramme($('programme-select').value);
      }),
  );
}
function renderMarkers() {
  $('markers').innerHTML = entities
    .map((e, i) => {
      const c = e.centroid || { lat: 40.41 + i * 0.006, lon: -3.72 + i * 0.01 };
      const left = `${35 + (((c.lon + 3.72) * 1200) % 55)}%`;
      const top = `${30 + (((c.lat - 40.4) * 900) % 45)}%`;
      return `<div class="marker ${e.status.toLowerCase()}" title="${e.name} · ${e.status}" style="left:${left};top:${top}"></div>`;
    })
    .join('');
}
$('programme-select').onchange = async (e) => {
  location.hash = e.target.value;
  await loadProgramme(e.target.value);
};
$('refresh').onclick = () => loadProgramme($('programme-select').value);
loadProgrammes().catch((e) => {
  $('loading').textContent = e.message;
});

let publicMapState = { lat: 37.395, lon: -5.995, zoom: 12 };
function publicWorld(lon, lat, zoom) {
  const size = 256 * 2 ** zoom,
    x = ((Number(lon) + 180) / 360) * size,
    sin = Math.sin((Number(lat) * Math.PI) / 180),
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
    lon = (worldX / center.size) * 360 - 180,
    n = Math.PI - (2 * Math.PI * worldY) / center.size,
    lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lon, lat];
}
function publicTileMap() {
  const map = $('map'),
    width = Math.max(map.clientWidth || 700, 300),
    height = 355,
    center = publicWorld(
      publicMapState.lon,
      publicMapState.lat,
      publicMapState.zoom,
    ),
    surface = document.createElement('div');
  surface.className = 'public-tile-surface';
  map.innerHTML =
    '<div id="public-tile-layer"></div><svg id="public-map-overlay" viewBox="0 0 ' +
    width +
    ' ' +
    height +
    '" aria-label="OpenStreetMap entity map"></svg><div class="public-map-controls"><button type="button" data-public-zoom="in" aria-label="Zoom in">+</button><button type="button" data-public-zoom="out" aria-label="Zoom out">−</button><button type="button" data-public-reset="true" aria-label="Reset map view">⌂</button></div><a class="public-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>';
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
  overlay.innerHTML = entities
    .map((entity) => {
      const geometry = entity.geometry,
        coords =
          geometry?.type === 'Point'
            ? [geometry.coordinates]
            : geometry?.type === 'Polygon'
              ? geometry.coordinates[0] || []
              : geometry?.type === 'MultiPolygon'
                ? geometry.coordinates[0]?.[0] || []
                : [];
      const points = coords.map((coord) => publicProject(coord, width, height));
      if (!points.length) return '';
      const shape =
        geometry.type === 'Point'
          ? `<circle cx="${points[0][0]}" cy="${points[0][1]}" r="8" class="public-entity-point ${entity.status.toLowerCase()}"/>`
          : `<polygon points="${points.map((point) => point.join(',')).join(' ')}" class="public-entity-polygon ${entity.status.toLowerCase()}"/>`;
      return `<g><title>${entity.name} · ${entity.status}</title>${shape}<text x="${points[0][0] + 10}" y="${points[0][1] - 9}" class="public-map-label">${entity.name}</text></g>`;
    })
    .join('');
  document.querySelectorAll('[data-public-zoom]').forEach(
    (button) =>
      (button.onclick = () => {
        publicMapState.zoom = Math.max(
          10,
          Math.min(
            18,
            publicMapState.zoom + (button.dataset.publicZoom === 'in' ? 1 : -1),
          ),
        );
        publicTileMap();
      }),
  );
  $('[data-public-reset]').onclick = () => {
    publicMapState = { lat: 37.395, lon: -5.995, zoom: 12 };
    publicTileMap();
  };
  let drag = null;
  overlay.addEventListener('pointerdown', (event) => {
    drag = { x: event.clientX, y: event.clientY, moved: false };
    overlay.setPointerCapture(event.pointerId);
  });
  overlay.addEventListener('pointermove', (event) => {
    if (!drag) return;
    drag.moved = true;
    layer.style.transform = `translate(${event.clientX - drag.x}px,${event.clientY - drag.y}px)`;
    overlay.style.transform = `translate(${event.clientX - drag.x}px,${event.clientY - drag.y}px)`;
  });
  overlay.addEventListener('pointerup', (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x,
      dy = event.clientY - drag.y;
    if (drag.moved)
      [publicMapState.lon, publicMapState.lat] = publicUnproject(
        width / 2 - dx,
        height / 2 - dy,
        width,
        height,
      );
    publicTileMap();
    drag = null;
  });
  overlay.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      publicMapState.zoom = Math.max(
        10,
        Math.min(18, publicMapState.zoom + (event.deltaY < 0 ? 1 : -1)),
      );
      publicTileMap();
    },
    { passive: false },
  );
}
function renderMarkers() {
  publicTileMap();
}
async function loadPublicAwards(slug) {
  try {
    const data = await awardApi(
      `/v1/awards?programme=${encodeURIComponent(slug)}&pageSize=100`,
    );
    publicAwards = data.items || [];
    renderPublicAwards();
  } catch (error) {
    $('public-awards').innerHTML =
      `<p class="small">Awards are temporarily unavailable.</p>`;
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
  awardAccount = data.account;
  localStorage.setItem('myota_public_access', awardAccessToken);
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
    $('award-status').textContent = '';
  } catch (error) {
    $('award-status').textContent = error.message;
  }
}
$('award-login').onsubmit = (event) => {
  event.preventDefault();
  signInForAward()
    .then(async () => {
      $('award-request-status').textContent =
        'Signed in. Choose an eligible award level to request it.';
      await loadProfile();
    })
    .catch((error) => {
      $('award-status').textContent = error.message;
    });
};

let profileCrop = null;
let profileSourceUrl = null;
let profileDisplayUrl = null;
const profileCanvas = $('profile-crop-canvas');
const profileContext = profileCanvas.getContext('2d');

async function profileApi(path, options = {}, asBlob = false) {
  const headers = {
    Accept: asBlob ? 'image/webp' : 'application/json',
    ...(options.headers || {}),
  };
  if (awardAccessToken) headers.Authorization = `Bearer ${awardAccessToken}`;
  const response = await fetch(path, { ...options, headers });
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
    $('profile-image-editor').hidden = true;
    revokeProfileSource();
    clearProfileImage();
    $('profile-status').textContent = 'Sign in below to manage your profile.';
    return;
  }
  try {
    const account = await profileApi('/v1/identity/me');
    awardAccount = account;
    $('profile-form').hidden = false;
    $('profile-image-editor').hidden = false;
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
    $('profile-image-editor').hidden = true;
    revokeProfileSource();
    clearProfileImage();
    if (/401|403|authentication|token/i.test(error.message)) {
      awardAccessToken = '';
      awardAccount = null;
      localStorage.removeItem('myota_public_access');
    }
  }
}

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

loadProfile();
