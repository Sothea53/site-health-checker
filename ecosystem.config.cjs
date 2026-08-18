module.exports = {
  apps: [
    {
      name: 'site-health-checker',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || 3000,
        MONGODB_URI: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/site_health_checker',
        CRON_SCHEDULE: process.env.CRON_SCHEDULE || '0 7 * * *',
        CRON_TIMEZONE: process.env.CRON_TIMEZONE || 'Asia/Phnom_Penh',
      },
    },
  ],
};
