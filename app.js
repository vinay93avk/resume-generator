const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const mysql = require('mysql');
const bcrypt = require('bcrypt');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Use the OPENAI_API_KEY from the environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not defined');
  process.exit(1);
} else {
  console.log(`Using OPENAI_API_KEY: ${OPENAI_API_KEY}`);
}

// Create a connection to the database
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

db.connect(err => {
  if (err) {
    console.error('Error connecting to the database:', err);
    process.exit(1);
  }
  console.log('Connected to the MySQL database.');
});

app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.render('index');
});

app.get('/login', (req, res) => {
  res.render('login');
});

app.get('/signup', (req, res) => {
  res.render('signup');
});

app.post('/signup', async (req, res) => {
  const { firstName, lastName, email, password, phone } = req.body;

  if (!firstName || !lastName || !email || !password) {
    return res.status(400).send('All fields except phone are required');
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const user = { firstName, lastName, email, password: hashedPassword, phone };

  db.query('INSERT INTO users SET ?', user, (err, results) => {
    if (err) {
      console.error('Error inserting user:', err);
      return res.status(500).send('Error creating user');
    }
    res.redirect('/login');
  });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).send('All fields are required');
  }

  db.query('SELECT * FROM users WHERE email = ?', [email], async (err, results) => {
    if (err) {
      console.error('Error fetching user:', err);
      return res.status(500).send('Error logging in');
    }

    if (results.length === 0) {
      return res.status(400).send('User not found');
    }

    const user = results[0];

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).send('Invalid password');
    }

    res.redirect('/');
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
