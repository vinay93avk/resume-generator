const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;
const saltRounds = 10;

// Use the OPENAI_API_KEY from the environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not defined');
  process.exit(1);
} else {
  console.log(`Using OPENAI_API_KEY: ${OPENAI_API_KEY}`);
}

app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));

// MySQL connection
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

db.connect(err => {
    if (err) throw err;
    console.log('Connected to the MySQL database.');
});

app.get('/', (req, res) => {
  res.render('index');
});

app.get('/login', (req, res) => {
  res.render('login');
});

app.get('/signup', (req, res) => {
  res.render('signup');
});

app.post('/signup', (req, res) => {
  const { firstName, lastName, email, password, phone } = req.body;
  bcrypt.hash(password, saltRounds, (err, hash) => {
    if (err) throw err;
    const sql = 'INSERT INTO users (username, email, hashed_password, phone) VALUES (?, ?, ?, ?)';
    db.query(sql, [`${firstName} ${lastName}`, email, hash, phone], (err, result) => {
      if (err) throw err;
      res.send('User registered successfully');
    });
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
    const experiencePoints = experienceDescription
      .split('\n')
      .map(point => point.trim().replace(/^- /, '').replace(/\.$/, '').trim() + '.')
      .filter(line => line.trim() !== '.');

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
