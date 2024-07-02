const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const mysql = require('mysql');
const bcrypt = require('bcrypt');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

// Use the OPENAI_API_KEY from the environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.render('index');
});

app.get('/signup', (req, res) => {
  res.render('signup');
});

app.post('/signup', async (req, res) => {
  const { firstName, lastName, email, password } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  db.query('INSERT INTO users (first_name, last_name, email, password) VALUES (?, ?, ?, ?)', [firstName, lastName, email, hashedPassword], (err, result) => {
    if (err) {
      return res.status(500).send('Error registering new user');
    }
    res.redirect('/login');
  });
});

app.get('/login', (req, res) => {
  res.render('login');
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  db.query('SELECT * FROM users WHERE email = ?', [email], async (err, results) => {
    if (err || results.length === 0 || !(await bcrypt.compare(password, results[0].password))) {
      res.status(401).send('Authentication failed');
    } else {
      res.send('Login successful');
    }
  });
});

app.post('/generate_resume', async (req, res) => {
  const { firstName, lastName, email, phone, education, experience } = req.body;

  if (!firstName || !lastName || !email || !phone || !education || !experience) {
    return res.status(400).send('All fields are required');
  }

  const prompt = `Generate concise bullet points for the following experience: ${experience}`;

  try {
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: prompt }
      ]
    }, {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const experienceDescription = response.data.choices[0].message.content.trim();
    const experiencePoints = experienceDescription.split('\n').map(point => point.trim().replace(/^- /, '').replace(/\.$/, '').trim() + '.').filter(line => line.trim() !== '.');

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
    res.status(500).send('Error generating description');
  }
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
