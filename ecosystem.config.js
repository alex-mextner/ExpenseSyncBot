module.exports = {
  apps: [
    {
      name: 'expensesyncbot',
      script: 'index.ts',
      interpreter: '/var/www/.bun/bin/bun',
      cwd: '/var/www/ExpenseSyncBot',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: '/var/www/ExpenseSyncBot/logs/error.log',
      out_file: '/var/www/ExpenseSyncBot/logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      time: true,
    },
  ],
};
