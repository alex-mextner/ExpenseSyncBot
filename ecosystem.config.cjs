module.exports = {
  apps: [
    {
      name: 'expensesyncbot',
      script: './start.sh',
      cwd: '/var/www/ExpenseSyncBot',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PATH: `/var/www/.bun/bin:/var/www/.nvm/versions/node/v22.17.0/bin:${process.env.PATH}`,
      },
      error_file: '/var/www/ExpenseSyncBot/logs/error.log',
      out_file: '/var/www/ExpenseSyncBot/logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      time: true,
      // Log rotation is handled globally by the pm2-logrotate module.
      // Install once with `pm2 install pm2-logrotate` and configure via
      // `pm2 set pm2-logrotate:<option> <value>`.
    },
    {
      name: 'bank-sync',
      script: '/var/www/.bun/bin/bun',
      args: '/var/www/ExpenseSyncBot/bank-sync.ts',
      cwd: '/var/www/ExpenseSyncBot',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PATH: `/var/www/.bun/bin:/var/www/.nvm/versions/node/v22.17.0/bin:${process.env.PATH}`,
      },
      error_file: '/var/www/ExpenseSyncBot/logs/bank-sync-error.log',
      out_file: '/var/www/ExpenseSyncBot/logs/bank-sync-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      time: true,
    },
  ],
};
