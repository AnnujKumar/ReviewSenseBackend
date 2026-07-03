// config/queue.js
const { Queue } = require('bullmq');
const { redisConnection } = require('./redis');

// 1. Ingestion Queue (Heavy, slow - for new app installs)
const ingestionQueue = new Queue('ingestion-queue', { connection: redisConnection });

// 2. Update Queue (Medium - for pushes to main)
const updateQueue = new Queue('update-queue', { connection: redisConnection });

// 3. Review Queue (High priority - for PR reviews)
const reviewQueue = new Queue('review-queue', { 
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 3, // Retry failed reviews up to 3 times
        backoff: { type: 'exponential', delay: 5000 }, // Wait 5s, 25s, etc. before retrying
        removeOnComplete: true, // Keep Redis memory clean
    }
});

module.exports = { ingestionQueue, updateQueue, reviewQueue };