const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const axiosRetry = require('axios-retry');

const app = express();
const port = process.env.PORT || 3000;

// Configure Axios to retry failed requests
axiosRetry(axios, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => {
    return error.response ? axiosRetry.isRetryableError(error) : false;
  }
});

app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));

// Hardcoded API Key
const openaiApiKey = "sk-proj-pAWttIBMe1kQ8vcjYu42T3BlbkFJ1AtO9aTcSX3A7CJr27S6";

// Home page route
app.get('/', (req, res) => {
  res.render('index');
});

// Generate resume route
app.post('/generate_resume', async (req, res) => {
  const { firstName, lastName, email, phone, education, experience } = req.body;

  if (!firstName || !lastName || !email || !phone || !education || !experience) {
    return res.status(400).send('All fields are required');
  }

  const prompt = `
    Generate concise bullet points for the following experience:
    ${experience}
    Ensure each bullet point is specific and clear, and avoid using any HTML tags.
  `;

  try {
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: prompt }
      ]
    }, {
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`
      }
    });

    const experienceDescription = response.data.choices[0].message.content.trim();
    const experiencePoints = experienceDescription.split('\n').map(point => point.trim()).join('. ');

    res.render('resume', {
      firstName,
      lastName,
      email,
      phone,
      education,
      experience: experiencePoints
    });
  } catch (error) {
    console.error('Error generating description:', error);
    res.status(500).send(`Error generating description: ${error.message}`);
  }
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
