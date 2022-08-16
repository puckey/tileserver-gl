const pQueue = require('p-queue').default;
const path = require('path');
const sharp = require('sharp');
const SphericalMercator = require('@mapbox/sphericalmercator');
const mbgl = require('@acalcutt/maplibre-gl-native');
const MBTiles = require('@mapbox/mbtiles');
const mkdirp = require('mkdirp');
const createEmptyResponse = require('./empty-response');

mbgl.on('message', (error) => {
  if (['WARNING', 'ERROR'].includes(error.severity)) {
    console.log('mbgl:', error);
  }
});

const queue = new pQueue({ concurrency: 1 });
const mercator = new SphericalMercator();

async function installMapRenderers(app, { style }) {
  const mbTilesByName = {};
  const sourcesByName = {};
  for (const [name, source] of Object.entries(style.sources)) {
    if (source.url?.startsWith('mbtiles:')) {
      let file = source.url.substring('mbtiles://'.length);
      if (/^\{.+\}$/.test(file)) {
        file = file.substr(1, file.length - 2);
      }

      await new Promise((resolve, reject) => {
        const mbTiles = (mbTilesByName[name] = new MBTiles(file, (err) => {
          if (err) reject(err);
          mbTiles.getInfo((err, info) => {
            console.log(info);
            if (err) reject(err);

            Object.assign(source, {
              ...info,
              type: source.type,
              tiles: [
                // meta url which will be detected when requested
                `mbtiles://${name}/{z}/{x}/{y}.${
                  info.format === 'webp' ? 'png' : info.format ?? 'pbf'
                }`
              ],
              schema: undefined,
              url: undefined
            });
            sourcesByName[name] = source;
            resolve();
          });
        }));
      });
    }
  }
  const modified = new Date();
  const renderer = new mbgl.Map({
    mode: 'tile',
    ratio: 1,
    request({ url }, callback) {
      const protocol = url.split(':')[0];
      if (protocol === 'mbtiles') {
        const parts = url.split('/');
        const sourceId = parts[2];
        const source = sourcesByName[sourceId];
        const z = parts[3] | 0;
        const x = parts[4] | 0;
        const y = parts[5].split('.')[0] | 0;

        const isWebP = source.format === 'webp';
        const format = isWebP ? 'png' : source.format;
        mbTilesByName[sourceId].getTile(z, x, y, async (err, data) => {
          if (err) {
            createEmptyResponse(format).then(({ data }) => {
              callback(null, data);
            });
            return;
          }
          // maplibre-gl-native does not support webp on linux:
          if (isWebP) {
            data = await sharp(data)
              .png({
                compressionLevel: 0
              })
              .toBuffer();
          }

          callback(null, {
            modified,
            data
          });
        });
      }
    }
  });
  renderer.load(style);

  app.get(
    `/:z(\\d+)/:x(\\d+)/:y(\\d+):xScale(-[123]x)?.:format([\\w]+)?`,
    async (
      { url, query: { persist = false }, params: { z, x, y, xScale } },
      res
    ) => {
      z = Number(z);
      x = Number(x);
      y = Number(y);
      xScale = xScale ? Number(xScale[1]) : 1;
      const scale = z === 13 ? 1 : z === 12 ? 2 : 3;
      if (
        z < 0 ||
        x < 0 ||
        y < 0 ||
        z > 22 ||
        x >= Math.pow(2, z) ||
        y >= Math.pow(2, z)
      ) {
        res.status(404).send('Out of bounds');
        return;
      }

      // 512 scaled up by scale
      const size = Math.pow(2, 8 + scale);
      const [lat, lon] = mercator.ll(
        [
          ((x + 0.5) / (1 << z)) * (256 << z),
          ((y + 0.5) / (1 << z)) * (256 << z)
        ],
        z
      );

      if (
        Math.abs(lat) > 180 ||
        Math.abs(lon) > 85.06 ||
        lon !== lon ||
        lat !== lat
      ) {
        res.status(404).send('Invalid center');
        return;
      }
      try {
        const data = await queue.add(
          () =>
            new Promise((resolve, reject) => {
              renderer.render(
                {
                  zoom: Math.max(0, z - 1 + scale),
                  center: [lat, lon],
                  bearing: 0,
                  pitch: 0,
                  width: size,
                  height: size
                },
                (err, data) => {
                  if (err) {
                    reject(err);
                  } else {
                    resolve(data);
                  }
                }
              );
            })
        );
        const image = sharp(data, {
          raw: {
            width: size,
            height: size,
            channels: 4
          }
        }).sharpen();
        if (!process.env.OUTPUT_DIR) {
          throw new Error('Missing OUTPUT_DIR env');
        }
        function getFilePath(quality) {
          return `${process.env.OUTPUT_DIR}/${
            url.match(/([0-9]+\/[0-9]+\/[0-9]+)/)[1]
          }${quality ? `-${quality}x` : ''}.jpg`;
        }
        await mkdirp(path.dirname(getFilePath()));
        const scaleThreeFile = getFilePath(3);
        const scaleTwoFile = getFilePath(2);
        const scaleOneFile = getFilePath();

        let scaleOneImage = image.clone().jpeg({ mozjpeg: true, quality: 80 });

        const scaleOneImageInfo = await scaleOneImage.toFile(scaleOneFile);

        // Pump up image quality for low detail imagery like oceans
        const isLowDetailImage = scaleOneImageInfo.size < 5000;
        if (isLowDetailImage) {
          scaleOneImage = image.clone().jpeg({ mozjpeg: true, quality: 90 });
          await scaleOneImage.toFile(scaleOneFile);
        }
        // Since we do not have the resolution to render @2x on level 13,
        // copy over @1x
        let scaleTwoImage;
        if (z === 13) {
          scaleTwoImage = scaleOneImage;
        } else {
          scaleTwoImage = image
            .clone()
            .resize(1024)
            .jpeg({
              mozjpeg: true,
              quality: isLowDetailImage ? 70 : 50
            });
          await scaleTwoImage.toFile(scaleTwoFile);
        }

        // Since we do not have the resolution to render @3x on level 12,
        // copy over @2x instead, on level 13 copy over @1x
        let scaleThreeImage;
        if (z >= 12) {
          scaleThreeImage = scaleOneImage;
        } else {
          scaleThreeImage = image.jpeg({
            mozjpeg: true,
            quality: isLowDetailImage ? 60 : 30
          });
          await scaleThreeImage.toFile(scaleThreeFile);
        }

        if (persist) {
          res.status(200).send('saved');
        } else {
          res
            .set({
              'Content-Type': 'image/jpg'
            })
            .status(200)
            .send(
              await [scaleOneImage, scaleTwoImage, scaleThreeImage][
                xScale - 1
              ].toBuffer()
            );
        }
      } catch (err) {
        console.error(err);
        res.status(500).send(err);
      }
    }
  );
}

module.exports = installMapRenderers;
