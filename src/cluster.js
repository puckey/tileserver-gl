var cluster = require('cluster');
var os = require('os');
var process = require('process');

const processes = Math.max(1, os.cpus().length - 1);
if (cluster.isMaster) {
  console.log(`Primary pid ${process.pid}`);
  Array.from({ length: processes }).forEach(fork);
  cluster.on('exit', fork);
} else {
  console.log(`Forked pid ${process.pid}`);
  require('./index.js');
}

function fork() {
  const worker = cluster.fork();
  setTimeout(function () {
    console.log(`killing worker after timeout ${worker.process.pid}`);
    worker.kill();
  }, (10 + Math.random() * 10) * 60 * 1000);
  return worker;
}
