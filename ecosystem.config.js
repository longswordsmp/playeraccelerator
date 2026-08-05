'use strict';

/**
 * PM2 process configuration for VPS deployments.
 *
 *   npm install -g pm2
 *   pm2 start ecosystem.config.js
 *   pm2 save && pm2 startup     # survive a reboot
 *   pm2 logs player-accelerator
 *
 * A single instance is correct: Discord bots are stateful gateway clients, and
 * running two of the same token causes duplicate event handling. Scale by
 * sharding (see the README), never by cloning the process.
 */

module.exports = {
  apps: [
    {
      name: 'player-accelerator',
      script: 'src/index.js',
      instances: 1,
      exec_mode: 'fork',

      // Restart policy — bounded, so a crash loop cannot spin forever.
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 5000,
      exp_backoff_restart_delay: 200,

      // A leak-driven restart is a safety net, not a strategy; the log line it
      // produces is the signal worth investigating.
      max_memory_restart: '600M',

      // The process handles SIGTERM itself and needs time to drain.
      kill_timeout: 20000,
      wait_ready: false,
      listen_timeout: 10000,

      env: {
        NODE_ENV: 'production',
      },
      env_development: {
        NODE_ENV: 'development',
        LOG_LEVEL: 'debug',
      },

      // The bot writes its own structured logs to ./logs; these capture stdout.
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
