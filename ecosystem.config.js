module.exports = {
  apps: [
    {
      name: 'celume-ops_backend',
      script: 'src/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '2G',
      env: {
        NODE_ENV: 'production',
        PORT: 3004,
        ALLOWED_ORIGINS: 'https://ops.conveylabs.ai,https://operation-website-frontend.vercel.app,https://operations.conveylabs.ai,http://localhost:51178',
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 3004,
        ALLOWED_ORIGINS: 'https://ops.conveylabs.ai,https://operation-website-frontend.vercel.app,http://localhost:3000,http://localhost:5173,http://localhost:51178',
      },
      out_file: 'logs/backend-error.logs',
      error_file: 'logs/backend-out.logs',
      merge_logs: true,
      time: true,
    },
  ],
};
