module.exports = {
    apps: [{
      name: 'resume-generator',
      script: './app.js',
      watch: true,
      env: {
        "NODE_ENV": "development",
        "OPENAI_API_KEY": process.env.OPENAI_API_KEY,
        "DB_HOST": process.env.DB_HOST,
        "DB_USER": process.env.DB_USER,
        "DB_PASSWORD": process.env.DB_PASSWORD,
        "DB_NAME": process.env.DB_NAME
      },
      env_production: {
        "NODE_ENV": "production"
      }
    }]
  };
  