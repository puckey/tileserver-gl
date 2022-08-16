#!/usr/bin/env node

require('dotenv').config();
const server = require('./server');

process.env.UV_THREADPOOL_SIZE = Math.ceil(
  Math.max(4, require('os').cpus().length * 1.5)
);

if (!process.env.TILES_CONFIG) {
  throw new Error('TILES_CONFIG environment variable is not set');
}

server({
  configPath: process.env.TILES_CONFIG
});
