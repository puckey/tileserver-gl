const fs = require('fs');
const retry = require('p-retry');
const pLimit = require('p-limit');
const path = require('path');
const { Curl, curly } = require('node-libcurl');
const mime = require('mime-types');
const sha256File = require('sha256-file');
const pMap = require('p-map');
const speedometer = require('speedometer');

let debugEnabled = false;
const debug = debugEnabled ? console.log : undefined;

const LocationsEndpoints = {
  default: 'https://storage.bunnycdn.com',
  fal: 'https://storage.bunnycdn.com',
  nyc: 'https://ny.storage.bunnycdn.com',
  la: 'https://la.storage.bunnycdn.com',
  sp: 'https://sg.storage.bunnycdn.com',
  syd: 'https://syd.storage.bunnycdn.com'
};

const Bunny = ({ accessKey, storage, location = 'default' }) => {
  const apiLimit = pLimit(10);
  const uploadLimit = pLimit(100);
  const endpointUrl = LocationsEndpoints[location];
  if (!endpointUrl) {
    throw new Error(`Invalid endpoint: ${location}`);
  }
  if (!accessKey) {
    throw new Error('Missing accessKey');
  }
  if (!storage) {
    throw new Error('Missing storage');
  }
  function getUrl(p) {
    return path.join(endpointUrl, storage, p);
  }

  const bunny = {
    list(
      url,
      { includeFiles = true, includeDirectories = true } = {
        files: true,
        directories: true
      }
    ) {
      return retry(
        () =>
          apiLimit(async () => {
            debug?.(`Bunny.list('${url}')`);
            let fullUrl = getUrl(url);
            if (!fullUrl.endsWith('/')) {
              fullUrl += '/';
            }
            const { data, statusCode } = await curly.get(fullUrl, {
              httpHeader: [`AccessKey: ${accessKey}`],
              timeout: 15,
              failOnError: false
            });
            debug?.(
              `Bunny.list('${url}') - ${fullUrl} - ${JSON.stringify(
                { data, statusCode },
                null,
                2
              )}`
            );

            if (statusCode === 200)
              return data?.filter(({ IsDirectory }) =>
                IsDirectory ? includeDirectories : includeFiles
              );
            if (statusCode === 404) return undefined;
            throw new Error(`${fullUrl} – ${data.HttpCode}: ${data.Message}`);
          }),
        { retries: 3 }
      );
    },
    uploadDirectory: (() => {
      async function uploadFiles(
        directory,
        url,
        {
          excludeInvisibleFiles,
          fileExtensions,
          uploadRetry,
          verbose,
          onFileUploaded
        }
      ) {
        let filesUploaded = 0;
        const [localResults, remoteResults] = await Promise.all([
          fs.promises.readdir(directory, {
            withFileTypes: true
          }),
          bunny.list(url, { includeDirectories: false })
        ]);
        let files = localResults
          .filter((dirent) => dirent.isFile())
          .filter(
            (file) =>
              (!fileExtensions ||
                fileExtensions.includes(path.extname(file.name))) &&
              (!excludeInvisibleFiles || file.name[0] !== '.')
          );

        debug?.(
          `uploadFiles ${directory} ${url}: found ${files.length} files, – ${remoteResults.length} remote files`
        );
        // If there are already remote files, compare checksums and only upload
        // new files.
        if (remoteResults) {
          files = await narrowUploadCandidatesByRemoteResults(
            directory,
            files,
            remoteResults
          );
        }

        if (verbose && files.length) {
          console.log(
            `${directory}: adding ${
              files.length
            } files to upload queue including: ${files
              .slice(0, 3)
              .map(({ name }) => `'${name}'`)
              .join(', ')}`
          );
        }
        const uploadP = pMap(
          files,
          async ({ name }) => {
            await retry(
              async () => {
                await bunny.upload(
                  path.join(directory, name),
                  path.join(url, name)
                );
                onFileUploaded();
                filesUploaded++;
              },
              {
                retries: uploadRetry
              }
            );
          },
          { concurrency: 100 }
        );
        if (verbose) {
          uploadP.then(() => {
            if (filesUploaded > 0) {
              console.log(`${directory}: uploaded ${filesUploaded} files`);
            }
          });
        }
        await uploadP;
        return filesUploaded;
      }

      return async (
        directory,
        url,
        {
          uploadRetry = 3,
          directoryUploadConcurrency = 8,
          fileExtensions,
          excludeInvisibleFiles = true,
          progress = false,
          verbose = false
        } = {}
      ) => {
        let subDirectories;
        let uploadCount = 0;
        let subDirectoriesCompleted = 0;
        const uploadsPerSecond = speedometer(60);
        let logIntervalId;
        const onFileUploaded = () => {
          uploadsPerSecond(1);
          uploadCount++;
        };
        let error;
        try {
          if (verbose) console.log(`${directory}: deep listing directories`);
          subDirectories = await deepListDirectories(directory);
          if (progress) {
            logIntervalId = setInterval(() => {
              console.log({
                uploadsPerSecond: Math.floor(uploadsPerSecond()),
                filesUploaded: uploadCount,
                progress: `${subDirectoriesCompleted} of ${
                  subDirectories.length
                } directories (${
                  Math.floor(
                    (subDirectoriesCompleted / subDirectories.length) * 100
                  ) * 0.01
                }%)`
              });
            }, 5000);
          }
          if (verbose)
            console.log(
              `${directory}: found ${subDirectories.length} directories`
            );
          const params = {
            excludeInvisibleFiles,
            fileExtensions,
            uploadRetry,
            verbose,
            onFileUploaded
          };
          await pMap(
            [directory, ...subDirectories],
            async (d) => {
              await uploadFiles(
                d,
                path.join(url, d.slice(directory.length)),
                params
              ),
                subDirectoriesCompleted++;
            },
            { concurrency: directoryUploadConcurrency }
          );
        } catch (err) {
          error = err;
        } finally {
          clearInterval(logIntervalId);
          return { uploadCount, error };
        }
      };
    })(),
    upload(file, url) {
      return uploadLimit(async () => {
        debug?.(`Bunny.upload'(${file}', '${url}')`);
        const contentType = mime.contentType(file);
        const fullUrl = getUrl(url);
        const fileHandle = await fs.promises.open(file, 'r+');
        const curl = new Curl();
        curl.setOpt(Curl.option.UPLOAD, true);
        curl.setOpt(Curl.option.READDATA, fileHandle.fd);
        curl.setOpt(Curl.option.URL, fullUrl);
        curl.setOpt(Curl.option.TIMEOUT, 15);
        const headers = [`AccessKey: ${accessKey}`];
        if (contentType) {
          headers.push(`Content-Type: ${contentType}`);
        }
        curl.setOpt(Curl.option.HTTPHEADER, headers);
        const close = async () => {
          await fileHandle.close();
          curl.close();
        };
        return new Promise((resolve, reject) => {
          curl.on('end', (statusCode, data) => {
            debug?.(
              `Bunny.upload('${file}', '${url}') – end – ${JSON.stringify({
                statusCode,
                data
              })}`
            );

            close();
            if (statusCode > 299) {
              reject(new Error(`${fullUrl} – ${statusCode}: ${data}`));
            } else {
              resolve();
            }
          });

          curl.on('error', function (error, errorCode) {
            debug?.(
              `Bunny.upload('${file}', '${url}') - error ${errorCode}`,
              error
            );
            console.log(error);
            close().then(() => reject(error));
          });

          curl.perform();
        });
      });
    },
    delete(path) {
      return apiLimit(async () => {
        debug?.(`Bunny.delete('${path}')`);
        const fullUrl = getUrl(path);
        try {
          const { data, statusCode } = await curly.delete(fullUrl, {
            httpHeader: [`AccessKey: ${accessKey}`]
          });
          debug?.(
            `Bunny.delete('${path}') – ${JSON.stringify({ data, statusCode })}`
          );
        } catch (error) {
          debug?.(`Bunny.delete('${path}') – error`, error);
          throw new Error(`${fullUrl} – ${data.HttpCode}: ${data.Message}`);
        }
      });
    }
  };
  return bunny;
};

function lookup(array, keyProperty, valueProperty) {
  return array.reduce((lookup, ob) => {
    lookup[ob[keyProperty]] = valueProperty ? ob[valueProperty] : ob;
    return lookup;
  }, {});
}

async function narrowUploadCandidatesByRemoteResults(
  localDirectory,
  files,
  remoteResults
) {
  const remoteFileByName = lookup(remoteResults, 'ObjectName');
  const remoteFileByNameAndChecksum = lookup(
    remoteResults.map((result) => {
      return {
        ...result,
        Checksum: result.ObjectName + result.Checksum
      };
    }),
    'Checksum'
  );
  const result = await pMap(
    files.filter((file) => !remoteFileByName[file.name]),
    async (file) => {
      return [
        file,
        await new Promise((resolve, reject) => {
          sha256File(path.join(localDirectory, file.name), (err, sum) => {
            if (err) {
              reject(err);
            } else {
              resolve(sum.toUpperCase());
            }
          });
        })
      ];
    },
    { concurrency: 4 }
  );
  return result
    .filter(([file, checksum]) => !remoteFileByNameAndChecksum[file + checksum])
    .map(([file]) => file);
}

const util = require('util');
const exec = util.promisify(require('child_process').exec);
async function deepListDirectories(directory) {
  const output = await exec(`find ${directory} -type d`);
  return output.stdout.split('\n').slice(0, -1);
}

module.exports = Bunny;
