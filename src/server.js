const fs = require('fs');
const path = require('path');
const cors = require('cors');
const express = require('express');
const morgan = require('morgan');
const serveTiles = require('./tiles');

module.exports = async ({
  logFormat = process.env.NODE_ENV === 'production' ? 'tiny' : 'dev',
  logFile,
  port = process.env.PORT ?? 8080,
  bind = process.env.BIND,
  configPath
}) => {
  console.log('Starting server');

  const app = express()
    .disable('x-powered-by')
    .use(cors())
    .enable('trust proxy')
    .use(
      morgan(logFormat, {
        stream: logFile
          ? fs.createWriteStream(logFile, { flags: 'a' })
          : process.stdout
      })
    );
  app.listen(port, bind, function () {
    let address = this.address().address;
    if (address.indexOf('::') === 0) {
      address = `[${address}]`;
    }
    console.log(`Listening at http://${address}:${this.address().port}/`);
  });

  await serveTiles(app, require(path.resolve(configPath)));

  console.log('Startup complete');
};
