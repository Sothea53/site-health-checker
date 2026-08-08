export default {
  apps: [
    {
      name: 'site-health-checker',
      script: 'server.js',
      cwd: import.meta.dirname,
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork', // keep at 1 fork — the SQLite file + in-progress-run guard aren't safe across multiple instances
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        MONGODB_URI: 'mongodb://127.0.0.1:27017/site_health_checker', // override with the URI ServerAvatar gives you
        CRON_SCHEDULE: '0 7 * * *',
        CRON_TIMEZONE: 'Asia/Phnom_Penh',
      },
    },
  ],
};
