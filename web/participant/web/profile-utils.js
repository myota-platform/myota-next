(function exposeProfileUtils(root, factory) {
  const utilities = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = utilities;
  }
  root.MyotaProfileUtils = utilities;
})(globalThis, function createProfileUtils() {
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const MAX_IMAGE_DIMENSION = 4096;

  function escapeHtml(value) {
    return String(value ?? '').replace(
      /[&<>"']/g,
      (character) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[character],
    );
  }

  function safeLink(value) {
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol)) return null;
      if (parsed.username || parsed.password) return null;
      return parsed.href;
    } catch {
      return null;
    }
  }

  function renderSafeMarkdown(markdown) {
    const escaped = escapeHtml(markdown);
    const linked = escaped.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi,
      (match, label, href) => {
        const safe = safeLink(href.replaceAll('&amp;', '&'));
        return safe
          ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`
          : label;
      },
    );
    const inline = linked
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
    return inline
      .split(/\n\s*\n/)
      .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  function validateProfileImage(file, width, height) {
    if (
      !file ||
      !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)
    ) {
      throw new Error('Choose a JPEG, PNG, or WebP image.');
    }
    if (file.size < 1 || file.size > MAX_IMAGE_BYTES) {
      throw new Error('The selected image must be no larger than 5 MiB.');
    }
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > MAX_IMAGE_DIMENSION ||
      height > MAX_IMAGE_DIMENSION
    ) {
      throw new Error(
        'The selected image dimensions must be at most 4,096 × 4,096.',
      );
    }
    return true;
  }

  function cropGeometry(
    imageWidth,
    imageHeight,
    size,
    zoom,
    panX = 0,
    panY = 0,
  ) {
    const scale = Math.max(size / imageWidth, size / imageHeight) * zoom;
    const width = imageWidth * scale;
    const height = imageHeight * scale;
    const overflowX = Math.max(0, (width - size) / 2);
    const overflowY = Math.max(0, (height - size) / 2);
    const boundedPanX = Math.max(-overflowX, Math.min(overflowX, panX));
    const boundedPanY = Math.max(-overflowY, Math.min(overflowY, panY));
    return {
      x: (size - width) / 2 + boundedPanX,
      y: (size - height) / 2 + boundedPanY,
      width,
      height,
      panX: boundedPanX,
      panY: boundedPanY,
    };
  }

  return {
    cropGeometry,
    escapeHtml,
    renderSafeMarkdown,
    safeLink,
    validateProfileImage,
  };
});
