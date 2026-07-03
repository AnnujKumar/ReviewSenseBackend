// config/redis.js
const { Redis } = require('ioredis');
require('dotenv').config();

// We set maxRetriesPerRequest to null because BullMQ requires it
const redisConnection = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    tls: {
        rejectUnauthorized: false // Required for some Upstash connections
    }
});

redisConnection.on('connect', () => console.log('✅ Connected to Redis Queue'));
redisConnection.on('error', (err) => console.error('❌ Redis Connection Error:', err.message));

module.exports = { redisConnection };