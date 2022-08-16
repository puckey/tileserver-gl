require('dotenv').config();

const Bunny = require('./bunny');

const missingKeys = ['OUTPUT_DIR', 'BUNNY_KEY', 'BUNNY_STORAGE'].filter(
  (key) => !process.env[key]
);

if (missingKeys.length) {
  throw new Error(`Missing environment variables: ${missingKeys.join(', ')}`);
}

const {
  OUTPUT_DIR: outputDir,
  BUNNY_KEY: bunnyKey,
  BUNNY_STORAGE: bunnyStorage
} = process.env;

const bunny = Bunny({
  storage: bunnyStorage,
  accessKey: bunnyKey
});

(async () => {
  while (true) {
    const { uploadCount, error } = await bunny.uploadDirectory(outputDir, '/', {
      fileExtensions: ['.jpg'],
      progress: true,
      verbose: true
    });
    console.log(`Uploaded ${uploadCount} files`);
    if (error) {
      console.log(`but encountered the following error during upload`, error);
    }
    // Pause for a minutes
    await new Promise((resolve) => setTimeout(resolve, 1 * 60 * 1000));
  }
})();
