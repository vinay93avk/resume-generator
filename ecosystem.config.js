module.exports = {
    apps: [{
      name: 'resume-generator',
      script: './app.js',
      watch: true,
      env: {
        "NODE_ENV": "development",
        "OPENAI_API_KEY": process.env.OPENAI_API_KEY  // Ensure this line correctly assigns the environment variable
      },
      env_production: {
        "NODE_ENV": "production"
      }
    }]
  };
  