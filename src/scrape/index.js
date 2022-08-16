require('dotenv').config();

const { curly } = require('node-libcurl');
const PQueue = require('p-queue').default;
const retry = require('p-retry');
const fs = require('fs');
const mkdirp = require('mkdirp');
const path = require('path');
const speed = require('speedometer')(60);
const servers = process.env.TILE_SERVERS?.split(',');
const serverQueues = servers.map(() => new PQueue({ concurrency: 14 }));
const filesDir = './files';

let totalUrlCount = 89478484;
async function exportUrls() {
  if (fs.existsSync(filesDir)) return;
  let urlCount = 0;
  let fileCount = 0;
  let urls = [];
  await mkdirp(filesDir);
  for (const file of (await fs.promises.readdir(filesDir)).filter((file) =>
    file.endsWith('.json')
  )) {
    console.log(`Removing ${file}`);
    await fs.promises.unlink(path.join(filesDir, file));
  }

  for (let z = 1; z < 14; z++) {
    const count = Math.pow(2, z);
    for (let x = 0; x < count; x++) {
      for (let y = 0; y < count; y++) {
        if (
          z < 0 ||
          x < 0 ||
          y < 0 ||
          z > 22 ||
          x >= Math.pow(2, z) ||
          y >= Math.pow(2, z)
        ) {
          continue;
        }

        urls.push(`${z}/${x}/${y}`);
        urlCount++;
        if (urls.length === 100000) {
          await writeFile(fileCount++, urls);
          urls.length = 0;
        }
      }
    }
  }
  await writeFile(fileCount++, urls);
  totalUrlCount = urlCount;
  console.log({ urlCount });

  function writeFile(count, urls) {
    const file = `${filesDir}/${`${count}`.padStart(4, 0)}.json`;
    console.log(`Adding: ${file}`);
    return fs.promises.writeFile(file, JSON.stringify(urls));
  }
}

async function run() {
  await exportUrls();
  const jsonFiles = (await fs.promises.readdir(filesDir))
    .filter((file) => file.endsWith('.json'))
    .reverse();
  for (const jsonFile of jsonFiles) {
    console.log(`Handling file ${jsonFile}`);
    const urls = JSON.parse(
      await fs.promises.readFile(path.join(filesDir, jsonFile), 'utf-8')
    );
    await addToQueue(urls);
  }
}

let completeCount = 0;
let lastComplete;
async function addToQueue(urls) {
  let urlsLeft = urls.length;

  urls.map((url, index) =>
    serverQueues[index % serverQueues.length].add(async () => {
      try {
        await retry(
          async () => {
            try {
              const { data } = await curly.get(
                `${servers[index % servers.length]}/${url}?persist=1`
              );
              if (data.error) {
                throw new Error(data.error);
              }
              completeCount++;
              speed(1);
              lastComplete = url;
            } catch (err) {
              console.log(url, err);
              throw err;
            }
          },
          {
            retries: 100
          }
        );
        urlsLeft--;
      } catch (error) {
        urlsLeft--;
        console.log(url, error);
      }
    })
  );
  await new Promise((resolve) => {
    const intervalId = setInterval(() => {
      if (urlsLeft === 0) {
        resolve();
        clearInterval(intervalId);
      }
    }, 1000);
  });
}

setInterval(() => {
  console.log({
    completeCount,
    totalCount: totalUrlCount,
    percent: `${Math.floor((completeCount / totalUrlCount) * 10000) * 0.01}%`,
    perSecond: Math.round(speed()),
    perHour: Math.round(speed() * 60 * 60),
    lastComplete,
    hoursLeft:
      Math.round(
        ((totalUrlCount - completeCount) / (speed() * 60) / 60) * 100
      ) / 100
  });
}, 5000);

run();
