const sharp = require('sharp');

/**
 * Cache of response data by sharp output format and color.  Entry for empty
 * string is for unknown or unsupported formats.
 */
const cache = {
  default: Buffer.alloc(0)
};

/**
 * Create an appropriate mbgl response for http errors.
 * @param {string} format The format (a sharp format or 'pbf').
 * @param {number} size The size of the image.
 */
async function createEmptyResponse(format, size = 1) {
  if (!format || format === 'pbf') {
    return { data: cache.default };
  }

  const cached = cache[format];
  if (cached) {
    return { data: cached };
  }
  const data = await sharp({
    create: {
      width: size,
      height: size,
      channels: format !== 'jpeg' ? 4 : 3,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .toFormat(format)
    .toBuffer();
  cache[format] = data;
  return {
    data
  };
}

module.exports = createEmptyResponse;
